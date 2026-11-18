import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import { forkPiState } from "../../src/backend/pi/state.ts";
import { piFixture, userText } from "./pi-fixture.ts";

function said(request: { messages: Array<{ role: string; content: unknown }> }): string[] {
  return request.messages.filter((message) => message.role === "user")
    .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content));
}

it("rewinds and forks a pi Conversation Context to just before a user message", async (t) => {
  const fixture = await piFixture(t, (request) => ({ text: `re: ${userText(request)}` }));
  const stateDir = join(fixture.scope, "sessions");
  const first = await fixture.create();
  await first.prompt("one", undefined, "m1");
  await first.prompt("two", undefined, "m2");
  await first.dispose();

  const rewound = await fixture.create({ resume: stateDir, resumeBefore: "m2" });
  await rewound.prompt("three", undefined, "m3");
  const afterRewind = said(fixture.requests.at(-1)!).join(" ");
  assert.match(afterRewind, /one/);
  assert.doesNotMatch(afterRewind, /two/);
  await rewound.dispose();

  const forkDir = mkdtempSync(join(tmpdir(), "flow-pi-fork-"));
  mkdirSync(forkDir, { recursive: true });
  forkPiState(stateDir, forkDir, fixture.scope);
  const fork = await fixture.create({ stateDir: forkDir, resume: forkDir, resumeBefore: "m3" });
  await fork.prompt("four", undefined, "m4");
  const afterFork = said(fixture.requests.at(-1)!).join(" ");
  assert.match(afterFork, /one/);
  assert.doesNotMatch(afterFork, /two|three/);
});

it("refuses a user message pi has no record of", async (t) => {
  const fixture = await piFixture(t, () => ({ text: "ok" }));
  const stateDir = join(fixture.scope, "sessions");
  await (await fixture.create()).prompt("one", undefined, "m1");
  await assert.rejects(() => fixture.create({ resume: stateDir, resumeBefore: "unknown" }), /cannot be rewound/);
});
