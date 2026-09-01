/** Commands a client may send to the Session Host. */
import type { Capabilities, EffortLevel } from "./events.ts";

export type SendWhen = "now" | "after_turn";

export type SessionStatus = "idle" | "running" | "dormant" | "settled" | "ended";

export type SessionSummary = {
  id: string;
  scope: string;
  backend: string;
  status: SessionStatus;
  title: string;
  updatedAt: string;
  lastSeq: number;
  capabilities?: Capabilities;
};

export type Command =
  | { type: "create"; scope: string; backend: string; modelId?: string; effort?: EffortLevel }
  | { type: "send"; sessionId: string; text: string; when: SendWhen }
  | { type: "abort"; sessionId: string }
  | { type: "revive"; sessionId: string }
  | { type: "dispose"; sessionId: string }
  | { type: "settle"; sessionId: string }
  | { type: "set_model"; sessionId: string; modelId: string }
  | { type: "set_effort"; sessionId: string; effort: EffortLevel }
  | { type: "list" };
