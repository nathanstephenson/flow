import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { copyPiConversation, listPiConversations, piSessionsDir, readPiConversation } from "../src/backend/pi/import.ts";
import type { AgentEvent } from "../src/protocol/events.ts";

const SESSION = "0f971f93-147c-46c2-984f-c91301183ede";
const EMPTY = "562f1aa3-efa1-4773-b16c-5e145fb58484";

type Entry = Record<string, unknown>;

let clock = Date.parse("2026-11-01T09:00:00.000Z");
const at = () => new Date((clock += 1_000)).toISOString();

const user = (id: string, parentId: string | null, content: unknown): Entry =>
  ({ type: "message", id, parentId, timestamp: at(), message: { role: "user", content, timestamp: 1 } });
const assistant = (id: string, parentId: string | null, content: unknown[], stopReason = "stop"): Entry =>
  ({ type: "message", id, parentId, timestamp: at(), message: { role: "assistant", content, stopReason, timestamp: 1 } });
const toolResult = (id: string, parentId: string, toolCallId: string, text: string): Entry =>
  ({ type: "message", id, parentId, timestamp: at(), message: { role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text }], isError: false, timestamp: 1 } });

describe("pi session import", () => {
  let root: string;
  let scope: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "flow-pi-import-")));
    scope = join(root, "project");
    mkdirSync(scope);
    env = { PI_CODING_AGENT_DIR: join(root, "agent"), HOME: root };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const write = (id: string, entries: Entry[], cwd = scope): string => {
    const dir = piSessionsDir(env, scope);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `2026-11-01T09-00-00-000Z_${id}.jsonl`);
    const header = { type: "session", version: 3, id, timestamp: "2026-11-01T09:00:00.000Z", cwd };
    writeFileSync(path, [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    return path;
  };

  const events = (): AgentEvent[] => readPiConversation(env, scope, SESSION, () => undefined).events.map(({ event }) => event);

  it("lists sessions with prompts and leaves out empty ones", async () => {
    write(SESSION, [user("u1", null, "Fix the parser\nand its tests"), assistant("a1", "u1", [{ type: "text", text: "Done." }])]);
    write(EMPTY, [{ type: "model_change", id: "m1", parentId: null, timestamp: at(), provider: "x", modelId: "y" }]);
    const listed = await listPiConversations(env, scope);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.id, SESSION);
    assert.equal(listed[0]!.title, "Fix the parser");
    assert.equal(listed[0]!.prompts, 1);
  });

  it("shows only the active branch", () => {
    write(SESSION, [
      user("u1", null, "Start"),
      assistant("a1", "u1", [{ type: "text", text: "Abandoned reply" }]),
      assistant("a2", "u1", [{ type: "text", text: "Kept reply" }]),
    ]);
    const said = events().flatMap((event) => event.type === "message" ? [event.text] : []);
    assert.deepEqual(said, ["Kept reply"]);
  });

  it("takes the latest session name as the title", () => {
    write(SESSION, [
      user("u1", null, "Start"),
      { type: "session_info", id: "i1", parentId: "u1", timestamp: at(), name: "Old name" },
      { type: "session_info", id: "i2", parentId: "i1", timestamp: at(), name: "Parser work" },
    ]);
    const conversation = readPiConversation(env, scope, SESSION, () => undefined);
    assert.equal(conversation.title, "Parser work");
    assert.equal(conversation.named, true);
  });

  it("ends answered tool calls with their result and closes unanswered ones as errors", () => {
    write(SESSION, [
      user("u1", null, "Run it"),
      assistant("a1", "u1", [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }], "toolUse"),
      toolResult("r1", "a1", "t1", "README.md"),
      assistant("a2", "r1", [{ type: "toolCall", id: "t2", name: "bash", arguments: { command: "sleep 100" } }], "toolUse"),
    ]);
    const ended = events().flatMap((event) => event.type === "tool_ended" ? [[event.callId, event.isError]] : []);
    assert.deepEqual(ended, [["t1", false], ["t2", true]]);
    assert.equal(events().at(-1)?.type, "turn_ended");
  });

  it("stores a prompt's images through the callback", () => {
    write(SESSION, [user("u1", null, [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }, { type: "text", text: "What is this?" }])]);
    const conversation = readPiConversation(env, scope, SESSION, () => "image-1.png");
    const message = conversation.events.find(({ event }) => event.type === "user_message")?.event;
    assert.deepEqual(message, { type: "user_message", id: "u1", text: "What is this?", attachments: ["image-1.png"] });
  });

  it("refuses an invalid or unknown id", () => {
    assert.throws(() => readPiConversation(env, scope, "../../etc/passwd", () => undefined), /Invalid/);
    assert.throws(() => readPiConversation(env, scope, SESSION, () => undefined), /not found/);
  });

  it("copies the session bound to the Scope and refuses to overwrite", () => {
    const source = write(SESSION, [user("u1", null, "Start")], scope + "/../project");
    const stateDir = join(root, "state");
    mkdirSync(stateDir);
    assert.equal(copyPiConversation(env, stateDir, scope, SESSION), stateDir);
    const copied = join(stateDir, source.split("/").at(-1)!);
    assert.equal(JSON.parse(readFileSync(copied, "utf8").split("\n")[0]!).cwd, scope);
    assert.equal(statSync(copied).mode & 0o777, 0o600);
    assert.throws(() => copyPiConversation(env, stateDir, scope, SESSION), /EEXIST/);
  });
});
