import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { it } from "node:test";
import { transformSync } from "esbuild";

it("sends refresh_git on mount only when visible and again when the document becomes visible", () => {
  const sent: unknown[] = [];
  const listeners = new Map<string, () => void>();
  const document = {
    visibilityState: "hidden",
    addEventListener: (type: string, listener: () => void) => { listeners.set(type, listener); },
    removeEventListener: (type: string) => { listeners.delete(type); },
  };
  const effects: (() => (() => void) | void)[] = [];
  const module = { exports: {} as Record<string, (sessionId: string) => unknown> };
  const code = transformSync(readFileSync(new URL("../web/src/git-state.ts", import.meta.url), "utf8"), { loader: "ts", format: "cjs" }).code;
  runInNewContext(code, { document, module, exports: module.exports, require: (name: string) => {
    if (name === "react") return { useEffect: (effect: () => (() => void) | void) => { effects.push(effect); } };
    if (name === "@/agent-sessions.tsx") return { useAgentSessions: () => ({ sessions: [] }), useCommand: () => async (command: unknown) => { sent.push(command); } };
    return createRequire(import.meta.url)(name);
  } });
  module.exports.useGitState!("session");
  const cleanup = effects[0]!();
  assert.deepEqual(sent, []);
  document.visibilityState = "visible";
  listeners.get("visibilitychange")!();
  assert.equal(JSON.stringify(sent), JSON.stringify([{ type: "refresh_git", sessionId: "session" }]));
  cleanup?.();
  assert.equal(listeners.size, 0);
  effects.length = 0;
  module.exports.useGitState!("session");
  effects[0]!();
  assert.equal(sent.length, 2);
});

it("reports a Scope as not a Git repository when its summary has no branch and no Git State, and as unknown before the summary arrives", () => {
  const module = { exports: {} as Record<string, (sessionId: string) => unknown> };
  let sessions: unknown[] = [];
  const code = transformSync(readFileSync(new URL("../web/src/git-state.ts", import.meta.url), "utf8"), { loader: "ts", format: "cjs" }).code;
  runInNewContext(code, { module, exports: module.exports, require: (name: string) => {
    if (name === "react") return { useEffect: () => {} };
    if (name === "@/agent-sessions.tsx") return { useAgentSessions: () => ({ sessions }), useCommand: () => async () => {} };
    return createRequire(import.meta.url)(name);
  } });
  const repository = () => (module.exports.useGitState!("session") as { repository: boolean | undefined }).repository;
  assert.equal(repository(), undefined);
  sessions = [{ id: "session" }];
  assert.equal(repository(), false);
  sessions = [{ id: "session", branch: { name: "main" } }];
  assert.equal(repository(), true);
});
