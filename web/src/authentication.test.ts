import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { beginReauthentication, reauthenticateClosedSocket } from "./authentication.ts";

const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");

after(() => {
  if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
  else delete (globalThis as { location?: unknown }).location;
});

describe("browser reauthentication", () => {
  it("navigates only once across HTTP and revoked WebSocket signals", () => {
    const navigations: string[] = [];
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: {
        pathname: "/session/one",
        search: "?tab=files",
        hash: "#output",
        assign: (url: string) => navigations.push(url),
      },
    });

    assert.equal(beginReauthentication(new Response(null, {
      status: 401,
      headers: { "x-flow-login": "/oauth/login" },
    })), true);
    reauthenticateClosedSocket(4001);
    reauthenticateClosedSocket(4001);

    assert.deepEqual(navigations, [
      "/oauth/login?return_to=%2Fsession%2Fone%3Ftab%3Dfiles%23output",
    ]);
  });
});
