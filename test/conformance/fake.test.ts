import { FakeBackend, type FakeSession } from "../../src/backend/fake/index.ts";
import { runContract } from "./contract.ts";

const backend = new FakeBackend();

runContract({
  name: "fake",
  turnTimeoutMs: 1_000,
  createSession: (emit) => backend.create({ scope: "/tmp/scope", emit }),
  /**
   * Drives a Delegation as well as a plain turn, so the contract's Delegation assertions are
   * exercised rather than skipped. The Fake is the only adapter certain to report one, which is
   * what makes those assertions worth writing at all — and interleaving the child's text with the
   * parent's is the case that breaks anything assuming one producer per turn.
   */
  async runTurn(session, text) {
    const fake = session as FakeSession;
    await fake.prompt(text);
    fake.say("o", false);

    const delegation = fake.beginDelegation("explorer", "read a.ts");
    delegation.say("reading", false);
    fake.say("ok", true);
    delegation.useTool("Read", { path: "a.ts" }, "contents");
    delegation.wait("provider");
    delegation.resume();
    delegation.say("reading a.ts: contents", true);
    delegation.finish("complete");

    fake.useTool("Read", { path: "a.ts" }, "contents");
    fake.completeTurn();
  },
});
