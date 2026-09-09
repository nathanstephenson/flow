import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { ATTACHMENT_MEDIA_TYPES, type AttachmentMediaType } from "../protocol/attachments.ts";
import type { EffortLevel, LoggedEvent } from "../protocol/events.ts";
import type { SessionStatus } from "../protocol/commands.ts";

/**
 * On-disk home of Presentation Transcripts.
 *
 * Layout is one directory per Agent Session:
 *   <root>/sessions/<id>/meta.json        durable facts about the session
 *   <root>/sessions/<id>/transcript.jsonl one LoggedEvent per line, append-only
 *   <root>/sessions/<id>/attachments/<id> one Attachment's bytes, named by the id the transcript uses
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
  /**
   * The worktree this Agent Session's Scope *is*, when the Session Host made it. Absent for a Scope
   * its owner named, which is every session before worktrees existed and most sessions after.
   *
   * Recorded rather than worked out from the Scope's path. Deriving it — "does this Scope sit
   * beneath `<root>/worktrees`" — would be shorter, and is how `Project.group` is derived, but the
   * two questions are not alike: a wrong group shows a wrong heading, while a wrong answer here
   * runs `git worktree remove` on a directory nobody asked us to own. The state root is an
   * environment variable and can differ between the daemon that created a worktree and the one that
   * reaps it, and a Scope beneath it can be typed by hand, since `/api/directories` completes paths
   * anywhere on the machine. So the prefix is both losable and forgeable, while a fact written once
   * by the code that ran `git worktree add` is neither.
   *
   * `repo` cannot be recovered from the path at all — the segment there is the repository's
   * *basename* — and `branch` is flattened on its way into the path, so both are written down.
   */
  worktree?: { path: string; repo: string; branch: string };
};

export function defaultStateRoot(): string {
  return process.env["FLOW_STATE_DIR"] ?? join(homedir(), ".flow");
}

export class TranscriptStore {
  private readonly root: string;

  constructor(root: string = defaultStateRoot()) {
    this.root = root;
  }

  sessionDir(sessionId: string): string {
    return join(this.root, "sessions", sessionId);
  }

  /**
   * Where host-created worktrees live: `<root>/worktrees/<repo>/<branch>`.
   *
   * Beneath the state root so the Session Host plainly owns them — a directory it made and may
   * later remove must not sit among the ones its owner is curating, and a worktree beside its
   * repository would be offered as a Candidate, which is the self-growing noise ADR 0011 exists to
   * prevent. A sibling of `sessions/` rather than a child of one, which is also why
   * `deleteSession` can never remove a worktree as a side effect.
   *
   * Nested by repository so the leading segments read as `repo/branch` to a client showing a
   * Scope's last two, and so two repositories that both have a `main` do not fight over one
   * directory.
   */
  worktreesRoot(): string {
    return join(this.root, "worktrees");
  }

  /** A directory a Backend Adapter may use for its own session state, beside our transcript. */
  backendDir(sessionId: string): string {
    const dir = join(this.sessionDir(sessionId), "backend");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Where an Agent Session's Attachments live, beside its transcript rather than in a store of their
   * own. That siting is what makes them last exactly as long as the record that refers to them:
   * `deleteSession` already removes the whole directory, so a Reap (ADR 0006) takes them with it and
   * no attachment can outlive the transcript that is the only thing naming it.
   */
  attachmentsDir(sessionId: string): string {
    return join(this.sessionDir(sessionId), "attachments");
  }

  /**
   * Write one Attachment and return the id that names it.
   *
   * Stored decoded, so the HTTP route can hand the bytes to an `<img>` without re-reading them
   * through a decoder — the base64 an SDK wants is rebuilt at dispatch instead, which happens once
   * per turn where a render happens on every scroll.
   */
  writeAttachment(sessionId: string, mediaType: AttachmentMediaType, base64: string): string {
    const id = `${randomUUID()}.${ATTACHMENT_MEDIA_TYPES[mediaType]}`;
    const dir = this.attachmentsDir(sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, id), Buffer.from(base64, "base64"));
    return id;
  }

  /** One Attachment's bytes, or `undefined` if nothing is stored under that id. */
  readAttachment(sessionId: string, attachmentId: string): Buffer | undefined {
    try {
      return readFileSync(join(this.attachmentsDir(sessionId), attachmentId));
    } catch {
      return undefined;
    }
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
