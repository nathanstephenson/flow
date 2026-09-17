import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Tiny standards-compliant OpenID Provider used by the transport tests and manual deployment demo.
 * It implements discovery, Authorization Code + S256 PKCE, confidential client authentication,
 * signed ID/logout tokens, refresh-token rotation, and deterministic trusted-user claims.
 */
export async function startTestIssuer(options: {
  clientId?: string;
  clientSecret?: string;
  subject?: string;
  providerSid?: string;
  expiresIn?: number;
  clientAuthentication?: "client_secret_basic" | "client_secret_post";
} = {}): Promise<TestIssuer> {
  const clientId = options.clientId ?? "flow-test";
  const clientSecret = options.clientSecret ?? "flow-test-secret";
  const subject = options.subject ?? "trusted-person";
  const providerSid = options.providerSid ?? "provider-session";
  const expiresIn = options.expiresIn ?? 3600;
  const clientAuthentication = options.clientAuthentication ?? "client_secret_basic";
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
  publicJwk.kid = "test-key";
  publicJwk.use = "sig";
  publicJwk.alg = "RS256";

  const codes = new Map<string, { challenge: string; nonce: string; redirectUri: string }>();
  const refreshTokens = new Set<string>();
  let failRefresh = false;
  let tokenRequests = 0;
  let refreshRequests = 0;
  let issuer = "";

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", issuer || "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      json(response, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: [clientAuthentication],
        code_challenge_methods_supported: ["S256"],
        backchannel_logout_supported: true,
        backchannel_logout_session_supported: true,
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/jwks") {
      json(response, 200, { keys: [publicJwk] });
      return;
    }
    if (request.method === "GET" && url.pathname === "/authorize") {
      if (url.searchParams.get("client_id") !== clientId ||
          url.searchParams.get("response_type") !== "code" ||
          url.searchParams.get("code_challenge_method") !== "S256") {
        json(response, 400, { error: "invalid_request" });
        return;
      }
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const code = randomBytes(18).toString("base64url");
      codes.set(code, {
        challenge: url.searchParams.get("code_challenge") ?? "",
        nonce: url.searchParams.get("nonce") ?? "",
        redirectUri,
      });
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", url.searchParams.get("state") ?? "");
      response.writeHead(302, { location: callback.href, "cache-control": "no-store" });
      response.end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/token") {
      tokenRequests += 1;
      const rawBody = await bodyOf(request);
      if (!validClient(request, rawBody, clientId, clientSecret, clientAuthentication)) {
        json(response, 401, { error: "invalid_client" });
        return;
      }
      const body = new URLSearchParams(rawBody);
      const grant = body.get("grant_type");
      if (grant === "authorization_code") {
        const code = body.get("code") ?? "";
        const pending = codes.get(code);
        codes.delete(code);
        const challenge = createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url");
        if (!pending || pending.challenge !== challenge || pending.redirectUri !== body.get("redirect_uri")) {
          json(response, 400, { error: "invalid_grant" });
          return;
        }
        const accessToken = randomBytes(24).toString("base64url");
        const refreshToken = randomBytes(24).toString("base64url");
        refreshTokens.add(refreshToken);
        json(response, 200, {
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: expiresIn,
          refresh_token: refreshToken,
          id_token: idToken(privateKey, issuer, clientId, subject, providerSid, pending.nonce, accessToken, expiresIn),
        });
        return;
      }
      if (grant === "refresh_token") {
        refreshRequests += 1;
        const old = body.get("refresh_token") ?? "";
        if (failRefresh || !refreshTokens.delete(old)) {
          json(response, 400, { error: "invalid_grant" });
          return;
        }
        const accessToken = randomBytes(24).toString("base64url");
        const refreshToken = randomBytes(24).toString("base64url");
        refreshTokens.add(refreshToken);
        json(response, 200, {
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: expiresIn,
          refresh_token: refreshToken,
          id_token: idToken(privateKey, issuer, clientId, subject, providerSid, undefined, accessToken, expiresIn),
        });
        return;
      }
      json(response, 400, { error: "unsupported_grant_type" });
      return;
    }
    json(response, 404, { error: "not_found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    issuer,
    clientId,
    clientSecret,
    subject,
    providerSid,
    get tokenRequests() { return tokenRequests; },
    get refreshRequests() { return refreshRequests; },
    setFailRefresh(value: boolean) { failRefresh = value; },
    logoutToken(claims: { sid?: string; sub?: string; jti?: string | null; issuer?: string } = {}) {
      const now = Math.floor(Date.now() / 1_000);
      return jwt(privateKey, {
        iss: claims.issuer ?? issuer,
        aud: clientId,
        iat: now,
        exp: now + 300,
        ...(claims.jti === null ? {} : { jti: claims.jti ?? randomBytes(12).toString("base64url") }),
        events: { "http://schemas.openid.net/event/backchannel-logout": {} },
        ...(claims.sid === undefined ? {} : { sid: claims.sid }),
        ...(claims.sub === undefined ? {} : { sub: claims.sub }),
      });
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export type TestIssuer = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  subject: string;
  providerSid: string;
  readonly tokenRequests: number;
  readonly refreshRequests: number;
  setFailRefresh(value: boolean): void;
  logoutToken(claims?: { sid?: string; sub?: string; jti?: string | null; issuer?: string }): string;
  close(): Promise<void>;
};

function idToken(
  key: KeyObject,
  issuer: string,
  audience: string,
  subject: string,
  sid: string,
  nonce: string | undefined,
  accessToken: string,
  expiresIn: number,
): string {
  const now = Math.floor(Date.now() / 1_000);
  const digest = createHash("sha256").update(accessToken).digest();
  return jwt(key, {
    iss: issuer,
    aud: audience,
    sub: subject,
    sid,
    iat: now,
    exp: now + Math.max(expiresIn, 120),
    at_hash: digest.subarray(0, digest.length / 2).toString("base64url"),
    ...(nonce === undefined ? {} : { nonce }),
  });
}

function jwt(key: KeyObject, claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signed = `${header}.${payload}`;
  return `${signed}.${sign("RSA-SHA256", Buffer.from(signed), key).toString("base64url")}`;
}

function validClient(
  request: IncomingMessage,
  rawBody: string,
  id: string,
  secret: string,
  method: "client_secret_basic" | "client_secret_post",
): boolean {
  if (method === "client_secret_post") {
    const body = new URLSearchParams(rawBody);
    return body.get("client_id") === id && body.get("client_secret") === secret;
  }
  const encode = (value: string): string => encodeURIComponent(value).replace(/-/g, "%2D");
  const expected = `Basic ${Buffer.from(`${encode(id)}:${encode(secret)}`).toString("base64")}`;
  return request.headers.authorization === expected;
}

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const payload = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}
