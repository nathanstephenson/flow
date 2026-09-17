import {
  createHash,
  randomBytes,
  timingSafeEqual,
  type JsonWebKey,
} from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, errors as joseErrors, type JSONWebKeySet } from "jose";

/** The name of the opaque browser-session cookie used by the OIDC gate. */
export const OIDC_COOKIE = "flow_session";

const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
const LOGIN_LIFETIME_MS = 10 * 60 * 1_000;
const REFRESH_EARLY_MS = 60 * 1_000;
const CLOCK_SKEW_SECONDS = 60;
const LOGOUT_TOKEN_MAX_AGE_SECONDS = 10 * 60;

/** Environment configuration for an external OpenID Provider. */
export type OidcConfig = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  publicAppUrl: string;
};

type OidcDiscovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  response_types_supported?: string[];
  id_token_signing_alg_values_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  code_challenge_methods_supported?: string[];
};

type TokenSet = {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
};

type Claims = Record<string, unknown> & {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  azp?: string;
  exp?: number;
  iat?: number;
  nonce?: string;
  sid?: string;
  events?: Record<string, unknown>;
  jti?: string;
  at_hash?: string;
  c_hash?: string;
};

type BrowserSession = {
  id: string;
  sub: string;
  providerSid?: string;
  expiresAt: number;
  tokenExpiresAt: number;
  refreshToken?: string;
};

type StoredState = {
  version: 1;
  sessions: BrowserSession[];
  /** Fingerprint -> expiry in milliseconds. Persisted so a restart does not reopen a replay window. */
  logoutTokens: Record<string, number>;
};

type LoginTransaction = {
  verifier: string;
  nonce: string;
  returnTo: string;
  expiresAt: number;
};

export class OidcConfigurationError extends Error {}
export class OidcAuthenticationError extends Error {}

/**
 * Read the all-or-nothing OIDC environment contract.
 *
 * An empty configuration preserves the local bearer/cookie behaviour. Once any variable is set,
 * every variable is required and every URL is checked before the daemon opens a socket. That makes
 * a typo fail closed instead of accidentally falling back to the local trust model.
 */
export function oidcConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OidcConfig | undefined {
  const values = {
    issuer: env["FLOW_OIDC_ISSUER"]?.trim(),
    clientId: env["FLOW_OIDC_CLIENT_ID"]?.trim(),
    clientSecret: env["FLOW_OIDC_CLIENT_SECRET"]?.trim(),
    publicAppUrl: env["FLOW_OIDC_PUBLIC_APP_URL"]?.trim(),
  };
  const configured = Object.values(values).filter((value) => value !== undefined && value !== "");
  if (configured.length === 0) return undefined;
  if (configured.length !== 4) {
    throw new OidcConfigurationError(
      "FLOW_OIDC_ISSUER, FLOW_OIDC_CLIENT_ID, FLOW_OIDC_CLIENT_SECRET and " +
        "FLOW_OIDC_PUBLIC_APP_URL must be configured together",
    );
  }

  const issuer = checkedUrl(values.issuer!, "FLOW_OIDC_ISSUER", false);
  const publicAppUrl = checkedUrl(values.publicAppUrl!, "FLOW_OIDC_PUBLIC_APP_URL", true);
  return {
    issuer: withoutTrailingSlash(issuer.href),
    clientId: values.clientId!,
    clientSecret: values.clientSecret!,
    publicAppUrl: withoutTrailingSlash(publicAppUrl.href),
  };
}

/**
 * Persistent OIDC browser-session authority.
 *
 * Provider credentials never leave this object or its 0600 state file. Callers receive only an
 * opaque random id, which is suitable for associating long-lived SSE/WebSocket connections with the
 * browser session that opened them.
 */
export class OidcGate {
  readonly config: OidcConfig;
  readonly discovery: OidcDiscovery;

  private readonly statePath: string;
  private readonly fetcher: typeof fetch;
  private jwks: JsonWebKey[];
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly logoutTokens = new Map<string, number>();
  private readonly transactions = new Map<string, LoginTransaction>();
  private readonly refreshing = new Map<string, Promise<boolean>>();
  private readonly connections = new Map<string, Set<() => void>>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor(
    config: OidcConfig,
    discovery: OidcDiscovery,
    jwks: JsonWebKey[],
    stateRoot: string,
    fetcher: typeof fetch,
  ) {
    this.config = config;
    this.discovery = discovery;
    this.jwks = jwks;
    this.fetcher = fetcher;
    const directory = join(stateRoot, "oidc");
    this.statePath = join(directory, "sessions.json");

    // The containing directory is itself credential material. Correct an existing permissive mode,
    // not only a newly-created one (mkdir's mode is filtered by umask and ignored when it exists).
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    chmodSync(stateRoot, 0o700);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.load();
    this.expire();
    this.scheduleRefresh();
  }

  static async create(
    config: OidcConfig,
    stateRoot: string,
    options: { fetch?: typeof fetch } = {},
  ): Promise<OidcGate> {
    const fetcher = options.fetch ?? fetch;
    const discoveryUrl = `${config.issuer}/.well-known/openid-configuration`;
    const discovery = await fetchJson<OidcDiscovery>(fetcher, discoveryUrl, "OIDC discovery");
    validateDiscovery(config, discovery);
    const jwks = await fetchJwks(fetcher, discovery.jwks_uri);
    return new OidcGate(config, discovery, jwks, stateRoot, fetcher);
  }

  /** The registered redirect URI, suitable for deployment diagnostics and issuer configuration. */
  callbackUrl(): string {
    return `${this.config.publicAppUrl}/oauth/callback`;
  }

  /** The registered back-channel logout URI. */
  backchannelLogoutUrl(): string {
    return `${this.config.publicAppUrl}/oauth/backchannel`;
  }

  /** Start Authorization Code + PKCE without accepting an off-origin return target. */
  beginLogin(returnTo: string | undefined): string {
    this.pruneTransactions();
    while (this.transactions.size >= 128) this.transactions.delete(this.transactions.keys().next().value!);
    const state = opaqueToken();
    const verifier = opaqueToken(48);
    const nonce = opaqueToken();
    this.transactions.set(state, {
      verifier,
      nonce,
      returnTo: safeReturnTo(returnTo, this.config.publicAppUrl),
      expiresAt: Date.now() + LOGIN_LIFETIME_MS,
    });

    const authorization = new URL(this.discovery.authorization_endpoint);
    authorization.searchParams.set("client_id", this.config.clientId);
    authorization.searchParams.set("redirect_uri", this.callbackUrl());
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set("scope", "openid offline_access");
    authorization.searchParams.set("state", state);
    authorization.searchParams.set("nonce", nonce);
    authorization.searchParams.set("code_challenge", sha256(verifier));
    authorization.searchParams.set("code_challenge_method", "S256");
    return authorization.href;
  }

  /** Consume a callback once, validate the ID token, and mint an unrelated browser credential. */
  async completeLogin(url: URL): Promise<{ cookie: string; location: string }> {
    const state = url.searchParams.get("state") ?? "";
    const transaction = this.transactions.get(state);
    // Consume before doing network I/O: retries and duplicated callbacks cannot exchange one code
    // twice, even when the first token request is still in flight.
    if (state) this.transactions.delete(state);
    if (!transaction || transaction.expiresAt <= Date.now()) {
      throw new OidcAuthenticationError("The sign-in request is invalid or has expired.");
    }
    if (url.searchParams.has("error")) {
      throw new OidcAuthenticationError("The identity provider did not complete sign-in.");
    }
    const code = url.searchParams.get("code");
    if (!code) throw new OidcAuthenticationError("The identity provider returned no code.");

    const tokens = await this.exchange({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.callbackUrl(),
      code_verifier: transaction.verifier,
    });
    if (!tokens.id_token) {
      throw new OidcAuthenticationError("The identity provider returned no ID token.");
    }
    const claims = await this.verifyToken(tokens.id_token, {
      nonce: transaction.nonce,
      code,
    });
    if (!claims.sub) throw new OidcAuthenticationError("The ID token has no subject.");

    const now = Date.now();
    const id = opaqueToken();
    const session: BrowserSession = {
      id,
      sub: claims.sub,
      ...(typeof claims.sid === "string" ? { providerSid: claims.sid } : {}),
      expiresAt: now + SESSION_LIFETIME_MS,
      tokenExpiresAt: tokenExpiry(tokens, claims, now),
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    };
    this.sessions.set(id, session);
    this.persist();
    this.scheduleRefresh();
    return { cookie: this.sessionCookie(id), location: transaction.returnTo };
  }

  /**
   * Authenticate a browser cookie and refresh provider tokens before they expire.
   *
   * Concurrent requests for one browser session share one refresh promise. Rotation is persisted
   * before the requests proceed, so a crash cannot resurrect the old refresh token.
   */
  async authenticate(cookieHeader: string | undefined): Promise<string | undefined> {
    const id = cookieValue(cookieHeader, OIDC_COOKIE);
    if (!id) return undefined;
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) {
      this.invalidate(id);
      return undefined;
    }
    if (session.tokenExpiresAt - Date.now() <= REFRESH_EARLY_MS) {
      if (!(await this.refresh(id))) return undefined;
    }
    return id;
  }

  /** End only Flow's browser session. There is deliberately no global issuer logout. */
  logout(cookieHeader: string | undefined): void {
    const id = cookieValue(cookieHeader, OIDC_COOKIE);
    if (id) this.invalidate(id);
  }

  clearCookie(): string {
    return `${OIDC_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${this.secureCookie()}`;
  }

  /**
   * Validate and consume an OIDC Back-Channel Logout token.
   *
   * The signed token replay marker is durable. Matching `sid` sessions are preferred, while a
   * subject-only notice revokes every Flow
   * browser session for that provider subject, as the specification requires.
   */
  async backchannelLogout(logoutToken: string): Promise<number> {
    const claims = await this.verifyToken(logoutToken, { logout: true });
    const event = claims.events?.["http://schemas.openid.net/event/backchannel-logout"];
    if (!event || typeof event !== "object" || Array.isArray(event) || Object.keys(event).length !== 0 ||
        typeof claims.jti !== "string" || !claims.jti || claims.nonce !== undefined) {
      throw new OidcAuthenticationError("Invalid logout token.");
    }
    if (typeof claims.iat !== "number" || claims.iat < Date.now() / 1_000 - LOGOUT_TOKEN_MAX_AGE_SECONDS) {
      throw new OidcAuthenticationError("Expired logout token.");
    }
    const providerSid = typeof claims.sid === "string" ? claims.sid : undefined;
    const sub = typeof claims.sub === "string" ? claims.sub : undefined;
    if (!providerSid && !sub) throw new OidcAuthenticationError("Logout token has no session or subject.");

    const fingerprint = createHash("sha256")
      .update(`${claims.iss}:${claims.jti}`)
      .digest("base64url");
    if (this.logoutTokens.has(fingerprint)) {
      throw new OidcAuthenticationError("Logout token was already used.");
    }
    this.logoutTokens.set(fingerprint, Math.min(
      (typeof claims.exp === "number" ? claims.exp * 1_000 : Date.now() + SESSION_LIFETIME_MS),
      Date.now() + SESSION_LIFETIME_MS,
    ));

    const matches = [...this.sessions.values()].filter((session) =>
      providerSid ? session.providerSid === providerSid : session.sub === sub,
    );
    for (const session of matches) this.invalidate(session.id, false);
    this.persist();
    return matches.length;
  }

  /** Associate an idle transport with the browser session that opened it. */
  registerConnection(sessionId: string, close: () => void): () => void {
    let active = true;
    const set = this.connections.get(sessionId) ?? new Set<() => void>();
    set.add(close);
    this.connections.set(sessionId, set);
    return () => {
      if (!active) return;
      active = false;
      set.delete(close);
      if (set.size === 0) this.connections.delete(sessionId);
    };
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
  }

  private sessionCookie(id: string): string {
    return `${OIDC_COOKIE}=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_LIFETIME_MS / 1_000}${this.secureCookie()}`;
  }

  private secureCookie(): string {
    return new URL(this.config.publicAppUrl).protocol === "https:" ? "; Secure" : "";
  }

  private async refresh(id: string): Promise<boolean> {
    const inFlight = this.refreshing.get(id);
    if (inFlight) return await inFlight;
    const work = this.performRefresh(id).finally(() => this.refreshing.delete(id));
    this.refreshing.set(id, work);
    return await work;
  }

  private async performRefresh(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session?.refreshToken) {
      this.invalidate(id);
      return false;
    }
    try {
      const tokens = await this.exchange({
        grant_type: "refresh_token",
        refresh_token: session.refreshToken,
      });
      let claims: Claims | undefined;
      if (tokens.id_token) {
        claims = await this.verifyToken(tokens.id_token, { accessToken: tokens.access_token });
        if (claims.sub !== session.sub ||
            (session.providerSid && claims.sid && claims.sid !== session.providerSid)) {
          throw new OidcAuthenticationError("Refreshed identity changed.");
        }
      }
      const current = this.sessions.get(id);
      if (!current) return false;
      const now = Date.now();
      this.sessions.set(id, {
        ...current,
          // A rotating provider returns a replacement. A non-rotating provider leaves it absent.
        refreshToken: tokens.refresh_token ?? session.refreshToken,
        tokenExpiresAt: tokenExpiry(tokens, claims, now),
        ...(typeof claims?.sid === "string" ? { providerSid: claims.sid } : {}),
      });
      this.persist();
      this.scheduleRefresh();
      return true;
    } catch {
      this.invalidate(id);
      return false;
    }
  }

  private async exchange(parameters: Record<string, string>): Promise<TokenSet> {
    const body = new URLSearchParams(parameters);
    const methods = this.discovery.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    };
    if (methods.includes("client_secret_basic")) {
      // RFC 6749 §2.3.1 form-encodes each credential before joining them with a colon.
      const id = formEncode(this.config.clientId);
      const secret = formEncode(this.config.clientSecret);
      headers.authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
    } else if (methods.includes("client_secret_post")) {
      body.set("client_id", this.config.clientId);
      body.set("client_secret", this.config.clientSecret);
    } else {
      throw new OidcAuthenticationError("The provider does not support confidential clients.");
    }

    const response = await timedFetch(this.fetcher, this.discovery.token_endpoint, {
      method: "POST",
      headers,
      body,
      redirect: "error",
    });
    if (!response.ok) throw new OidcAuthenticationError("The token endpoint refused the request.");
    const value = (await response.json()) as Partial<TokenSet>;
    if (typeof value.access_token !== "string" || !value.access_token) {
      throw new OidcAuthenticationError("The token endpoint returned no access token.");
    }
    if (typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer") {
      throw new OidcAuthenticationError("The token endpoint returned an unsupported token type.");
    }
    return value as TokenSet;
  }

  private async verifyToken(
    token: string,
    options: { nonce?: string; accessToken?: string; code?: string; logout?: boolean },
  ): Promise<Claims> {
    let header: ReturnType<typeof decodeProtectedHeader>;
    try {
      header = decodeProtectedHeader(token);
    } catch {
      throw new OidcAuthenticationError("Token is malformed.");
    }
    const supported = this.discovery.id_token_signing_alg_values_supported!;
    if (!header.alg || !supported.includes(header.alg)) {
      throw new OidcAuthenticationError("Token signing algorithm is not advertised.");
    }

    let result;
    try {
      result = await jwtVerify(token, createLocalJWKSet({ keys: this.jwks } as JSONWebKeySet), {
        issuer: this.config.issuer,
        audience: this.config.clientId,
        algorithms: supported,
        clockTolerance: CLOCK_SKEW_SECONDS,
        requiredClaims: options.logout ? ["iat"] : ["iat", "exp"],
      });
    } catch (error) {
      if (!(error instanceof joseErrors.JWKSNoMatchingKey)) {
        throw new OidcAuthenticationError("Token validation failed.");
      }
      this.jwks = await fetchJwks(this.fetcher, this.discovery.jwks_uri);
      try {
        result = await jwtVerify(token, createLocalJWKSet({ keys: this.jwks } as JSONWebKeySet), {
          issuer: this.config.issuer, audience: this.config.clientId, algorithms: supported,
          clockTolerance: CLOCK_SKEW_SECONDS,
          requiredClaims: options.logout ? ["iat"] : ["iat", "exp"],
        });
      } catch {
        throw new OidcAuthenticationError("Token validation failed.");
      }
    }
    const claims = result.payload as Claims;
    const now = Date.now() / 1_000;
    if (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== this.config.clientId) {
      throw new OidcAuthenticationError("Token authorised party is invalid.");
    }
    if (typeof claims.iat !== "number" || claims.iat > now + CLOCK_SKEW_SECONDS) {
      throw new OidcAuthenticationError("Token issue time is invalid.");
    }
    if (options.nonce !== undefined && claims.nonce !== options.nonce) {
      throw new OidcAuthenticationError("ID token nonce is invalid.");
    }
    if (options.accessToken && typeof claims.at_hash === "string" &&
        claims.at_hash !== oidcHash(options.accessToken, header.alg)) {
      throw new OidcAuthenticationError("Access token hash is invalid.");
    }
    if (options.code && typeof claims.c_hash === "string" &&
        claims.c_hash !== oidcHash(options.code, header.alg)) {
      throw new OidcAuthenticationError("Authorization code hash is invalid.");
    }
    return claims;
  }

  private invalidate(id: string, persist = true): void {
    if (!this.sessions.delete(id)) return;
    // Copy before invoking: close handlers synchronously unregister themselves in both Node's SSE
    // response and ws, and mutating a Set while iterating it is needlessly subtle.
    for (const close of [...(this.connections.get(id) ?? [])]) {
      try {
        close();
      } catch {
        // Revocation remains durable even if a socket was already gone.
      }
    }
    this.connections.delete(id);
    if (persist) this.persist();
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const now = Date.now();
    const next = Math.min(...[...this.sessions.values()].map((session) => {
      const early = session.tokenExpiresAt - REFRESH_EARLY_MS;
      return Math.min(session.expiresAt, early > now ? early : session.tokenExpiresAt);
    }), Infinity);
    if (!Number.isFinite(next)) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refreshDueSessions();
    }, Math.max(0, next - now));
    this.refreshTimer.unref();
  }

  private async refreshDueSessions(): Promise<void> {
    this.expire();
    const now = Date.now();
    const due = [...this.sessions.values()]
      .filter((session) => session.expiresAt > now && session.tokenExpiresAt - now <= REFRESH_EARLY_MS)
      .map((session) => session.id);
    await Promise.all(due.map(async (id) => await this.refresh(id)));
    this.scheduleRefresh();
  }

  private expire(): void {
    const now = Date.now();
    let dirty = false;
    for (const session of [...this.sessions.values()]) {
      if (session.expiresAt <= now) {
        this.invalidate(session.id, false);
        dirty = true;
      }
    }
    for (const [fingerprint, expiresAt] of this.logoutTokens) {
      if (expiresAt <= now) {
        this.logoutTokens.delete(fingerprint);
        dirty = true;
      }
    }
    this.pruneTransactions();
    if (dirty) this.persist();
  }

  private pruneTransactions(): void {
    const now = Date.now();
    for (const [state, transaction] of this.transactions) {
      if (transaction.expiresAt <= now) this.transactions.delete(state);
    }
  }

  private load(): void {
    let stored: StoredState;
    try {
      stored = JSON.parse(readFileSync(this.statePath, "utf8")) as StoredState;
      chmodSync(this.statePath, 0o600);
    } catch {
      return;
    }
    if (stored.version !== 1 || !Array.isArray(stored.sessions)) return;
    for (const session of stored.sessions) {
      if (validStoredSession(session)) this.sessions.set(session.id, session);
    }
    for (const [fingerprint, expiresAt] of Object.entries(stored.logoutTokens ?? {})) {
      if (typeof expiresAt === "number") this.logoutTokens.set(fingerprint, expiresAt);
    }
  }

  private persist(): void {
    const state: StoredState = {
      version: 1,
      sessions: [...this.sessions.values()],
      logoutTokens: Object.fromEntries(this.logoutTokens),
    };
    const temporary = `${this.statePath}.${process.pid}.${opaqueToken(8)}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.statePath);
      chmodSync(this.statePath, 0o600);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}

/** Construct and discover only when OIDC is configured. */
export async function createOidcGateFromEnv(
  stateRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OidcGate | undefined> {
  const config = oidcConfigFromEnv(env);
  return config ? await OidcGate.create(config, stateRoot) : undefined;
}

/**
 * The Session Host's bearer token (ADR 0004).
 *
 * Tools are pre-approved, so an authenticated client can run arbitrary commands as the user. The
 * token is therefore treated as a credential: 0600 on disk, and compared in constant time.
 */
export function readOrCreateToken(stateRoot: string): string {
  const path = join(stateRoot, "token");
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing) {
      chmodSync(path, 0o600);
      return existing;
    }
  } catch {
    // No token yet.
  }
  const token = randomBytes(32).toString("base64url");
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  chmodSync(stateRoot, 0o700);
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}

export function tokenMatches(expected: string, presented: string | undefined): boolean {
  if (!presented) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function checkedUrl(raw: string, name: string, requireOrigin: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OidcConfigurationError(`${name} must be an absolute URL`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new OidcConfigurationError(`${name} must not contain credentials, a query or a fragment`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localHostname(url.hostname))) {
    throw new OidcConfigurationError(`${name} must use HTTPS (HTTP is allowed only on localhost)`);
  }
  if (requireOrigin && url.pathname !== "/") {
    throw new OidcConfigurationError(`${name} must be an origin without a path`);
  }
  return url;
}

function localHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function withoutTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function validateDiscovery(config: OidcConfig, discovery: OidcDiscovery): void {
  if (discovery.issuer !== config.issuer) {
    throw new OidcConfigurationError("OIDC discovery issuer does not exactly match FLOW_OIDC_ISSUER");
  }
  if (discovery.response_types_supported && !discovery.response_types_supported.includes("code")) {
    throw new OidcConfigurationError("OIDC provider does not advertise the authorization-code flow");
  }
  if (!discovery.code_challenge_methods_supported?.includes("S256")) {
    throw new OidcConfigurationError("OIDC provider does not advertise S256 PKCE");
  }
  if (!discovery.id_token_signing_alg_values_supported?.some((alg) => alg !== "none")) {
    throw new OidcConfigurationError("OIDC provider does not advertise a signing algorithm");
  }
  for (const [name, value] of [
    ["authorization_endpoint", discovery.authorization_endpoint],
    ["token_endpoint", discovery.token_endpoint],
    ["jwks_uri", discovery.jwks_uri],
  ] as const) {
    if (typeof value !== "string") throw new OidcConfigurationError(`OIDC discovery has no ${name}`);
    checkedUrl(value, `OIDC ${name}`, false);
  }
}

async function fetchJwks(fetcher: typeof fetch, url: string): Promise<JsonWebKey[]> {
  const body = await fetchJson<{ keys?: JsonWebKey[] }>(fetcher, url, "OIDC signing keys");
  if (!Array.isArray(body.keys) || body.keys.length === 0) {
    throw new OidcConfigurationError("OIDC provider published no signing keys");
  }
  return body.keys;
}

async function fetchJson<T>(fetcher: typeof fetch, url: string, label: string): Promise<T> {
  const response = await timedFetch(fetcher, url, {
    headers: { accept: "application/json" },
    redirect: "error",
  });
  if (!response.ok) throw new OidcConfigurationError(`${label} failed with HTTP ${response.status}`);
  try {
    return (await response.json()) as T;
  } catch {
    throw new OidcConfigurationError(`${label} did not return JSON`);
  }
}

async function timedFetch(fetcher: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function safeReturnTo(value: string | undefined, publicAppUrl: string): string {
  if (!value) return "/";
  try {
    const url = new URL(value, publicAppUrl);
    if (url.origin !== new URL(publicAppUrl).origin) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

function opaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function formEncode(value: string): string {
  return new URLSearchParams({ value }).toString().slice("value=".length);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const pair of header.split(";")) {
    const index = pair.indexOf("=");
    if (index === -1 || pair.slice(0, index).trim() !== name) continue;
    const value = pair.slice(index + 1).trim();
    return value || undefined;
  }
  return undefined;
}

function tokenExpiry(tokens: TokenSet, claims: Claims | undefined, now: number): number {
  if (typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in) && tokens.expires_in > 0) {
    return now + tokens.expires_in * 1_000;
  }
  if (typeof claims?.exp === "number") return claims.exp * 1_000;
  // No token lifetime is not treated as forever: make the first subsequent request refresh it.
  return now;
}

function validStoredSession(value: BrowserSession): boolean {
  return typeof value?.id === "string" &&
    typeof value.sub === "string" &&
    typeof value.expiresAt === "number" &&
    typeof value.tokenExpiresAt === "number" &&
    (value.refreshToken === undefined || typeof value.refreshToken === "string");
}

function audienceIncludes(audience: Claims["aud"], expected: string): boolean {
  return typeof audience === "string" ? audience === expected : Array.isArray(audience) && audience.includes(expected);
}

function oidcHash(value: string, alg: string): string {
  const bits = Number(alg.slice(-3));
  if (![256, 384, 512].includes(bits)) throw new OidcAuthenticationError("Unsupported token hash algorithm.");
  const digest = createHash(`sha${bits}`).update(value).digest();
  return digest.subarray(0, digest.length / 2).toString("base64url");
}
