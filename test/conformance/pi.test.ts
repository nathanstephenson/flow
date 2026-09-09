import { PiBackend } from "../../src/backend/pi/index.ts";
import { runContract } from "./contract.ts";

/**
 * Live contract run against the pi SDK. pi keeps its own credential store, separate from Claude
 * Code's, so this needs a provider configured in pi (`pi` then `/login`, or a provider API key in
 * the environment). Opt in with: FLOW_E2E_PI=1 npm test
 *
 * The translation logic itself is covered without credentials in test/backend/pi-mapping.test.ts.
 */
if (process.env["FLOW_E2E_PI"] !== "1") {
  console.log("# skipping pi conformance (set FLOW_E2E_PI=1 with pi credentials to run)");
} else {
  const backend = new PiBackend({ tools: [] });
  const TURN_TIMEOUT_MS = 120_000;

  let onTurnEnded: (() => void) | undefined;

  runContract({
    name: "pi",
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
