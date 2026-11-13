import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listClaudeCodeConversations, readClaudeCodeConversation } from "../src/daemon/claude-code-import.ts";
import type { AgentEvent } from "../src/protocol/events.ts";
import {
  CONVERSATION,
  OTHER_CONVERSATION,
  ordinaryConversation,
  prompt,
  reply,
  writeConversation,
} from "./claude-code-fixture.ts";

/** Reading Claude Code's conversation records into Agent Events (ADR 0039). */
describe("Claude Code import translation", () => {
  let root: string;
  let scope: string;
  let config: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "flow-import-")));
    scope = join(root, "project");
    config = join(root, "claude");
    mkdirSync(scope);
    env = { CLAUDE_CONFIG_DIR: config, HOME: root };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const events = (id = CONVERSATION): AgentEvent[] =>
    readClaudeCodeConversation(env, scope, id, () => undefined).events.map(({ event }) => event);

  it("translates prompts, tool calls and replies into turns", () => {
    writeConversation(config, scope, CONVERSATION, ordinaryConversation());
    assert.deepEqual(
      events().map((event) => event.type),
      [
        "turn_started", "user_message", "tool_started", "tool_ended", "message", "turn_ended",
        "turn_started", "user_message", "message", "turn_ended",
      ],
      "bookkeeping, meta caveats, redacted reasoning and sidechains are not what a human saw",
    );
  });

  it("recovers what the human typed from the CLI's wrapping", () => {
    writeConversation(config, scope, CONVERSATION, ordinaryConversation());
    const said = events().flatMap((event) => event.type === "user_message" ? [event.text] : []);
    assert.deepEqual(said, ["Fix the failing test", "/review src/app.ts"]);
  });

  it("takes the title Claude Code gave the conversation", () => {
    writeConversation(config, scope, CONVERSATION, ordinaryConversation());
    const conversation = readClaudeCodeConversation(env, scope, CONVERSATION, () => undefined);
    assert.equal(conversation.title, "Fix failing test");
    assert.equal(conversation.named, true);
  });

  it("falls back to the first prompt's opening line for a title", () => {
    writeConversation(config, scope, CONVERSATION, [prompt("u1", "\n\nPort the parser\nand its tests"), reply("a1", [{ type: "text", text: "Done." }])]);
    const conversation = readClaudeCodeConversation(env, scope, CONVERSATION, () => undefined);
    assert.equal(conversation.title, "Port the parser");
    assert.equal(conversation.named, false);
  });

  it("keeps the results of parallel tool calls", () => {
    // Claude Code hangs each result off its own branch of the parentUuid tree. Reading in file order
    // is what keeps every one of them.
    writeConversation(config, scope, CONVERSATION, [
      prompt("u1", "Look around"),
      reply("a1", [{ type: "tool_use", id: "t1", name: "Read", input: { path: "a" } }], { parentUuid: "u1" }),
      reply("a2", [{ type: "tool_use", id: "t2", name: "Read", input: { path: "b" } }], { parentUuid: "a1" }),
      prompt("u2", [{ type: "tool_result", tool_use_id: "t1", content: "A" }], { parentUuid: "a1" }),
      prompt("u3", [{ type: "tool_result", tool_use_id: "t2", content: "B" }], { parentUuid: "a2" }),
    ]);
    const ended = events().flatMap((event) => event.type === "tool_ended" ? [[event.callId, event.result]] : []);
    assert.deepEqual(ended, [["t1", "A"], ["t2", "B"]]);
  });

  it("closes a call the file never answered rather than leaving it running", () => {
    writeConversation(config, scope, CONVERSATION, [
      prompt("u1", "Run it"),
      reply("a1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 100" } }]),
    ]);
    const ended = events().find((event) => event.type === "tool_ended");
    assert.deepEqual(ended, { type: "tool_ended", callId: "t1", result: "No result was recorded.", isError: true });
  });

  it("records words sent beside a tool result as a steer inside the running turn", () => {
    writeConversation(config, scope, CONVERSATION, [
      prompt("u1", "Build it"),
      reply("a1", [{ type: "tool_use", id: "t1", name: "Bash", input: {} }]),
      prompt("u2", [{ type: "tool_result", tool_use_id: "t1", content: "ok" }, { type: "text", text: "use pnpm" }]),
    ]);
    const types = events().map((event) => event.type);
    assert.equal(types.filter((type) => type === "turn_started").length, 1);
    assert.equal(types.filter((type) => type === "user_message").length, 2);
  });

  it("turns shell output into a notice and a compaction into its marker", () => {
    writeConversation(config, scope, CONVERSATION, [
      prompt("u1", "<bash-input>ls</bash-input>"),
      prompt("u2", "<bash-stdout>README.md</bash-stdout><bash-stderr></bash-stderr>"),
      { type: "system", subtype: "compact_boundary", uuid: "s1", compactMetadata: { trigger: "manual", preTokens: 1200 } },
      prompt("u3", "This session is being continued from a previous conversation…", { isCompactSummary: true }),
    ]);
    const translated = events();
    const typed = translated.find((event) => event.type === "user_message");
    assert.equal(typed?.type === "user_message" ? typed.text : undefined, "! ls");
    assert.deepEqual(translated.find((event) => event.type === "notice"), { type: "notice", level: "info", text: "README.md" });
    assert.deepEqual(translated.find((event) => event.type === "compacted"), { type: "compacted", trigger: "manual", before: 1200 });
    assert.equal(translated.filter((event) => event.type === "user_message").length, 1, "the compaction summary was written for the model");
  });

  it("stores a prompt's images through the callback and refers to them by id", () => {
    writeConversation(config, scope, CONVERSATION, [
      prompt("u1", [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
        { type: "image", source: { type: "base64", media_type: "image/tiff", data: "AAAA" } },
        { type: "text", text: "What is this?" },
      ]),
    ]);
    const stored: string[] = [];
    const conversation = readClaudeCodeConversation(env, scope, CONVERSATION, (mediaType) => {
      stored.push(mediaType);
      return mediaType === "image/png" ? "image-1.png" : undefined;
    });
    assert.deepEqual(stored, ["image/png", "image/tiff"]);
    const message = conversation.events.find(({ event }) => event.type === "user_message")?.event;
    assert.deepEqual(message, { type: "user_message", id: "u1", text: "What is this?", attachments: ["image-1.png"] });
  });

  it("skips a torn line and a duplicated record", () => {
    const path = writeConversation(config, scope, CONVERSATION, [prompt("u1", "Hello"), reply("a1", [{ type: "text", text: "Hi" }])]);
    appendFileSync(path, `${JSON.stringify(reply("a1", [{ type: "text", text: "Hi" }]))}\n{"type":"assistant","uu`);
    assert.equal(events().filter((event) => event.type === "message").length, 1);
  });

  it("keeps original times on the events it translates", () => {
    writeConversation(config, scope, CONVERSATION, ordinaryConversation());
    const conversation = readClaudeCodeConversation(env, scope, CONVERSATION, () => undefined);
    const times = conversation.events.map(({ at }) => at);
    assert.ok(times.every((at) => at.startsWith("2026-11-01")), "an import is not something that happened today");
    assert.equal(conversation.startedAt, times[0]);
  });

  it("refuses an id that is not a UUID before touching the filesystem", () => {
    assert.throws(() => readClaudeCodeConversation(env, scope, "../../etc/passwd", () => undefined), /Invalid Claude Code conversation id/);
    assert.throws(() => readClaudeCodeConversation(env, scope, OTHER_CONVERSATION, () => undefined), /not found/);
  });

  it("lists a Scope's conversations newest first, without the empty ones", () => {
    writeConversation(config, scope, CONVERSATION, ordinaryConversation());
    writeConversation(config, scope, OTHER_CONVERSATION, [prompt("u9", "Later work"), reply("a9", [{ type: "text", text: "Sure" }])]);
    writeConversation(config, scope, "11111111-1111-4111-8111-111111111111", [{ type: "permission-mode", permissionMode: "auto" }]);
    const listed = listClaudeCodeConversations(env, scope);
    assert.deepEqual(listed.map(({ id, title, prompts }) => ({ id, title, prompts })), [
      { id: OTHER_CONVERSATION, title: "Later work", prompts: 1 },
      { id: CONVERSATION, title: "Fix failing test", prompts: 2 },
    ]);
  });

  it("lists nothing for a Scope Claude Code never ran in", () => {
    assert.deepEqual(listClaudeCodeConversations(env, scope), []);
  });
});
