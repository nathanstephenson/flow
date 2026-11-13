import { readFileSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
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
 *
 * Read asynchronously and only skimmed, because this runs on the Session Host's one thread every
 * time the picker opens. A Scope's files run to a hundred megabytes, nearly all of it request
 * blobs, replies and tool output; parsing all that stalled every live Agent Session's stream for
 * over a second. A listing needs only titles, prompts and times, so only those lines are parsed.
 */
export async function listClaudeCodeConversations(env: NodeJS.ProcessEnv, scope: string): Promise<ImportableConversation[]> {
  const dir = conversationsDir(env, scope);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const conversations: ImportableConversation[] = [];
  for (const name of names) {
    const id = name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : "";
    if (!UUID.test(id)) continue;
    let raw: string;
    try {
      raw = await readFile(join(dir, name), "utf8");
    } catch {
      // Unreadable, or too large to hold as one string: either way not something to offer.
      continue;
    }
    const skimmed = translate(parse(raw, worthListing), mtimeOf(join(dir, name)), () => undefined);
    const prompts = skimmed.events.filter(({ event }) => event.type === "turn_started").length;
    if (prompts === 0) continue;
    conversations.push({
      source: "claude-code",
      id,
      title: skimmed.title,
      startedAt: skimmed.startedAt,
      // The skim leaves out the replies, so its last time is the last prompt's. The file's own last
      // line says when the conversation actually last moved.
      updatedAt: lastTimestamp(raw) ?? skimmed.updatedAt,
      prompts,
    });
  }
  return conversations.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/**
 * Whether a line can change what a listing shows, judged before it is parsed.
 *
 * Claude Code writes compact JSON, so the record type is a plain substring. Titles and human
 * prompts are kept; replies and tool results are not, since neither starts a turn or names one.
 */
function worthListing(line: string): boolean {
  if (line.includes('"type":"user"')) return !line.includes('"tool_result"');
  return line.includes('"type":"ai-title"') || line.includes('"type":"custom-title"')
    || line.includes('"type":"summary"') || line.includes('"queued_command"');
}

function lastTimestamp(raw: string): string | undefined {
  const tail = raw.slice(-65_536);
  const stamps = [...tail.matchAll(/"timestamp":"([^"]+)"/g)];
  return stamps.at(-1)?.[1];
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
  customTitle?: string;
  summary?: string;
  /** Who a `user` record came from. Absent on older records, which were all typed by a human. */
  origin?: { kind?: string };
  /** A prompt typed while a turn ran is recorded as one of these, often with no `user` record at all. */
  attachment?: { type?: string; prompt?: unknown; commandMode?: string; origin?: { kind?: string } };
  /** The structured result of a tool call, beside the `tool_result` block written for the model. */
  toolUseResult?: unknown;
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

function parse(raw: string, keep: (line: string) => boolean = () => true): ClaudeCodeRecord[] {
  const records: ClaudeCodeRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim() || !keep(line)) continue;
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

/** How Claude Code records a turn the human stopped, as the text of a user record. */
const INTERRUPTED = /^\[Request interrupted by user(?: for tool use)?\]\s*/;

/** The tool whose calls are Subagents, under its current name and the one it had before. */
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

/** The longest notice taken from something an agent or a background task said. */
const NOTICE_LENGTH = 500;

function translate(records: ClaudeCodeRecord[], fallbackAt: string, storeImage: StoreImage): ImportedConversation {
  const events: ImportedConversation["events"] = [];
  const seen = new Set<string>();
  const openCalls = new Set<string>();
  /** Subagents still running, by the id of the call that spawned them, with what their card shows. */
  const openSubagents = new Map<string, { name: string; description?: string }>();
  /** Prompts already shown from a `queued_command`, so the `user` record that delivers one later is not shown twice. */
  const queued = new Set<string>();
  let turnId: string | undefined;
  let interrupted = false;
  let at = fallbackAt;
  let startedAt: string | undefined;
  let customTitle: string | undefined;
  let titled: string | undefined;
  let firstPrompt: string | undefined;

  const push = (event: AgentEvent) => events.push({ at, event });
  const settleSubagent = (callId: string, state: "complete" | "error" | "aborted") => {
    const brief = openSubagents.get(callId);
    if (!brief) return;
    openSubagents.delete(callId);
    push({ type: "subagent", subagentId: callId, ...brief, state });
  };
  const endTurn = () => {
    if (turnId === undefined) return;
    // A call the file never recorded an answer for — the CLI was quit mid-call, most often. Left
    // open, it would spin forever in a transcript nothing can ever finish.
    for (const callId of openCalls) {
      push({ type: "tool_ended", callId, result: "No result was recorded.", isError: true });
    }
    openCalls.clear();
    push({ type: "turn_ended", turnId, reason: interrupted ? "aborted" : "complete" });
    turnId = undefined;
    interrupted = false;
  };
  const beginTurn = (id: string) => {
    endTurn();
    turnId = id;
    push({ type: "turn_started", turnId: id });
  };
  /** Something a human said: a new turn when none is running, otherwise a steer inside it. */
  const said = (id: string, text: string, attachments: string[], steering: boolean) => {
    if (!steering || turnId === undefined) {
      firstPrompt ??= text;
      beginTurn(id);
    }
    // After `turn_started`, which is the reverse of what a live turn records. A live prompt is
    // logged by the host before the backend says it began; here both are known at once, and the
    // order the reducer needs is only that the message lands inside the turn it opened.
    push({ type: "user_message", id, text, ...(attachments.length ? { attachments } : {}) });
  };

  for (const record of records) {
    if (record.type === "custom-title" && record.customTitle) customTitle = record.customTitle;
    if (record.type === "ai-title" && record.aiTitle) titled = record.aiTitle;
    if (record.type === "summary" && record.summary && titled === undefined) titled = record.summary;
    const queuedPrompt = record.type === "attachment" && record.attachment?.type === "queued_command"
      // A background task's notification is queued the same way, told apart only by its mode.
      && (record.attachment.commandMode ?? "prompt") === "prompt"
      && (record.attachment.origin?.kind ?? "human") === "human" && typeof record.attachment.prompt === "string"
      ? record.attachment.prompt
      : undefined;
    if (record.type !== "user" && record.type !== "assistant" && record.type !== "system" && queuedPrompt === undefined) continue;
    if (record.isSidechain || record.isMeta || !record.uuid || seen.has(record.uuid)) continue;
    seen.add(record.uuid);
    if (record.timestamp) {
      at = record.timestamp;
      startedAt ??= record.timestamp;
    }
    const id = record.uuid;

    if (queuedPrompt !== undefined) {
      // Typed while a turn ran. Claude Code hands it to the model inside that turn and frequently
      // never writes it as a `user` record, so this is the only place the human's words survive.
      const typed = spoken(queuedPrompt);
      if (typed?.kind !== "prompt") continue;
      queued.add(typed.text);
      said(id, typed.text, [], true);
      continue;
    }

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
        const isError = block.is_error === true;
        push({ type: "tool_ended", callId: block.tool_use_id, result: block.content ?? "", isError });
        // A backgrounded Subagent answers at once with a launch receipt; its card stays running
        // until the task notification that reports how it ended.
        if (!isAsyncLaunch(record.toolUseResult)) settleSubagent(block.tool_use_id, isError ? "error" : "complete");
      }
      const texts = blocks.flatMap((block) => block.type === "text" && block.text ? [block.text] : []);
      // Not every `user` record is the human. A background task finishing, or another agent
      // reporting back, arrives the same way; showing it as typed would put words in their mouth.
      const from = record.origin?.kind ?? "human";
      if (from !== "human") {
        const text = texts.join("\n");
        if (from === "task-notification") {
          const callId = /<tool-use-id>([\s\S]*?)<\/tool-use-id>/.exec(text)?.[1]?.trim();
          const status = /<status>([\s\S]*?)<\/status>/.exec(text)?.[1]?.trim();
          if (callId) settleSubagent(callId, status === "completed" ? "complete" : status === "failed" ? "error" : "aborted");
          const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]?.trim();
          push({ type: "notice", level: "info", text: summary || "A background task finished." });
        } else {
          const plain = text.replace(/<[^>]+>/g, "").trim();
          if (plain) push({ type: "notice", level: "info", text: clip(plain) });
        }
        continue;
      }
      const words: string[] = [];
      for (const raw of texts) {
        const marker = INTERRUPTED.exec(raw);
        if (marker) interrupted = true;
        const typed = spoken(marker ? raw.slice(marker[0].length) : raw);
        if (typed?.kind === "output") push({ type: "notice", level: "info", text: typed.text });
        else if (typed) words.push(typed.text);
      }
      const attachments = blocks.flatMap((block) =>
        block.type === "image" && block.source?.type === "base64" && block.source.media_type && block.source.data
          ? [storeImage(block.source.media_type, block.source.data)].filter((stored): stored is string => stored !== undefined)
          : []);
      if (words.length === 0 && attachments.length === 0) continue;
      const text = words.join("\n\n");
      // Already shown when it was typed. The turn it starts is still a turn, so it is opened.
      if (attachments.length === 0 && queued.delete(text)) {
        if (!answering) beginTurn(id);
        continue;
      }
      // Words beside a tool result were sent while the turn was running: a steer, not a new turn.
      said(id, text, attachments, answering);
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
        // The card a live Revive would show for the same call, so an imported Subagent does not
        // look different from one spawned after the import.
        if (SUBAGENT_TOOLS.has(block.name)) {
          const brief = briefOf(block.name, block.input);
          openSubagents.set(block.id, brief);
          push({ type: "subagent", subagentId: block.id, ...brief, state: "running" });
        }
      }
    }
  }
  endTurn();
  // Still running when the file stops: whatever became of them was never written down here.
  for (const callId of [...openSubagents.keys()]) settleSubagent(callId, "aborted");

  const named = customTitle ?? titled;
  return {
    title: named ?? titleFrom(firstPrompt) ?? "Imported Claude Code conversation",
    named: named !== undefined,
    startedAt: startedAt ?? fallbackAt,
    updatedAt: at,
    events,
  };
}

/** What a Subagent's card shows, read as the live adapter reads it: its type, then its task. */
function briefOf(tool: string, input: unknown): { name: string; description?: string } {
  const fields = (input ?? {}) as { subagent_type?: unknown; description?: unknown };
  const name = typeof fields.subagent_type === "string" ? fields.subagent_type : tool;
  return typeof fields.description === "string" ? { name, description: fields.description } : { name };
}

/** Whether a Subagent's tool result is a launch receipt rather than its answer — see the live adapter's. */
function isAsyncLaunch(result: unknown): boolean {
  const status = (result as { status?: unknown } | null | undefined)?.status;
  return status === "async_launched" || status === "remote_launched";
}

function clip(text: string): string {
  return text.length <= NOTICE_LENGTH ? text : `${text.slice(0, NOTICE_LENGTH - 1)}…`;
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
