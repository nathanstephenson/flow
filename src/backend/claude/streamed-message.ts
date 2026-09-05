import { randomUUID } from "node:crypto";

import type { BackendEvent, Producer } from "../../protocol/events.ts";

/**
 * One assistant message as it arrives: deltas first, then the finished copy, as Agent Events.
 *
 * Its whole job is that those two halves land on the **same id**. `upsert` in src/client/reduce.ts is
 * keyed on kind + id, so an id that changes between the stream and the finish makes the reducer
 * append rather than replace, and the Presentation Transcript keeps both — the partial, forever
 * unfinalised with its caret still blinking, above an identical finished copy. That was a real bug
 * three times over, which is why this is its own module with its own tests rather than four fields on
 * ClaudeSession: the session cannot be constructed without spawning a Claude process, and none of
 * this was reachable from a test while it lived there.
 *
 * A stranded caret is the diagnostic: `final: false` on an Entry that is not the last one can only
 * mean a partial nothing reconciled.
 */

/** The SDK's content-block union, narrowed to the two fields this reads. */
export type ContentBlock = { type: string; text?: string | undefined; thinking?: string | undefined };

/**
 * Reasoning and text share the SDK's content-block index space, so both live in one map with thinking
 * offset above this — and every read of that map has to say which half it wants. Joining the whole
 * map is what once appended a message's own reasoning to its visible text, which reads as the reply
 * saying itself twice.
 */
const THINKING_KEY = 10_000;

export class StreamedMessage {
  private parts = new Map<number, string>();
  private id: string | undefined;
  /**
   * Spread onto every event this emits. Held here rather than applied by the caller so a message
   * cannot be emitted unattributed by a path that forgot: the producer is fixed for this message's
   * whole life, which is exactly the lifetime of this object.
   */
  private readonly attribution: { producer?: Producer };

  constructor(producer?: Producer) {
    this.attribution = producer === undefined ? {} : { producer };
  }

  /** `message_start`. The SDK does not always carry an id, so one is minted rather than left absent. */
  start(id: string | undefined): void {
    this.parts.clear();
    this.id = id ?? randomUUID();
  }

  text(index: number, delta: string): BackendEvent {
    this.parts.set(index, (this.parts.get(index) ?? "") + delta);
    return {
      type: "message",
      id: this.key(),
      text: this.join((key) => key < THINKING_KEY),
      final: false,
      ...this.attribution,
    };
  }

  /**
   * Joined across blocks rather than emitting only the one just written to: a message with more than
   * one reasoning block would otherwise replace the Entry's text with whichever arrived last.
   */
  thinking(index: number, delta: string): BackendEvent {
    const key = index + THINKING_KEY;
    this.parts.set(key, (this.parts.get(key) ?? "") + delta);
    return { type: "thinking", id: `${this.key()}-thinking`, text: this.reasoning(), final: false, ...this.attribution };
  }

  /**
   * The finished message. `reportedId` is what the SDK called it, and it is used **only** when nothing
   * streamed — otherwise the streamed id wins, because that is the Entry already on screen.
   *
   * Reasoning is finalised here too. It never used to be, so a thinking Entry kept `final: false` for
   * the rest of the Agent Session's life: its caret blinked forever and ThinkingEntryView's clamp,
   * gated on `final`, never engaged.
   */
  finish(reportedId: string, content: readonly ContentBlock[]): BackendEvent[] {
    const id = this.id ?? reportedId;
    const streamed = this.reasoning();
    this.parts.clear();
    this.id = undefined;

    const events: BackendEvent[] = [];
    const text = blocks(content, "text", (block) => block.text);
    if (text) events.push({ type: "message", id, text, final: true, ...this.attribution });

    // The streamed text is the fallback for a message the SDK reports no thinking block back for.
    const thinking = blocks(content, "thinking", (block) => block.thinking) || streamed;
    if (thinking) events.push({ type: "thinking", id: `${id}-thinking`, text: thinking, final: true, ...this.attribution });
    return events;
  }

  /**
   * The id the stream is writing under, minted on first use. Deltas can arrive without a preceding
   * `message_start`, and the constant placeholder that used to stand in for that case could never
   * match the finished message's id — which is the same bug this class exists to prevent.
   */
  private key(): string {
    this.id ??= randomUUID();
    return this.id;
  }

  private reasoning(): string {
    return this.join((key) => key >= THINKING_KEY);
  }

  private join(keep: (key: number) => boolean): string {
    return [...this.parts.entries()]
      .filter(([key]) => keep(key))
      .sort(([a], [b]) => a - b)
      .map(([, value]) => value)
      .join("");
  }
}

/**
 * One StreamedMessage per producer, so a Delegation's stream cannot disturb its parent's.
 *
 * A single StreamedMessage cannot serve two producers: `start()` clears `parts` and overwrites `id`,
 * so a Delegation's `message_start` arriving mid-parent-message takes the id the parent's Entry is
 * already on screen under, and the parent's accumulated text is discarded. That is the same stranded
 * caret this module exists to prevent, reached by a second writer rather than by a changing id.
 *
 * Producers are keyed by the SDK's `parent_tool_use_id`, with `""` for the Agent Session's own model.
 */
export class StreamedMessages {
  private readonly byProducer = new Map<string, StreamedMessage>();

  for(producer: string): StreamedMessage {
    const existing = this.byProducer.get(producer);
    if (existing) return existing;
    const created = new StreamedMessage(producer === "" ? undefined : { delegationId: producer });
    this.byProducer.set(producer, created);
    return created;
  }

  /** Finishes this producer's message and forgets it, so a producer that never speaks again leaks nothing. */
  finish(producer: string, reportedId: string, content: readonly ContentBlock[]): BackendEvent[] {
    const events = this.for(producer).finish(reportedId, content);
    this.byProducer.delete(producer);
    return events;
  }
}

function blocks(
  content: readonly ContentBlock[],
  type: string,
  read: (block: ContentBlock) => string | undefined,
): string {
  return content
    .filter((block) => block.type === type)
    .map((block) => read(block) ?? "")
    .join("");
}
