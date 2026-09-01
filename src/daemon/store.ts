import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { EffortLevel, LoggedEvent } from "../protocol/events.ts";
import type { SessionStatus } from "../protocol/commands.ts";

/**
 * On-disk home of Presentation Transcripts.
 *
 * Layout is one directory per Agent Session:
 *   <root>/sessions/<id>/meta.json        durable facts about the session
 *   <root>/sessions/<id>/transcript.jsonl one LoggedEvent per line, append-only
 *
 * Appends are synchronous. A Presentation Transcript's whole value is that its order is the order
 * things happened, and buffering writes to gain throughput on a single local daemon would trade
 * that away for nothing.
 */

export type SessionMeta = {
  id: string;
  scope: string;
  backend: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Opaque token letting a Backend Adapter continue this Conversation Context. */
  resumeToken?: string;
  modelId?: string;
  effort?: EffortLevel;
  /** Status as of the last write; on load, anything live becomes Dormant. */
  status: SessionStatus;
};

export function defaultStateRoot(): string {
  return process.env["GOODHARNESS_STATE_DIR"] ?? join(homedir(), ".goodharness");
}

export class TranscriptStore {
  private readonly root: string;

  constructor(root: string = defaultStateRoot()) {
    this.root = root;
  }

  sessionDir(sessionId: string): string {
    return join(this.root, "sessions", sessionId);
  }

  /** A directory a Backend Adapter may use for its own session state, beside our transcript. */
  backendDir(sessionId: string): string {
    const dir = join(this.sessionDir(sessionId), "backend");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  writeMeta(meta: SessionMeta): void {
    mkdirSync(this.sessionDir(meta.id), { recursive: true });
    writeFileSync(join(this.sessionDir(meta.id), "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  }

  append(entry: LoggedEvent): void {
    mkdirSync(this.sessionDir(entry.sessionId), { recursive: true });
    appendFileSync(join(this.sessionDir(entry.sessionId), "transcript.jsonl"), `${JSON.stringify(entry)}\n`);
  }

  readEntries(sessionId: string): LoggedEvent[] {
    const path = join(this.sessionDir(sessionId), "transcript.jsonl");
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return [];
    }
    const entries: LoggedEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as LoggedEvent);
      } catch {
        // A torn final line is expected after an unclean shutdown: stop at the last good entry.
        break;
      }
    }
    return entries;
  }

  readMeta(sessionId: string): SessionMeta | undefined {
    try {
      return JSON.parse(readFileSync(join(this.sessionDir(sessionId), "meta.json"), "utf8")) as SessionMeta;
    } catch {
      return undefined;
    }
  }

  /**
   * Remove an Agent Session from disk entirely: transcript, meta, and the backend's state dir.
   *
   * This is the one operation that destroys a Presentation Transcript. ADR 0001 makes a transcript
   * append-only so that what a human saw is never quietly altered; removing one wholesale is a
   * different act, and a deliberate one (ADR 0006).
   */
  deleteSession(sessionId: string): void {
    rmSync(this.sessionDir(sessionId), { recursive: true, force: true });
  }

  async listSessionIds(): Promise<string[]> {
    try {
      const entries = await readdir(join(this.root, "sessions"), { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return [];
    }
  }
}
