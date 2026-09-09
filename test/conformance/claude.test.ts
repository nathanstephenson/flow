import { ClaudeBackend } from "../../src/backend/claude/index.ts";
import { runContract } from "./contract.ts";

/**
 * Live contract run against the Claude Agent SDK. Spawns the real CLI and spends real tokens, so
 * it is opt-in: FLOW_E2E=1 npm test
 */
if (process.env["FLOW_E2E"] !== "1") {
  console.log("# skipping Claude conformance (set FLOW_E2E=1 to run)");
} else {
  const backend = new ClaudeBackend({ allowedTools: [] });
  const TURN_TIMEOUT_MS = 120_000;

  // The contract runs its tests sequentially, so one pending turn at a time is enough.
  let onTurnEnded: (() => void) | undefined;

  runContract({
    name: "claude",
    turnTimeoutMs: TURN_TIMEOUT_MS,
    createSession: (emit) =>
      backend.create({
        scope: process.cwd(),
        emit: (event) => {
          emit(event);
          if (event.type === "turn_ended") {
            onTurnEnded?.();
            onTurnEnded = undefined;
          }
        },
      }),
    async runTurn(session, text) {
      const ended = new Promise<void>((resolve) => {
        onTurnEnded = resolve;
      });
      await session.prompt(text);
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("turn timed out")), TURN_TIMEOUT_MS);
      });
      try {
        await Promise.race([ended, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  });
}
