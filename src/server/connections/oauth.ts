import { ConnectionError, type OAuthTokenResponse, type OAuthTransport, type VerifiedAccountIdentity } from "./types.ts";

export type FetchImpl = (url: string | URL, init?: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 64 * 1024;

// Only known structural codes may reach caller-visible errors. Provider
// strings (including its `error` field) are untrusted and can contain secrets.
const OAUTH_ERROR_CODES = new Set([
  "invalid_request", "invalid_client", "invalid_grant", "unauthorized_client",
  "unsupported_grant_type", "invalid_scope", "access_denied", "server_error",
  "temporarily_unavailable", "interaction_required", "login_required",
  "consent_required", "invalid_token", "insufficient_scope",
]);

async function readObject(response: Response, signal: AbortSignal, maxBytes: number, label: string): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new ConnectionError("EXCHANGE_FAILED", `${label} response was empty`);
  const cancel = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) {
        cancel();
        throw new ConnectionError("EXCHANGE_FAILED", `${label} response exceeded the size bound`);
      }
      chunks.push(part.value);
    }
    let value: unknown;
    const malformedOptions = { retryable: response.status === 429 || response.status >= 500 };
    try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new ConnectionError("EXCHANGE_FAILED", `${label} response was not valid JSON`, malformedOptions); }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new ConnectionError("EXCHANGE_FAILED", `${label} response was not a JSON object`, malformedOptions);
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ConnectionError) throw error;
    cancel();
    throw new ConnectionError("EXCHANGE_FAILED", `${label} response failed (network or timeout)`, { retryable: true });
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/**
 * Fetch-backed OAuth transport — the production adapter behind the injected
 * OAuthTransport port. Requests are bounded (timeout + response size), the
 * fetch implementation is injectable for tests, and provider errors surface
 * only as structural codes (never description text, which may carry
 * sensitive material). All verification uses a scripted transport or an
 * injected fetch — nothing here runs live during tests.
 */
export class FetchOAuthTransport implements OAuthTransport {
  private readonly fetchImpl: FetchImpl;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(opts: { fetchImpl?: FetchImpl; timeoutMs?: number; maxBytes?: number } = {}) {
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  private async postForm(url: string, params: Record<string, string | undefined>): Promise<Record<string, unknown>> {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) body.set(key, value);
    }
    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: body.toString(),
        signal,
      });
    } catch {
      throw new ConnectionError("EXCHANGE_FAILED", "Token endpoint request failed (network or timeout)", {
        retryable: true,
      });
    }
    const json = await readObject(response, signal, this.maxBytes, "Token endpoint");
    if (!response.ok) {
      const providerError = typeof json.error === "string" && OAUTH_ERROR_CODES.has(json.error) ? json.error : `http_${response.status}`;
      throw new ConnectionError("EXCHANGE_FAILED", `Token endpoint rejected the request (${providerError})`, {
        providerError,
        retryable: providerError !== "invalid_grant" && providerError !== "unauthorized_client",
      });
    }
    return json;
  }

  private toTokenResponse(json: Record<string, unknown>): OAuthTokenResponse {
    const accessToken = json.access_token;
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw new ConnectionError("EXCHANGE_FAILED", "Token endpoint returned no access token");
    }
    if (json.expires_in !== undefined && (typeof json.expires_in !== "number" || !Number.isFinite(json.expires_in) || json.expires_in <= 0)) {
      throw new ConnectionError("EXCHANGE_FAILED", "Token endpoint returned an invalid expiry");
    }
    return {
      accessToken,
      refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : undefined,
      expiresInSec: typeof json.expires_in === "number" ? json.expires_in : undefined,
      scope: typeof json.scope === "string" ? json.scope : "",
    };
  }

  async exchangeCode(input: Parameters<OAuthTransport["exchangeCode"]>[0]): Promise<OAuthTokenResponse> {
    const json = await this.postForm(input.tokenEndpoint, {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code_verifier: input.codeVerifier,
    });
    return this.toTokenResponse(json);
  }

  async refresh(input: Parameters<OAuthTransport["refresh"]>[0]): Promise<OAuthTokenResponse> {
    const json = await this.postForm(input.tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      client_secret: input.clientSecret,
    });
    return this.toTokenResponse(json);
  }

  async fetchAccountIdentity(input: {
    userinfoEndpoint: string;
    accessToken: string;
  }): Promise<VerifiedAccountIdentity> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(input.userinfoEndpoint, {
        headers: { authorization: `Bearer ${input.accessToken}`, accept: "application/json" },
        signal,
      });
    } catch {
      throw new ConnectionError("EXCHANGE_FAILED", "Account identity request failed (network or timeout)", {
        retryable: true,
      });
    }
    const json = await readObject(response, signal, this.maxBytes, "Account identity");
    if (!response.ok) {
      throw new ConnectionError("EXCHANGE_FAILED", `Account identity lookup failed (HTTP ${response.status})`);
    }
    const sub = typeof json.sub === "string" ? json.sub : undefined;
    if (!sub) throw new ConnectionError("EXCHANGE_FAILED", "Account identity response had no stable sub");
    const name = typeof json.name === "string" && json.name.trim() ? json.name : undefined;
    const email = typeof json.email === "string" && json.email.trim() ? json.email : undefined;
    return { accountKey: sub, displayName: name ?? email ?? sub };
  }

  async revokeToken(input: { revokeEndpoint: string; token: string; clientId: string }): Promise<void> {
    try {
      await this.fetchImpl(input.revokeEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: input.token, client_id: input.clientId }).toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Best-effort by contract; callers swallow.
    }
  }
}
