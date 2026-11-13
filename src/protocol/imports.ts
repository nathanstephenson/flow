/**
 * Import: an Agent Session made from a conversation another tool recorded (ADR 0039).
 *
 * Only Claude Code today. The source is named on the wire anyway, so a second one is a new member
 * of a union rather than a change to every command that already assumes there is only one.
 */
export type ImportSource = "claude-code";

/**
 * What the imported Agent Session may do afterwards.
 *
 * `continue` carries the Conversation Context with it, so the Agent Session is Dormant and the next
 * message Revives it onto the conversation the model already had. `view` brings the Presentation
 * Transcript alone and Ends the Agent Session: readable, never Revived, never Reaped.
 */
export type ImportMode = "continue" | "view";

/** One conversation a Scope's source tool recorded, as the import picker lists it. */
export type ImportableConversation = {
  source: ImportSource;
  /** The source's own id for the conversation. For Claude Code, its session UUID. */
  id: string;
  /** The source's own title where it wrote one, otherwise the first prompt's opening line. */
  title: string;
  startedAt: string;
  updatedAt: string;
  /** Human turns, not records: the number a reader would recognise as the conversation's length. */
  prompts: number;
  /**
   * The Agent Session already imported from this conversation, if there is one.
   *
   * Reported rather than refused at listing time, because importing again is legitimate: the
   * conversation may have carried on in its source since. The picker says so instead of hiding it.
   */
  importedAs?: string;
};
