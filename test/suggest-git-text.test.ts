import assert from "node:assert/strict";
import { it } from "node:test";
import { execFileSync } from "node:child_process";
import { FakeBackend } from "../src/backend/fake/index.ts";
import { suggestGitText } from "../src/daemon/summariser.ts";

it("sanitises a suggested branch name", async () => {
  const backend = new FakeBackend();
  for (const [value, expected] of [["Fix/Add Search..@{oops}", "fix/add-search-oops"], ["Add search filters", "feat/add-search-filters"]]) {
    backend.autoReply = JSON.stringify({ branch: value });
    const { branch } = await suggestGitText({ backend, modelId: "fake-2", text: "diff", kind: "branch" });
    assert.equal(branch, expected);
    execFileSync("git", ["check-ref-format", "--branch", branch!]);
  }
  for (const value of [42, "..."]) {
    backend.autoReply = JSON.stringify({ branch: value });
    await assert.rejects(suggestGitText({ backend, modelId: "fake-2", text: "diff", kind: "branch" }), /invalid text/);
  }
});

it("asks a tool-less Backend Session with the selected model and no effort for each kind", async () => {
  const backend = new FakeBackend();
  backend.autoReply = JSON.stringify({ message: "Add search", title: "Add search", body: "Adds search." });
  assert.deepEqual(await suggestGitText({ backend, modelId: "fake-2", text: "diff", kind: "commit" }), { message: "Add search" });
  assert.equal(backend.latest.toolless, true);
  assert.equal(backend.latest.modelId, "fake-2");
  assert.equal(backend.latest.effort, undefined);
  assert.equal(backend.latest.disposed, true);
  assert.equal(backend.latest.prompts.length, 1);
  assert.match(backend.latest.prompts[0]!, /commit message/);
  assert.deepEqual(await suggestGitText({ backend, modelId: "fake-2", text: "diff", kind: "pull_request" }), { title: "Add search", body: "Adds search." });
  assert.match(backend.latest.prompts[0]!, /pull request title and body/);
});

it("disposes a Backend Session that finishes starting after the timeout", async () => {
  const backend = new FakeBackend();
  const slow = { name: "slow", create: async (options: Parameters<FakeBackend["create"]>[0]) => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return backend.create(options);
  } };
  await assert.rejects(suggestGitText({ backend: slow, modelId: "fake-1", text: "diff", timeoutMs: 5, kind: "commit" }), /timed out/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(backend.latest.disposed, true);
  assert.equal(backend.latest.prompts.length, 0);
});

it("rejects invalid output and disposes on timeout", async () => {
  const backend = new FakeBackend();
  backend.autoReply = "not JSON";
  await assert.rejects(suggestGitText({ backend, modelId: "fake-1", text: "diff", kind: "commit" }));
  assert.equal(backend.latest.disposed, true);
  backend.autoReply = JSON.stringify({ message: " " });
  await assert.rejects(suggestGitText({ backend, modelId: "fake-1", text: "diff", kind: "commit" }), /invalid text/);
  backend.autoReply = undefined;
  await assert.rejects(suggestGitText({ backend, modelId: "fake-1", text: "diff", timeoutMs: 10, kind: "commit" }), /timed out/);
  assert.equal(backend.latest.disposed, true);
});
