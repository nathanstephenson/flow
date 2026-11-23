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
    if (name === "react") return { useEffect: (effect: () => (() => void) | void) => { effects.push(effect); }, useState: (initial: unknown) => [initial, () => {}] };
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

it("reports a Scope as not a Git repository only when the host says so, and as a repository when Git State exists", async () => {
  const module = { exports: {} as Record<string, (sessionId: string) => unknown> };
  let sessions: unknown[] = [{ id: "session" }];
  let answer: unknown;
  const states: unknown[] = [];
  let slot = 0;
  const document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
  const code = transformSync(readFileSync(new URL("../web/src/git-state.ts", import.meta.url), "utf8"), { loader: "ts", format: "cjs" }).code;
  runInNewContext(code, { document, module, exports: module.exports, require: (name: string) => {
    if (name === "react") return {
      useEffect: (effect: () => void) => { effect(); },
      useState: (initial: unknown) => { const index = slot++; if (!(index in states)) states[index] = initial; return [states[index], (value: unknown) => { states[index] = value; }]; },
    };
    if (name === "@/agent-sessions.tsx") return { useAgentSessions: () => ({ sessions }), useCommand: () => async () => answer };
    return createRequire(import.meta.url)(name);
  } });
  const repository = () => { slot = 0; return (module.exports.useGitState!("session") as { repository: boolean | undefined }).repository; };
  answer = new Promise(() => {});
  assert.equal(repository(), undefined);
  states.length = 0;
  answer = { repository: false };
  repository();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(repository(), false);
  sessions = [{ id: "session", git: { revision: "r", changed: 0, ahead: 0, behind: 0, upstream: false } }];
  assert.equal(repository(), true);
});
