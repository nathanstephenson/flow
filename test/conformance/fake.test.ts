import { FakeBackend, type FakeSession } from "../../src/backend/fake/index.ts";
import { runContract } from "./contract.ts";

const backend = new FakeBackend();

runContract({
  name: "fake",
  turnTimeoutMs: 1_000,
  createSession: (emit) => backend.create({ scope: "/tmp/scope", emit }),
  /**
   * Drives a Subagent as well as a plain turn, so the contract's Subagent assertions are
   * exercised rather than skipped. The Fake is the only adapter certain to report one, which is
   * what makes those assertions worth writing at all — and interleaving the child's text with the
   * parent's is the case that breaks anything assuming one producer per turn.
   */
  async runTurn(session, text) {
    const fake = session as FakeSession;
    await fake.prompt(text);
    fake.say("o", false);

    const subagent = fake.beginSubagent("explorer", "read a.ts");
    subagent.say("reading", false);
    fake.say("ok", true);
    subagent.useTool("Read", { path: "a.ts" }, "contents");
    subagent.wait("provider");
    subagent.resume();
    subagent.say("reading a.ts: contents", true);
    subagent.finish("complete");

    fake.useTool("Read", { path: "a.ts" }, "contents");
    fake.completeTurn();
  },
});
