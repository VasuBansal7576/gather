import { ConnectionError, type OAuthTokenResponse, type OAuthTransport, type VerifiedAccountIdentity } from "./types.ts";

export type FetchImpl = (url: string | URL, init?: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 64 * 1024;

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
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: body.toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new ConnectionError("EXCHANGE_FAILED", "Token endpoint request failed (network or timeout)", {
        retryable: true,
      });
    }
    const text = await response.text();
    if (text.length > this.maxBytes) {
      throw new ConnectionError("EXCHANGE_FAILED", "Token endpoint response exceeded the size bound");
    }
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = {};
    }
    if (!response.ok) {
      const providerError = typeof json.error === "string" ? json.error : `http_${response.status}`;
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
    let response: Response;
    try {
      response = await this.fetchImpl(input.userinfoEndpoint, {
        headers: { authorization: `Bearer ${input.accessToken}`, accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new ConnectionError("EXCHANGE_FAILED", "Account identity request failed (network or timeout)", {
        retryable: true,
      });
    }
    const text = await response.text();
    if (text.length > this.maxBytes) {
      throw new ConnectionError("EXCHANGE_FAILED", "Account identity response exceeded the size bound");
    }
    if (!response.ok) {
      throw new ConnectionError("EXCHANGE_FAILED", `Account identity lookup failed (HTTP ${response.status})`);
    }
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new ConnectionError("EXCHANGE_FAILED", "Account identity response was not valid JSON");
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
