import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { projectKey } from "../backend/worker/claude-state.ts";
import type { AgentEvent } from "../protocol/events.ts";
import type { ImportableConversation } from "../protocol/imports.ts";

/**
 * Reading Claude Code's own conversation records, for Import (ADR 0039).
 *
 * Claude Code writes one JSONL file per conversation under `<config>/projects/<scope key>/`, keyed
 * by the directory it was started in. That key is the same one Flow's Claude records use
 * (`projectKey`), which is what makes a Scope the natural unit to list by: what is listed here is
 * exactly what a Revive in that Scope could continue.
 *
 * The format is Claude Code's, undocumented, and grows a record type most releases. So this reads
 * leniently in the manner of `TranscriptStore.readEntries` — an unparseable line is skipped, an
 * unknown record type is ignored — and only the handful of shapes below are interpreted at all.
 * Everything else in the file (request blobs, file-history snapshots, permission-mode markers) is
 * the CLI's bookkeeping, and the Presentation Transcript is what a human saw rather than that.
 *
 * Records are taken in file order, not by walking `parentUuid` from the leaf. The walk looks like
 * the faithful choice, since it is how the CLI rebuilds a conversation after a rewind — but the
 * results of parallel tool calls hang off sibling branches of that tree, and a walk silently drops
 * them. Showing an abandoned rewind branch is a smaller lie than a tool call with no result.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The longest title taken from a first prompt, matching the length a rail row can show. */
const TITLE_LENGTH = 80;

/** One conversation, translated: the Agent Events a Presentation Transcript replays, with their times. */
export type ImportedConversation = {
  title: string;
  /** Whether Claude Code named the conversation itself, rather than the title being its first prompt. */
  named: boolean;
  startedAt: string;
  updatedAt: string;
  events: Array<{ at: string; event: AgentEvent }>;
};

/**
 * Store one image a prompt carried and answer the Attachment id that names it, or `undefined` for a
 * media type Flow cannot hold. A callback so this module never learns where an Agent Session lives.
 */
export type StoreImage = (mediaType: string, base64: string) => string | undefined;

/** Claude Code's config root, resolved the way the CLI and `migrateLegacyClaudeState` resolve it. */
export function claudeConfigDir(env: NodeJS.ProcessEnv, scope: string): string {
  return resolve(scope, env.CLAUDE_CONFIG_DIR || join(env.HOME ?? homedir(), ".claude"));
}

/** Where Claude Code keeps the conversations it started in `scope`. */
export function conversationsDir(env: NodeJS.ProcessEnv, scope: string): string {
  return join(claudeConfigDir(env, scope), "projects", projectKey(scope));
}

/**
 * Every conversation Claude Code recorded in `scope`, newest first. Empty when it recorded none.
 *
 * A conversation with no human prompt in it is left out: Claude Code writes a file for a session
 * that was opened and closed again, and offering an empty transcript to import is offering nothing.
 */
export function listClaudeCodeConversations(env: NodeJS.ProcessEnv, scope: string): ImportableConversation[] {
  const dir = conversationsDir(env, scope);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const conversations: ImportableConversation[] = [];
  for (const name of names) {
    const id = name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : "";
    if (!UUID.test(id)) continue;
    let raw: string;
    try {
      raw = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    const fallback = mtimeOf(join(dir, name));
    const translated = translate(parse(raw), fallback, () => undefined);
    const prompts = translated.events.filter(({ event }) => event.type === "turn_started").length;
    if (prompts === 0) continue;
    conversations.push({
      source: "claude-code",
      id,
      title: translated.title,
      startedAt: translated.startedAt,
      updatedAt: translated.updatedAt,
      prompts,
    });
  }
  return conversations.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/**
 * One conversation, translated into Agent Events. Throws when there is no such conversation.
 *
 * The id is checked before it is joined into a path: it arrives over the wire, and a `../` in it
 * would otherwise read whatever JSONL the caller could name.
 */
export function readClaudeCodeConversation(
  env: NodeJS.ProcessEnv,
  scope: string,
  conversationId: string,
  storeImage: StoreImage,
): ImportedConversation {
  if (!UUID.test(conversationId)) throw new Error("Invalid Claude Code conversation id");
  const path = join(conversationsDir(env, scope), `${conversationId}.jsonl`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error("Claude Code conversation not found");
  }
  return translate(parse(raw), mtimeOf(path), storeImage);
}

/** The fields of a Claude Code record this reads. Everything is optional because the format is not ours. */
type ClaudeCodeRecord = {
  type?: string;
  subtype?: string;
  uuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  isApiErrorMessage?: boolean;
  aiTitle?: string;
  summary?: string;
  compactMetadata?: { trigger?: string; preTokens?: number };
  message?: { content?: string | ContentBlock[] };
};

type ContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  source?: { type?: string; media_type?: string; data?: string };
};

function parse(raw: string): ClaudeCodeRecord[] {
  const records: ClaudeCodeRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record: unknown = JSON.parse(line);
      if (record && typeof record === "object") records.push(record as ClaudeCodeRecord);
    } catch {
      // A torn line, most likely the last one of a conversation still being written. Its neighbours
      // are still good, which is the difference from our own append-only transcript.
    }
  }
  return records;
}

/**
 * What a human typed, recovered from the wrapping Claude Code puts around some of it.
 *
 * A slash command is recorded as tags rather than as what was typed, and a `!` shell command's
 * output comes back as a user record of its own. Shown raw, both read as the human having typed
 * markup. So commands are put back the way they were typed, their output becomes a notice — it was
 * the CLI speaking, not the human — and the caveats the CLI adds for the model are dropped.
 */
type Spoken = { kind: "prompt"; text: string } | { kind: "output"; text: string } | undefined;

function spoken(text: string): Spoken {
  const cleaned = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  if (cleaned === "" || cleaned.includes("<local-command-caveat>")) return undefined;
  const command = /<command-name>([\s\S]*?)<\/command-name>/.exec(cleaned)?.[1];
  if (command !== undefined) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(cleaned)?.[1] ?? "";
    return { kind: "prompt", text: `${command.trim()} ${args.trim()}`.trim() };
  }
  const shell = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(cleaned)?.[1];
  if (shell !== undefined) return { kind: "prompt", text: `! ${shell.trim()}` };
  const outputs = [...cleaned.matchAll(/<(local-command-stdout|bash-stdout|bash-stderr)>([\s\S]*?)<\/\1>/g)];
  if (outputs.length > 0) {
    const output = outputs.map((match) => match[2]!.trim()).filter(Boolean).join("\n");
    return output === "" ? undefined : { kind: "output", text: output };
  }
  // Pasted text is kept, but not the frame the CLI draws around it for the model's benefit.
  const unwrapped = cleaned.replace(/<pasted_content\b[^>]*>\n?/g, "").replace(/\n?<\/pasted_content>/g, "").trim();
  return unwrapped === "" ? undefined : { kind: "prompt", text: unwrapped };
}

function translate(records: ClaudeCodeRecord[], fallbackAt: string, storeImage: StoreImage): ImportedConversation {
  const events: ImportedConversation["events"] = [];
  const seen = new Set<string>();
  const openCalls = new Set<string>();
  let turnId: string | undefined;
  let at = fallbackAt;
  let startedAt: string | undefined;
  let titled: string | undefined;
  let firstPrompt: string | undefined;

  const push = (event: AgentEvent) => events.push({ at, event });
  const endTurn = () => {
    if (turnId === undefined) return;
    // A call the file never recorded an answer for — the CLI was quit mid-call, most often. Left
    // open, it would spin forever in a transcript nothing can ever finish.
    for (const callId of openCalls) {
      push({ type: "tool_ended", callId, result: "No result was recorded.", isError: true });
    }
    openCalls.clear();
    push({ type: "turn_ended", turnId, reason: "complete" });
    turnId = undefined;
  };
  const beginTurn = (id: string) => {
    endTurn();
    turnId = id;
    push({ type: "turn_started", turnId: id });
  };

  for (const record of records) {
    if (record.type === "ai-title" && record.aiTitle) titled = record.aiTitle;
    if (record.type === "summary" && record.summary && titled === undefined) titled = record.summary;
    if (record.type !== "user" && record.type !== "assistant" && record.type !== "system") continue;
    if (record.isSidechain || record.isMeta || !record.uuid || seen.has(record.uuid)) continue;
    seen.add(record.uuid);
    if (record.timestamp) {
      at = record.timestamp;
      startedAt ??= record.timestamp;
    }
    const id = record.uuid;

    if (record.type === "system") {
      if (record.subtype === "compact_boundary") {
        push({
          type: "compacted",
          trigger: record.compactMetadata?.trigger === "manual" ? "manual" : "auto",
          before: record.compactMetadata?.preTokens ?? 0,
        });
      }
      continue;
    }

    const content = record.message?.content;
    if (record.type === "user") {
      // The summary that stands in for the conversation after a compaction. The `compacted` marker
      // above already says that happened, and the summary was written for the model, not the human.
      if (record.isCompactSummary) continue;
      const blocks: ContentBlock[] = typeof content === "string" ? [{ type: "text", text: content }] : content ?? [];
      const answering = blocks.some((block) => block.type === "tool_result");
      for (const block of blocks) {
        if (block.type !== "tool_result" || !block.tool_use_id || !openCalls.has(block.tool_use_id)) continue;
        openCalls.delete(block.tool_use_id);
        push({ type: "tool_ended", callId: block.tool_use_id, result: block.content ?? "", isError: block.is_error === true });
      }
      const texts: string[] = [];
      for (const block of blocks) {
        if (block.type !== "text" || !block.text) continue;
        const said = spoken(block.text);
        if (said?.kind === "output") push({ type: "notice", level: "info", text: said.text });
        else if (said) texts.push(said.text);
      }
      const attachments = blocks.flatMap((block) =>
        block.type === "image" && block.source?.type === "base64" && block.source.media_type && block.source.data
          ? [storeImage(block.source.media_type, block.source.data)].filter((stored): stored is string => stored !== undefined)
          : []);
      if (texts.length === 0 && attachments.length === 0) continue;
      const text = texts.join("\n\n");
      // Words beside a tool result were sent while the turn was running: a steer, not a new turn.
      if (!answering) {
        firstPrompt ??= text;
        beginTurn(id);
      }
      // After `turn_started`, which is the reverse of what a live turn records. A live prompt is
      // logged by the host before the backend says it began; here both are known at once, and the
      // order the reducer needs is only that the message lands inside the turn it opened.
      push({ type: "user_message", id, text, ...(attachments.length ? { attachments } : {}) });
      continue;
    }

    // An assistant record with no open turn is the model speaking first — a resumed conversation
    // whose prompt lives in an earlier file. It still needs a turn to land in.
    if (turnId === undefined) beginTurn(id);
    if (typeof content === "string") {
      if (content.trim()) push({ type: "message", id, text: content, final: true });
      continue;
    }
    for (const [index, block] of (content ?? []).entries()) {
      const blockId = `${id}:${index}`;
      if (record.isApiErrorMessage && block.type === "text" && block.text) {
        push({ type: "notice", level: "error", text: block.text });
      } else if (block.type === "text" && block.text?.trim()) {
        push({ type: "message", id: blockId, text: block.text, final: true });
      } else if (block.type === "thinking" && block.thinking?.trim()) {
        // Often empty: the API redacts reasoning to a signature, and an empty block is noise.
        push({ type: "thinking", id: blockId, text: block.thinking, final: true });
      } else if (block.type === "tool_use" && block.id && block.name) {
        openCalls.add(block.id);
        push({ type: "tool_started", callId: block.id, name: block.name, input: block.input ?? {} });
      }
    }
  }
  endTurn();

  return {
    title: titled ?? titleFrom(firstPrompt) ?? "Imported Claude Code conversation",
    named: titled !== undefined,
    startedAt: startedAt ?? fallbackAt,
    updatedAt: at,
    events,
  };
}

function titleFrom(prompt: string | undefined): string | undefined {
  const line = prompt?.split("\n").map((part) => part.trim()).find(Boolean);
  if (!line) return undefined;
  return line.length <= TITLE_LENGTH ? line : `${line.slice(0, TITLE_LENGTH - 1)}…`;
}

function mtimeOf(path: string): string {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return new Date().toISOString();
  }
}
