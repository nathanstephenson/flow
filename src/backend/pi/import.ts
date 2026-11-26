import { readdirSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { writePiSession } from "./state.ts";
import type { AgentEvent, TurnEndReason } from "../../protocol/events.ts";
import type { ImportableConversation } from "../../protocol/imports.ts";
import type { ImportedConversation, StoreImage } from "../types.ts";

/**
 * Reading standalone pi sessions, for Import (ADR 0047).
 *
 * pi writes one JSONL file per session under `<agent dir>/sessions/<scope key>/`: a `session` header,
 * then entries that form a tree through `parentId`. The tree is pi's own record of branching, so the
 * transcript is the active branch only, the path from the last entry back to the root, which is the
 * one a Revive continues. The file is read leniently, and never through pi's SessionManager, which
 * creates directories and can rewrite what it opens.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The longest title taken from a first prompt, matching the length a rail row can show. */
const TITLE_LENGTH = 80;

/** The longest notice taken from shell output or an extension's message. */
const NOTICE_LENGTH = 500;

/** Where pi keeps the sessions it started in `scope`, resolved the way pi resolves it. */
export function piSessionsDir(env: NodeJS.ProcessEnv, scope: string): string {
  const agentDir = resolve(env.PI_CODING_AGENT_DIR || join(env.HOME ?? homedir(), ".pi/agent"));
  return join(agentDir, "sessions", `--${resolve(scope).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

/** Every pi session recorded in `scope` with a prompt in it, newest first. Only prompts and titles are parsed. */
export async function listPiConversations(env: NodeJS.ProcessEnv, scope: string): Promise<ImportableConversation[]> {
  const dir = piSessionsDir(env, scope);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const conversations: ImportableConversation[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    let raw: string;
    try {
      raw = await readFile(join(dir, name), "utf8");
    } catch {
      continue;
    }
    const header = headerOf(raw, scope);
    if (!header) continue;
    const skimmed = translate(parse(raw, worthListing), header.startedAt, () => undefined);
    const prompts = skimmed.events.filter(({ event }) => event.type === "turn_started").length;
    if (prompts === 0) continue;
    conversations.push({
      id: header.id,
      title: skimmed.title,
      startedAt: skimmed.startedAt,
      updatedAt: lastTimestamp(raw) ?? skimmed.updatedAt,
      prompts,
    });
  }
  return conversations.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/** One pi session's active branch, translated into Agent Events. Throws when there is no such session. */
export function readPiConversation(
  env: NodeJS.ProcessEnv,
  scope: string,
  conversationId: string,
  storeImage: StoreImage,
): ImportedConversation {
  const { raw, startedAt } = findSession(env, scope, conversationId);
  return translate(activeBranch(parse(raw)), startedAt, storeImage);
}

/** Copy one pi session file into `stateDir`, bound to `scope`. Returns `stateDir`, the pi resume token. */
export function copyPiConversation(env: NodeJS.ProcessEnv, stateDir: string, scope: string, conversationId: string): string {
  const { name, raw } = findSession(env, scope, conversationId);
  writePiSession(join(stateDir, name), raw, scope);
  return stateDir;
}

/** The file holding session `id`. The id is checked first because it arrives over the wire. */
function findSession(env: NodeJS.ProcessEnv, scope: string, id: string): { name: string; raw: string; startedAt: string } {
  if (!UUID.test(id)) throw new Error("Invalid pi session id");
  const dir = piSessionsDir(env, scope);
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    throw new Error("pi session not found");
  }
  names.sort((left, right) => Number(right.includes(id)) - Number(left.includes(id)));
  for (const name of names) {
    let raw: string;
    try {
      raw = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    const header = headerOf(raw, scope);
    if (header?.id === id) return { name, raw, startedAt: header.startedAt };
  }
  throw new Error("pi session not found");
}

function headerOf(raw: string, scope: string): { id: string; startedAt: string } | undefined {
  const end = raw.indexOf("\n");
  const [header] = parse(end < 0 ? raw : raw.slice(0, end));
  if (header?.type !== "session" || typeof header.id !== "string" || !UUID.test(header.id)) return undefined;
  if (typeof header.cwd !== "string" || resolve(header.cwd) !== resolve(scope)) return undefined;
  return { id: header.id, startedAt: header.timestamp ?? new Date().toISOString() };
}

/** pi writes compact JSON, so a human prompt and a session name are plain substrings. */
function worthListing(line: string): boolean {
  return line.includes('"role":"user"') || line.includes('"type":"session_info"');
}

function lastTimestamp(raw: string): string | undefined {
  const stamps = [...raw.slice(-65_536).matchAll(/"timestamp":"([^"]+)"/g)];
  return stamps.at(-1)?.[1];
}

/** The fields of a pi entry this reads. Everything is optional because the format is not ours. */
type PiEntry = {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  cwd?: string;
  name?: string;
  tokensBefore?: number;
  display?: boolean;
  content?: unknown;
  message?: {
    role?: string;
    content?: unknown;
    stopReason?: string;
    errorMessage?: string;
    toolCallId?: string;
    details?: unknown;
    isError?: boolean;
    command?: string;
    output?: string;
  };
};

type Block = {
  type?: string;
  text?: string;
  thinking?: string;
  redacted?: boolean;
  data?: string;
  mimeType?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
};

function parse(raw: string, keep: (line: string) => boolean = () => true): PiEntry[] {
  const entries: PiEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim() || !keep(line)) continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (entry && typeof entry === "object") entries.push(entry as PiEntry);
    } catch {
      continue;
    }
  }
  return entries;
}

/** The path from the last entry back to the root, in order. A cycle in a damaged file ends the walk. */
function activeBranch(entries: PiEntry[]): PiEntry[] {
  const byId = new Map(entries.flatMap((entry) => entry.type !== "session" && entry.id ? [[entry.id, entry] as const] : []));
  const branch: PiEntry[] = [];
  let entry = entries.findLast((candidate) => candidate.type !== "session" && candidate.id);
  while (entry) {
    branch.push(entry);
    byId.delete(entry.id!);
    entry = entry.parentId ? byId.get(entry.parentId) : undefined;
  }
  return branch.reverse();
}

function blocksOf(content: unknown): Block[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content.filter((block): block is Block => !!block && typeof block === "object") : [];
}

function textOf(content: unknown): string {
  return blocksOf(content).flatMap((block) => block.type === "text" && block.text ? [block.text] : []).join("\n");
}

function translate(entries: PiEntry[], fallbackAt: string, storeImage: StoreImage): ImportedConversation {
  const events: ImportedConversation["events"] = [];
  const openCalls = new Set<string>();
  let turnId: string | undefined;
  let at = fallbackAt;
  let startedAt: string | undefined;
  let name: string | undefined;
  let firstPrompt: string | undefined;

  const push = (event: AgentEvent) => events.push({ at, event });
  const endTurn = (reason: TurnEndReason = "complete") => {
    if (turnId === undefined) return;
    for (const callId of openCalls) {
      push({ type: "tool_ended", callId, result: "No result was recorded.", isError: true });
    }
    openCalls.clear();
    push({ type: "turn_ended", turnId, reason });
    turnId = undefined;
  };
  const beginTurn = (id: string) => {
    endTurn();
    turnId = id;
    push({ type: "turn_started", turnId: id });
  };

  for (const entry of entries) {
    if (entry.type === "session_info") {
      name = entry.name?.trim() || undefined;
      continue;
    }
    if (!entry.id) continue;
    if (entry.timestamp) {
      at = entry.timestamp;
      startedAt ??= entry.timestamp;
    }
    const id = entry.id;

    if (entry.type === "compaction") {
      push({ type: "compacted", trigger: "auto", before: entry.tokensBefore ?? 0 });
      continue;
    }
    if (entry.type === "custom_message") {
      const text = textOf(entry.content).trim();
      if (entry.display && text) push({ type: "notice", level: "info", text: clip(text) });
      continue;
    }
    const message = entry.message;
    if (entry.type !== "message" || !message) continue;
    const blocks = blocksOf(message.content);

    if (message.role === "user") {
      const text = textOf(message.content);
      const attachments = blocks.flatMap((block) =>
        block.type === "image" && block.mimeType && block.data
          ? [storeImage(block.mimeType, block.data)].filter((stored): stored is string => stored !== undefined)
          : []);
      if (!text.trim() && attachments.length === 0) continue;
      firstPrompt ??= text;
      beginTurn(id);
      push({ type: "user_message", id, text, ...(attachments.length ? { attachments } : {}) });
    } else if (message.role === "assistant") {
      if (turnId === undefined) beginTurn(id);
      for (const [index, block] of blocks.entries()) {
        const blockId = `${id}:${index}`;
        if (block.type === "text" && block.text?.trim()) {
          push({ type: "message", id: blockId, text: block.text, final: true });
        } else if (block.type === "thinking" && !block.redacted && block.thinking?.trim()) {
          push({ type: "thinking", id: blockId, text: block.thinking, final: true });
        } else if (block.type === "toolCall" && block.id && block.name) {
          openCalls.add(block.id);
          push({ type: "tool_started", callId: block.id, name: block.name, input: block.arguments ?? {} });
        }
      }
      if (message.stopReason === "error" && message.errorMessage) push({ type: "notice", level: "error", text: message.errorMessage });
      if (message.stopReason === "aborted" || message.stopReason === "error") endTurn(message.stopReason);
      else if (message.stopReason === "stop" || message.stopReason === "length") endTurn();
    } else if (message.role === "toolResult") {
      if (!message.toolCallId || !openCalls.delete(message.toolCallId)) continue;
      push({
        type: "tool_ended",
        callId: message.toolCallId,
        result: { content: message.content, details: message.details },
        isError: message.isError === true,
      });
    } else if (message.role === "bashExecution" && message.command) {
      push({ type: "notice", level: "info", text: clip(`! ${message.command}\n${message.output ?? ""}`.trim()) });
    }
  }
  endTurn();

  return {
    title: name ?? titleFrom(firstPrompt) ?? "Imported pi session",
    named: name !== undefined,
    startedAt: startedAt ?? fallbackAt,
    updatedAt: at,
    events,
  };
}

function clip(text: string): string {
  return text.length <= NOTICE_LENGTH ? text : `${text.slice(0, NOTICE_LENGTH - 1)}…`;
}

function titleFrom(prompt: string | undefined): string | undefined {
  const line = prompt?.split("\n").map((part) => part.trim()).find(Boolean);
  if (!line) return undefined;
  return line.length <= TITLE_LENGTH ? line : `${line.slice(0, TITLE_LENGTH - 1)}…`;
}
