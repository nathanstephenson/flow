import { useMemo } from "react";

import type { IncomingAttachment } from "../../src/protocol/attachments.ts";
import type { EffortLevel, PermissionDecision, Skill } from "../../src/protocol/events.ts";
import { useCommand } from "@/agent-sessions.tsx";

/**
 * What a composer can be asked to do, apart from where it is asked.
 *
 * The Composer used to hold a `sessionId` and build its own commands from it, which meant it could
 * only ever serve an Agent Session that already existed. The New Agent Session view needs the same
 * box — the same Skill menu, the same Attachment tray, the same model, Effort and branch pickers
 * underneath — for a session that does not exist yet, where "send" means *create one and then send*,
 * and where choosing a model changes a field on a form rather than a property the host holds.
 *
 * So the Composer is handed the verbs instead of the id. Two implementations: `useSessionActions`
 * below, which is the old behaviour moved rather than rewritten, and the New Agent Session view's,
 * which is local state and a `create`.
 *
 * **The four optional members are the ones that need a turn to exist.** A Command occupies an Agent
 * Session, an abort stops one, and an Enquiry or a Permission Prompt is held open *inside* a turn —
 * none of which can happen before there is a session to hold them. They are absent rather than
 * no-ops so that the thing which cannot happen is stated in the type, not guarded at four call
 * sites; and the Composer's own lockouts already mean nothing reaches for them (`chrome.asking` and
 * `chrome.authorising` are undefined, and an Idle status offers no Abort).
 */
export type ComposerActions = {
  /**
   * Send the message. Resolves `undefined` where it was refused, which is what puts the text and
   * its Attachments back in the box rather than losing them.
   */
  send: (text: string, attachments: IncomingAttachment[]) => Promise<unknown | undefined>;
  setModel: (modelId: string) => void;
  setEffort: (effort: EffortLevel) => void;
  /** Resolves false where it was refused, which is what the picker says out loud. */
  switchBranch: (branch: string) => Promise<boolean>;
  /** The Skills on offer. Answered per Agent Session in one case and per Scope in the other. */
  listSkills: () => Promise<Skill[]>;
  compact?: (instructions: string | undefined) => Promise<void>;
  abort?: () => Promise<void>;
  answerEnquiry?: (askId: string, answers: string[][]) => void;
  answerPermission?: (callId: string, decision: PermissionDecision) => void;
};

/**
 * The verbs for an Agent Session that exists: every one of them a command to the Session Host.
 *
 * Lifted out of the Composer unchanged in behaviour, which is the point — the reuse must not be
 * bought by altering what a live composer does. `switch_branch` still answers whether it took, and
 * `send` is still always `after_turn` (see the Composer for why `now` is not what a plain send
 * means).
 */
export function useSessionActions(sessionId: string): ComposerActions {
  const run = useCommand();

  return useMemo(
    () => ({
      send: (text: string, attachments: IncomingAttachment[]) =>
        run<{ queued?: boolean }>({
          type: "send",
          sessionId,
          text,
          ...(attachments.length > 0 ? { attachments } : {}),
          when: "after_turn",
        }),
      setModel: (modelId: string) => void run({ type: "set_model", sessionId, modelId }),
      setEffort: (effort: EffortLevel) => void run({ type: "set_effort", sessionId, effort }),
      switchBranch: async (branch: string) =>
        (await run({ type: "switch_branch", sessionId, branch })) !== undefined,
      listSkills: async () => (await run<Skill[]>({ type: "list_skills", sessionId })) ?? [],
      compact: async (instructions: string | undefined) => {
        await run({ type: "compact", sessionId, ...(instructions ? { instructions } : {}) });
      },
      abort: async () => {
        await run({ type: "abort", sessionId });
      },
      answerEnquiry: (askId: string, answers: string[][]) =>
        void run({ type: "answer_enquiry", sessionId, askId, answers }),
      answerPermission: (callId: string, decision: PermissionDecision) =>
        void run({ type: "answer_permission", sessionId, callId, decision }),
    }),
    [run, sessionId],
  );
}
