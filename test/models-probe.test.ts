import assert from "node:assert/strict";
import { it } from "node:test";
import { FakeBackend } from "../src/backend/fake/index.ts";
import type { BackendCreateOptions } from "../src/backend/types.ts";
import { SessionHost } from "../src/daemon/host.ts";
import { probeModels } from "../src/daemon/models.ts";

it("builder model discovery uses only the selected backend and does not reuse ordinary probes", async t => {
  const host = new SessionHost();
  t.after(() => host.shutdown());
  const fake = new FakeBackend();
  const opened: BackendCreateOptions[] = [];
  host.registerBackend({ name: "fake", create: async options => {
    opened.push(options);
    const session = await fake.create(options);
    session.prompt = async () => { assert.fail("Model discovery must not prompt"); };
    return session;
  } });
  const ordinary = await host.models("/tmp");
  host.registerBackend({ name: "other", create: async () => { throw new Error("Unselected backend was opened"); } });
  const listing = await host.workflowBuilderModels("fake", "/tmp");
  assert.deepEqual(listing, ordinary[0]);
  assert.equal(opened.length, 2);
  assert.equal(opened[0]!.workflowBuilder, undefined);
  const builder = opened[1]!.workflowBuilder;
  assert.ok(builder);
  assert.equal(opened[1]!.scope, "/tmp");
  assert.equal(opened[1]!.tools, "none");
  for (const method of ["read", "list", "write"] as const) {
    await assert.rejects(builder[method]("unused"), /Model discovery cannot use workflow builder tools/);
  }
  assert.equal(fake.latest.disposed, true);
});

it("builder model probes never prompt and report startup failures without an ordinary retry", async () => {
  let attempts = 0;
  const listing = await probeModels({ name: "broken", create: async options => {
    attempts++;
    assert.ok(options.workflowBuilder);
    assert.equal(options.workflowBuilder.instructions, "List available models only.");
    throw new Error("restricted startup failed");
  } }, "/tmp", true);
  assert.deepEqual(listing, { backend: "broken", models: [], problem: "restricted startup failed" });
  assert.equal(attempts, 1);
});
