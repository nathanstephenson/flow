import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { projectKey } from "../src/backend/worker/claude-state.ts";
import { FakeBackend } from "../src/backend/fake/index.ts";
import { reduceAll } from "../src/client/reduce.ts";
import { CommandRefused, SessionHost } from "../src/daemon/host.ts";
import { TranscriptStore } from "../src/daemon/store.ts";
import { CONVERSATION, OTHER_CONVERSATION, ordinaryConversation, prompt, reply, writeConversation } from "./claude-code-fixture.ts";

/** Import: Agent Sessions made from Claude Code conversations (ADR 0039). */
describe("import", () => {
  let root: string;
  let scope: string;
  let config: string;
  let store: TranscriptStore;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "flow-import-host-")));
    scope = join(root, "project");
    config = join(root, "claude");
    mkdirSync(scope);
    store = new TranscriptStore(join(root, "state"));
    writeConversation(config, scope, CONVERSATION, ordinaryConversation());
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A fake that answers to `claude`, since an import is always continued by that adapter. */
  async function freshHost(): Promise<{ host: SessionHost; backend: FakeBackend }> {
    const backend = new FakeBackend();
    Object.defineProperty(backend, "name", { value: "claude" });
    const host = new SessionHost({ store, importEnv: { CLAUDE_CONFIG_DIR: config, HOME: root } });
    host.registerBackend(backend);
    await host.load();
    return { host, backend };
  }

  const importAs = (host: SessionHost, mode: "continue" | "view", conversationId = CONVERSATION) =>
    host.execute({ type: "import", source: "claude-code", scope, conversationId, mode }) as Promise<string>;

  it("imports a conversation to continue as a Dormant Agent Session", async () => {
    const { host } = await freshHost();
    const id = await importAs(host, "continue");

    const summary = host.list().find((session) => session.id === id);
    assert.equal(summary?.status, "dormant");
    assert.equal(summary?.title, "Fix failing test");
    assert.equal(summary?.scope, scope);
    const state = reduceAll(host.logFor(id).since(0));
    assert.deepEqual(
      state.entries.filter((entry) => entry.kind === "user").map((entry) => entry.kind === "user" ? entry.text : ""),
      ["Fix the failing test", "/review src/app.ts"],
    );
    const tool = state.entries.find((entry) => entry.kind === "tool");
    assert.equal(tool?.kind === "tool" ? tool.status : undefined, "complete");
    assert.equal(store.readMeta(id)?.resumeToken, CONVERSATION);
  });

  it("copies the Conversation Context into the Agent Session's own records", async () => {
    const { host } = await freshHost();
    const id = await importAs(host, "continue");
    const owned = join(store.sessionDir(id), "backend", "claude-projects", projectKey(scope));
    assert.deepEqual(readdirSync(owned), [`${CONVERSATION}.jsonl`], "exactly the one conversation, and nothing else from the source");
  });

  it("Revives an imported Agent Session onto the imported conversation", async () => {
    const { host, backend } = await freshHost();
    const id = await importAs(host, "continue");
    await host.send(id, "carry on", "now");

    assert.equal(backend.latest.resumedFrom, CONVERSATION);
    const events = host.logFor(id).since(0).map(({ event }) => event.type);
    assert.ok(events.indexOf("capabilities_changed") > events.indexOf("revived"),
      "the transcript opened with no models, so the first Revive reports the real ones");
    assert.ok((reduceAll(host.logFor(id).since(0)).capabilities?.models.length ?? 0) > 0);
  });

  it("imports a conversation to read as an Ended Agent Session", async () => {
    const { host } = await freshHost();
    const id = await importAs(host, "view");

    assert.equal(host.list().find((session) => session.id === id)?.status, "ended");
    assert.equal(store.readMeta(id)?.resumeToken, undefined);
    assert.equal(existsSync(join(store.sessionDir(id), "backend")), false, "a read-only import copies no Conversation Context");
    await assert.rejects(host.revive(id), /has ended/);
  });

  it("allows a read-only import on a host without the claude adapter", async () => {
    const host = new SessionHost({ store, importEnv: { CLAUDE_CONFIG_DIR: config, HOME: root } });
    await host.load();
    await assert.rejects(importAs(host, "continue"), CommandRefused);
    assert.deepEqual(host.list(), []);
    const id = await importAs(host, "view");
    assert.equal(host.list().find((session) => session.id === id)?.status, "ended");
  });

  it("survives a Session Host restart", async () => {
    const first = await freshHost();
    const id = await importAs(first.host, "continue");
    await first.host.shutdown();

    const second = await freshHost();
    const summary = second.host.list().find((session) => session.id === id);
    assert.equal(summary?.status, "dormant");
    assert.equal(summary?.title, "Fix failing test");
    assert.equal(store.readMeta(id)?.imported?.conversationId, CONVERSATION);
  });

  it("lists a Scope's conversations and says which were already imported", async () => {
    writeConversation(config, scope, OTHER_CONVERSATION, [prompt("u9", "Later work"), reply("a9", [{ type: "text", text: "Sure" }])]);
    const { host } = await freshHost();
    const id = await importAs(host, "view");

    const listed = await host.execute({ type: "list_imports", source: "claude-code", scope }) as Array<{ id: string; importedAs?: string }>;
    assert.deepEqual(listed.map(({ id: conversation, importedAs }) => ({ conversation, importedAs })), [
      { conversation: OTHER_CONVERSATION, importedAs: undefined },
      { conversation: CONVERSATION, importedAs: id },
    ]);
  });

  it("does not offer Flow's own legacy Claude records back to it", async () => {
    const { host } = await freshHost();
    const id = await host.create({ scope, backend: "claude" });
    await host.shutdown();
    // What a pre-isolation Agent Session left behind: its resume token naming a global record.
    // Written after shutdown, which persists the fake's own token over anything written before.
    store.writeMeta({ ...store.readMeta(id)!, resumeToken: CONVERSATION });

    const second = await freshHost();
    const listed = await second.host.execute({ type: "list_imports", source: "claude-code", scope }) as Array<{ id: string }>;
    assert.deepEqual(listed, []);
  });

  it("refuses a conversation that does not exist and leaves nothing behind", async () => {
    const { host } = await freshHost();
    const before = host.list().length;
    await assert.rejects(importAs(host, "continue", OTHER_CONVERSATION), CommandRefused);
    await assert.rejects(importAs(host, "view", "../../escape"), /Invalid Claude Code conversation id/);
    assert.equal(host.list().length, before);
    assert.deepEqual(await store.listSessionIds(), []);
  });
});
