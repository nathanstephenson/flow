import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canRevive, canSettle, deriveStatus, occupied } from "../src/client/status.ts";
import type { SessionLifecycle, SessionStatus } from "../src/protocol/commands.ts";

/**
 * The rules the Session Host and both front-ends share. Worth their own tests because they are the
 * one place the derivation lives: the host reports these values and the reducer reproduces them, so
 * a change here moves the rail and the pane together or breaks both.
 */
describe("what a status means", () => {
  const LIFECYCLES: SessionLifecycle[] = ["live", "dormant", "settled", "ended"];

  it("reports the Lifecycle unchanged wherever it is not live", () => {
    for (const lifecycle of LIFECYCLES.filter((value) => value !== "live")) {
      for (const turnInFlight of [false, true]) {
        for (const awaiting of [false, true]) {
          assert.equal(
            deriveStatus({ lifecycle, turnInFlight, awaiting }),
            lifecycle,
            `${lifecycle} must survive turnInFlight=${turnInFlight} awaiting=${awaiting}`,
          );
        }
      }
    }
  });

  it("derives the three activities of a live Agent Session", () => {
    assert.equal(deriveStatus({ lifecycle: "live", turnInFlight: false, awaiting: false }), "idle");
    assert.equal(deriveStatus({ lifecycle: "live", turnInFlight: true, awaiting: false }), "running");
    assert.equal(deriveStatus({ lifecycle: "live", turnInFlight: true, awaiting: true }), "awaiting");
  });

  it("prefers awaiting over running, because that is the one that needs a person", () => {
    // Both are true of a turn blocked on a Permission Prompt. The rail has one dot, and the useful
    // thing to say is that it is stuck rather than that it is busy.
    assert.equal(deriveStatus({ lifecycle: "live", turnInFlight: true, awaiting: true }), "awaiting");
    // And a prompt outliving `turnInFlight` still reads as awaiting rather than idle.
    assert.equal(deriveStatus({ lifecycle: "live", turnInFlight: false, awaiting: true }), "awaiting");
  });

  it("counts awaiting as occupied, so nothing offered mid-turn is offered then", () => {
    const occupying: SessionStatus[] = ["running", "awaiting"];
    const free: SessionStatus[] = ["idle", "dormant", "settled", "ended"];
    for (const status of occupying) assert.equal(occupied(status), true, status);
    for (const status of free) assert.equal(occupied(status), false, status);
  });

  it("treats awaiting as a live Agent Session for Settle and Revive", () => {
    // Awaiting means a Backend Session is attached, so there is nothing to Revive — and filing it
    // away is still allowed, which is how someone escapes a prompt they do not want to answer.
    assert.equal(canSettle("awaiting"), true);
    assert.equal(canRevive("awaiting"), false);
  });
});
