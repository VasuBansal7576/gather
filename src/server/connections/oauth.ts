import { ConnectionError, type OAuthTokenResponse, type OAuthTransport, type VerifiedAccountIdentity } from "./types.ts";

/**
 * Fetch-backed OAuth transport — the production adapter behind the injected
 * OAuthTransport port. It performs plain HTTPS form posts; all tests use a
 * scripted transport instead, so nothing here runs during verification.
 */
export class FetchOAuthTransport implements OAuthTransport {
  private async postForm(url: string, params: Record<string, string | undefined>): Promise<Record<string, unknown>> {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) body.set(key, value);
    }
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
    });
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const code = typeof json.error === "string" ? json.error : `HTTP ${response.status}`;
      throw new ConnectionError("EXCHANGE_FAILED", `Token endpoint rejected the request (${code})`);
    }
    return json;
  }

  private toTokenResponse(json: Record<string, unknown>): OAuthTokenResponse {
    const accessToken = json.access_token;
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw new ConnectionError("EXCHANGE_FAILED", "Token endpoint returned no access token");
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
    const response = await fetch(input.userinfoEndpoint, {
      headers: { authorization: `Bearer ${input.accessToken}`, accept: "application/json" },
    });
    if (!response.ok) {
      throw new ConnectionError("EXCHANGE_FAILED", `Account identity lookup failed (HTTP ${response.status})`);
    }
    const json = (await response.json()) as Record<string, unknown>;
    const sub = typeof json.sub === "string" ? json.sub : undefined;
    if (!sub) throw new ConnectionError("EXCHANGE_FAILED", "Account identity response had no stable sub");
    const name = typeof json.name === "string" && json.name.trim() ? json.name : undefined;
    const email = typeof json.email === "string" && json.email.trim() ? json.email : undefined;
    return { accountKey: sub, displayName: name ?? email ?? sub };
  }

  async revokeToken(input: { revokeEndpoint: string; token: string; clientId: string }): Promise<void> {
    await fetch(input.revokeEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: input.token, client_id: input.clientId }).toString(),
    });
  }
}
