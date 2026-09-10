import type { PermissionDecision } from "../protocol/events.ts";
import type { Authorisation } from "./reduce.ts";

/**
 * What both front-ends offer for a Permission Prompt, and what they say about a decided one.
 *
 * Much smaller than its neighbour `./enquiry.ts`, and that is the shape of the thing rather than an
 * omission: an Enquiry needs shared *rules* — a cursor, a multi-select, a typed answer, an arity —
 * because the model chose its options. A Permission Prompt always offers the same three, none of
 * them typed, so what has to be shared is only the words. Sharing them is still the point: two
 * front-ends inventing their own labels for "always" is exactly the drift this repo exists to avoid.
 */

/** One thing a human can decide, as a front-end offers it. */
export type PermissionChoice = {
  decision: PermissionDecision;
  label: string;
  /** Why someone would pick it — and for `always`, what it costs. */
  description: string;
};

/**
 * The three choices, in the order both front-ends present them.
 *
 * Allow first because it is the common answer, and Always last for the reason it is not merely the
 * boldest: it is the one with an effect outside this turn, and a list that put it second would invite
 * a reader skimming downwards to take it for a stronger Allow.
 *
 * **"on this machine" is load-bearing in that label, not decoration.** The Settings are machine-wide
 * (src/protocol/settings.ts), and the hazard that file names is precisely this one — a browser window
 * showing one Scope, inviting a decision that is not scoped to it. Someone clicking Always in a
 * window titled with one project will otherwise read it as "in this project".
 */
export const PERMISSION_CHOICES: readonly PermissionChoice[] = [
  {
    decision: "allow",
    label: "Allow once",
    description: "Run it this time, and ask again next time.",
  },
  {
    decision: "deny",
    label: "Deny",
    description: "Refuse it, and stop asking for the rest of this turn.",
  },
  {
    decision: "always",
    label: "Always allow on this machine",
    description: "Run it, and never ask again in any Agent Session. Revocable in Settings.",
  },
];

/**
 * What a tool row says about a decision, or undefined where nobody was asked.
 *
 * Undefined for the absent case rather than an empty string, so the caller's decision is *is there
 * anything to show* — the idiom `progressLabel` uses. Most rows in most transcripts have none, and a
 * front-end that printed something for them would suggest a judgement nobody made.
 *
 * `asked` is phrased as the ongoing state it is. The other three are past tense, because by the time
 * they are on screen the call has been decided and a reader is looking at history.
 */
export function authorisationLabel(authorisation: Authorisation | undefined): string | undefined {
  switch (authorisation) {
    case undefined:
      return undefined;
    case "asked":
      return "waiting to be authorised";
    case "allowed":
      return "authorised";
    case "always":
      return "always authorised on this machine";
    case "denied":
      return "refused";
  }
}
