import type {
  ConnectorResult,
  DocumentRecord,
  DocumentRetriever,
  OperationRequest,
  RetrieveDocumentRequest,
  RetrieveDocumentResponse,
  SourceReference,
} from "../contracts.ts";
import {
  asString,
  invalidRequest,
  isRecord,
  mapGoogleHttpError,
  safeParseJson,
  transportError,
} from "./errors.ts";
import {
  DRIVE_BASE_URL,
  TokenUnavailableError,
  TransportBodyTooLargeError,
  TransportNetworkError,
  TransportTimeoutError,
  liveMetadata,
  withQuery,
  type GoogleAdapterOptions,
  type GoogleHttpResponse,
  authorized,
} from "./transport.ts";

/** Picker output is an allowlist, not a search scope: only these ids may be read. */
export interface SelectedGoogleDocument {
  documentId: string;
  name?: string;
  mimeType?: string;
}

export const GOOGLE_SELECTED_DOCUMENT_SCOPE = "https://www.googleapis.com/auth/drive.file" as const;

export function validateSelectedGoogleDocuments(documents: readonly SelectedGoogleDocument[], max = 100): SelectedGoogleDocument[] {
  if (!Number.isInteger(max) || max < 1 || documents.length > max) throw new Error("Picker selection exceeds the configured document limit");
  const seen = new Set<string>();
  return documents.map((document) => {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(document.documentId) || seen.has(document.documentId)) throw new Error("Picker returned an invalid or duplicate document id");
    seen.add(document.documentId);
    return { documentId: document.documentId, ...(document.name === undefined ? {} : { name: document.name }), ...(document.mimeType === undefined ? {} : { mimeType: document.mimeType }) };
  });
}

/**
 * Explicit-ID Google Drive/Docs retrieval (no account scan).
 *
 * Verified against the primary docs (Drive `files.get` / `files.export`
 * references, "Download and export files" guide):
 * - `GET /drive/v3/files/{fileId}?fields=…` returns metadata; only files
 *   stored in Drive download via `alt=media`, while Google Workspace
 *   documents (Docs/Sheets/Slides) require `files.export` with an export
 *   MIME type (exports capped at 10 MB provider-side).
 * - `capabilities/canDownload` is checked before any content fetch.
 * - There is deliberately no `files.list` call anywhere in this file:
 *   retrieval is addressed solely by caller-approved explicit IDs.
 * - Provider content is evidence, not authority: receipts label the source
 *   as LIVE provider content and downstream mapping must record business
 *   facts at reduced confidence, never as verified authority.
 */

const WORKSPACE_EXPORT_MIME: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

const TEXT_BLOB_PREFIXES = ["text/", "application/json", "application/xml", "application/csv"];

/** Client-side byte bound for any single retrieval (exports cap at 10 MB provider-side). */
export const DEFAULT_DOCUMENT_BYTE_CAP = 2 * 1024 * 1024;

export interface GoogleDocumentsOptions extends GoogleAdapterOptions {
  /** Maximum accepted content bytes; larger results fail closed (default 2 MiB). */
  byteCap?: number;
}

interface FileMetadata {
  id: string;
  name?: string;
  mimeType?: string;
  canDownload?: boolean;
  /** Provider revision marker (Drive `version` field) — source versioning. */
  version?: string;
  modifiedTime?: string;
}

function parseMetadata(body: unknown): FileMetadata | undefined {
  if (!isRecord(body)) return undefined;
  const id = asString(body.id);
  if (id === undefined) return undefined;
  const meta: FileMetadata = { id };
  const name = asString(body.name);
  const mimeType = asString(body.mimeType);
  if (name !== undefined) meta.name = name;
  if (mimeType !== undefined) meta.mimeType = mimeType;
  const version = asString(body.version);
  const modifiedTime = asString(body.modifiedTime);
  if (version !== undefined) meta.version = version;
  if (modifiedTime !== undefined) meta.modifiedTime = modifiedTime;
  if (isRecord(body.capabilities)) {
    const canDownload = body.capabilities.canDownload;
    if (typeof canDownload === "boolean") meta.canDownload = canDownload;
  }
  return meta;
}

/**
 * Provider metadata for one owner-selected document: the source pipeline's
 * cheap change-detection read (`version`/`modifiedTime`) before any content
 * fetch. Same explicit-ID contract as retrieval — never a Drive scan.
 */
export interface DocumentMetadata {
  documentId: string;
  name?: string;
  mimeType?: string;
  canDownload?: boolean;
  version?: string;
  modifiedTime?: string;
}

export interface ReadDocumentMetadataRequest extends OperationRequest {
  documentId: string;
}

export interface ReadDocumentMetadataResponse {
  document: DocumentMetadata;
  provenance: SourceReference[];
}

function tokenFailure(operationKey: string): ConnectorResult<never> {
  return {
    status: "failed",
    metadata: liveMetadata(operationKey, []),
    error: { kind: "access_revoked", message: "No approved Google access token is available (live gate BLOCKED until onboarding provides account assets)", retryable: false },
  };
}

export class GoogleDocumentRetriever implements DocumentRetriever {
  private readonly options: GoogleDocumentsOptions;

  constructor(options: GoogleDocumentsOptions) {
    this.options = options;
  }

  private byteCap(): number {
    const cap = this.options.byteCap ?? DEFAULT_DOCUMENT_BYTE_CAP;
    return Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_DOCUMENT_BYTE_CAP;
  }

  private driveSource(documentId: string): SourceReference {
    return {
      kind: "document",
      locator: `google-drive://file/${documentId}`,
      label: "LIVE Google Drive content (provider evidence, not verified authority)",
      fictional: false,
    };
  }

  /**
   * Shared metadata fetch (single files.get call): fields include the
   * provider `version`/`modifiedTime` markers the source pipeline uses for
   * change detection and source-version records.
   */
  private async fetchFileMetadata(
    operationKey: string,
    fileId: string,
  ): Promise<{ ok: true; meta: FileMetadata } | { ok: false; result: ConnectorResult<never> }> {
    try {
      const metaResponse = await authorized(this.options, {
        method: "GET",
        url: withQuery(`${DRIVE_BASE_URL}/drive/v3/files/${encodeURIComponent(fileId)}`, {
          fields: "id,name,mimeType,capabilities/canDownload,version,modifiedTime",
          supportsAllDrives: "true",
        }),
      });
      if (metaResponse.status !== 200) {
        const error = mapGoogleHttpError(metaResponse.status, safeParseJson(metaResponse.text), "retrieveDocument");
        return { ok: false, result: { status: "failed", metadata: liveMetadata(operationKey, []), error } };
      }
      const parsed = parseMetadata(safeParseJson(metaResponse.text));
      if (parsed === undefined) {
        return {
          ok: false,
          result: { status: "failed", metadata: liveMetadata(operationKey, []), error: transportError("Drive files.get returned an unrecognized metadata shape") },
        };
      }
      return { ok: true, meta: parsed };
    } catch (error) {
      if (error instanceof TokenUnavailableError) return { ok: false, result: tokenFailure(operationKey) };
      if (error instanceof TransportBodyTooLargeError) {
        return { ok: false, result: { status: "failed", metadata: liveMetadata(operationKey, []), error: transportError(`Drive metadata exceeds the ${error.limitBytes}-byte retrieval bound; request a narrower document instead of a truncated one`) } };
      }
      if (error instanceof TransportTimeoutError || error instanceof TransportNetworkError) {
        return { ok: false, result: { status: "failed", metadata: liveMetadata(operationKey, []), error: transportError("Drive metadata read timed out; no write was attempted so retry is safe") } };
      }
      throw error;
    }
  }

  /**
   * Metadata-only read for change detection/deletion checks (read path).
   * A 404 here is the provider's deletion signal for the scan pipeline.
   */
  async readDocumentMetadata(request: ReadDocumentMetadataRequest): Promise<ConnectorResult<ReadDocumentMetadataResponse>> {
    if (request.operationKey.trim().length === 0 || request.documentId.trim().length === 0) {
      return {
        status: "failed",
        metadata: liveMetadata(request.operationKey, []),
        error: invalidRequest("operationKey and an explicit documentId are required"),
      };
    }
    const fetched = await this.fetchFileMetadata(request.operationKey, request.documentId);
    if (!fetched.ok) return fetched.result;
    const meta = fetched.meta;
    const provenance = [this.driveSource(meta.id)];
    const document: DocumentMetadata = {
      documentId: meta.id,
      ...(meta.name === undefined ? {} : { name: meta.name }),
      ...(meta.mimeType === undefined ? {} : { mimeType: meta.mimeType }),
      ...(meta.canDownload === undefined ? {} : { canDownload: meta.canDownload }),
      ...(meta.version === undefined ? {} : { version: meta.version }),
      ...(meta.modifiedTime === undefined ? {} : { modifiedTime: meta.modifiedTime }),
    };
    return { status: "succeeded", metadata: liveMetadata(request.operationKey, provenance), data: { document, provenance } };
  }

  async retrieveDocument(request: RetrieveDocumentRequest): Promise<ConnectorResult<RetrieveDocumentResponse>> {
    if (request.operationKey.trim().length === 0 || request.documentId.trim().length === 0) {
      return {
        status: "failed",
        metadata: liveMetadata(request.operationKey, []),
        error: invalidRequest("operationKey and an explicit documentId are required"),
      };
    }
    const fileId = request.documentId;
    const fetched = await this.fetchFileMetadata(request.operationKey, fileId);
    if (!fetched.ok) return fetched.result;
    const meta = fetched.meta;
    if (meta.canDownload === false) {
      return {
        status: "failed",
        metadata: liveMetadata(request.operationKey, []),
        error: { kind: "authorization_denied", message: "The account may see this file but cannot download it", retryable: false },
      };
    }
    const exportMime = meta.mimeType !== undefined ? WORKSPACE_EXPORT_MIME[meta.mimeType] : undefined;
    try {
      if (exportMime !== undefined) {
        return await this.exportWorkspaceDocument(request, fileId, meta, exportMime);
      }
      if (meta.mimeType !== undefined && TEXT_BLOB_PREFIXES.some((prefix) => meta.mimeType?.startsWith(prefix) === true)) {
        return await this.downloadBlob(request, fileId, meta);
      }
      return {
        status: "failed",
        metadata: liveMetadata(request.operationKey, []),
        error: {
          kind: "unsupported",
          message: `MIME type "${meta.mimeType ?? "unknown"}" is not retrievable as text; binary content is never decoded as text`,
          retryable: false,
        },
      };
    } catch (error) {
      if (error instanceof TokenUnavailableError) return tokenFailure(request.operationKey);
      if (error instanceof TransportBodyTooLargeError) {
        return { status: "failed", metadata: liveMetadata(request.operationKey, []), error: transportError(`Drive content exceeds the ${error.limitBytes}-byte retrieval bound; request a narrower document instead of a truncated one`) };
      }
      if (error instanceof TransportTimeoutError || error instanceof TransportNetworkError) {
        return { status: "failed", metadata: liveMetadata(request.operationKey, []), error: transportError("Drive content read timed out; no write was attempted so retry is safe") };
      }
      throw error;
    }
  }

  private async exportWorkspaceDocument(
    request: RetrieveDocumentRequest,
    fileId: string,
    meta: FileMetadata,
    exportMime: string,
  ): Promise<ConnectorResult<RetrieveDocumentResponse>> {
    const response = await authorized(this.options, {
      method: "GET",
      url: withQuery(`${DRIVE_BASE_URL}/drive/v3/files/${encodeURIComponent(fileId)}/export`, { mimeType: exportMime }),
    });
    if (response.status !== 200) {
      const error = mapGoogleHttpError(response.status, safeParseJson(response.text), "retrieveDocument");
      if (response.status === 400) {
        return {
          status: "failed",
          metadata: liveMetadata(request.operationKey, []),
          error: { kind: "unsupported", message: "Drive cannot export this document to a text representation", retryable: false },
        };
      }
      return { status: "failed", metadata: liveMetadata(request.operationKey, []), error };
    }
    return this.toRecord(request, meta, exportMime, response.text);
  }

  private async downloadBlob(
    request: RetrieveDocumentRequest,
    fileId: string,
    meta: FileMetadata,
  ): Promise<ConnectorResult<RetrieveDocumentResponse>> {
    // Range-capped: the Range header asks for bytes 0..cap-1. A 206 is a
    // COMPLETE body only when Content-Range proves it — `bytes 0-(total-1)/total`
    // with the total inside the cap, the declared span matching the actual
    // body bytes, and Content-Length (when present) agreeing. Some providers
    // honor Range even for in-bounds files, so a fully-covered 206 must be
    // accepted; every other 206 — partial span, unknown total, malformed or
    // missing header, truncated body — still fails closed.
    const cap = this.byteCap();
    const response = await authorized(this.options, {
      method: "GET",
      url: `${DRIVE_BASE_URL}/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
      headers: { Range: `bytes=0-${cap - 1}` },
    });
    if (response.status === 206) {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers["content-range"] ?? "");
      const start = range ? Number(range[1]) : NaN;
      const end = range ? Number(range[2]) : NaN;
      const total = range ? Number(range[3]) : NaN;
      const declared = end - start + 1;
      const actual = Buffer.byteLength(response.text, "utf-8");
      const contentLength = response.headers["content-length"];
      const complete =
        start === 0 && Number.isSafeInteger(total) && total > 0 && total <= cap &&
        end === total - 1 && declared === actual &&
        (contentLength === undefined || Number(contentLength) === declared);
      if (!complete) {
        return {
          status: "failed",
          metadata: liveMetadata(request.operationKey, []),
          error: transportError(`Drive file exceeds the ${cap}-byte retrieval bound or returned an incomplete range; request a narrower document instead of a truncated one`),
        };
      }
      return this.toRecord(request, meta, meta.mimeType ?? "text/plain", response.text);
    }
    if (response.status !== 200) {
      const error = mapGoogleHttpError(response.status, safeParseJson(response.text), "retrieveDocument");
      return { status: "failed", metadata: liveMetadata(request.operationKey, []), error };
    }
    // Byte-exact accounting: UTF-16 length understates multibyte bodies, so
    // the bound is enforced on encoded bytes and bodies are never sliced
    // mid-code-point (over-cap fails closed instead of truncating).
    if (Buffer.byteLength(response.text, "utf-8") > cap) {
      return {
        status: "failed",
        metadata: liveMetadata(request.operationKey, []),
        error: transportError(`Drive file exceeds the ${cap}-byte retrieval bound; request a narrower document instead of a truncated one`),
      };
    }
    return this.toRecord(request, meta, meta.mimeType ?? "text/plain", response.text);
  }

  private toRecord(
    request: RetrieveDocumentRequest,
    meta: FileMetadata,
    mimeType: string,
    text: string,
  ): ConnectorResult<RetrieveDocumentResponse> {
    if (Buffer.byteLength(text, "utf-8") > this.byteCap()) {
      return {
        status: "failed",
        metadata: liveMetadata(request.operationKey, []),
        error: transportError(`Drive content exceeds the ${this.byteCap()}-byte retrieval bound; request a narrower document instead of a truncated one`),
      };
    }
    const provenance = [this.driveSource(meta.id)];
    const document: DocumentRecord = {
      documentId: meta.id,
      title: meta.name ?? meta.id,
      mimeType,
      text,
      sourceReferences: provenance,
    };
    return { status: "succeeded", metadata: liveMetadata(request.operationKey, provenance), data: { document, provenance } };
  }
}
