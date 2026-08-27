import { FakeBackend, type FakeSession } from "../../src/backend/fake/index.ts";
import { runContract } from "./contract.ts";

const backend = new FakeBackend();

runContract({
  name: "fake",
  turnTimeoutMs: 1_000,
  createSession: (emit) => backend.create({ scope: "/tmp/scope", emit }),
  async runTurn(session, text) {
    const fake = session as FakeSession;
    await fake.prompt(text);
    fake.say("o", false);
    fake.say("ok", true);
    fake.useTool("Read", { path: "a.ts" }, "contents");
    fake.completeTurn();
  },
});
