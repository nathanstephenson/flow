import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Provider from "oidc-provider";
import { OidcGate } from "../src/daemon/auth.ts";

test("oidc-provider grants offline access with consent and refreshes without new consent", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-oidc-provider-"));
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const issuer = `http://127.0.0.1:${address.port}`;
  const config = {
    issuer,
    clientId: "flow-test",
    clientSecret: "flow-test-secret",
    publicAppUrl: "http://localhost:4318",
  };
  const provider = new Provider(issuer, {
    clients: [{
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uris: [`${config.publicAppUrl}/oauth/callback`],
      response_types: ["code"],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "client_secret_basic",
    }],
    features: { devInteractions: { enabled: false } },
    cookies: { keys: ["flow-test-cookie-key"] },
    interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
    findAccount: async (_ctx, accountId) => ({
      accountId,
      claims: async () => ({ sub: accountId }),
    }),
  });
  let interactions = 0;
  const callback = provider.callback();
  server.on("request", (request, response) => {
    if (!request.url?.startsWith("/interaction/")) {
      callback(request, response);
      return;
    }
    void (async () => {
      interactions += 1;
      const details = await provider.interactionDetails(request, response);
      const grant = new provider.Grant({ accountId: "trusted-user", clientId: config.clientId });
      grant.addOIDCScope(String(details.params.scope));
      await provider.interactionFinished(request, response, {
        login: { accountId: "trusted-user" },
        consent: { grantId: await grant.save() },
      }, { mergeWithLastSubmission: false });
    })().catch((error) => response.destroy(error));
  });
  const exchanges: Array<{ request: URLSearchParams; tokens: Record<string, unknown> }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (init?.body instanceof URLSearchParams && init.body.has("grant_type")) {
      const tokens = await response.clone().json() as Record<string, unknown>;
      exchanges.push({ request: init.body, tokens });
    }
    return response;
  };
  let gate: OidcGate | undefined;
  try {
    gate = await OidcGate.create(config, root, { fetch: fetcher });
    let url = new URL(await gate.beginLogin("/#/settings"));
    const cookies = new Map<string, string>();
    for (let redirects = 0; url.origin === issuer && redirects < 10; redirects += 1) {
      const response = await fetch(url, {
        redirect: "manual",
        headers: { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; ") },
      });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";", 1)[0]!;
        const equals = pair.indexOf("=");
        cookies.set(pair.slice(0, equals), pair.slice(equals + 1));
      }
      await response.arrayBuffer();
      assert.equal(response.status, 303);
      url = new URL(response.headers.get("location")!, url);
    }
    assert.equal(url.origin, config.publicAppUrl);
    const login = await gate.completeLogin(url);
    assert.equal(login.location, "/#/settings");
    assert.equal(exchanges[0]?.request.get("grant_type"), "authorization_code");
    const refreshToken = exchanges[0]?.tokens.refresh_token;
    assert.equal(typeof refreshToken, "string", "consent must result in a refresh token");
    assert.ok(refreshToken);

    gate.dispose();
    const path = join(root, "oidc", "sessions.json");
    const stored = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(stored.sessions[0].refreshToken, refreshToken);
    stored.sessions[0].tokenExpiresAt = Date.now() - 1;
    writeFileSync(path, JSON.stringify(stored), { mode: 0o600 });
    const loginInteractions = interactions;
    gate = await OidcGate.create(config, root, { fetch: fetcher });
    assert.ok(await gate.authenticate(login.cookie));
    const refresh = exchanges.find((exchange) => exchange.request.get("grant_type") === "refresh_token");
    assert.ok(refresh);
    assert.equal(refresh.request.get("refresh_token"), refreshToken);
    assert.equal(refresh.request.has("prompt"), false);
    assert.equal(typeof refresh.tokens.access_token, "string");
    assert.equal(interactions, loginInteractions);
  } finally {
    gate?.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
