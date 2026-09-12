import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checksSummary, PullRequestLoader, pullRequestKey, readableStatus, safePullRequestUrl, type PullRequestLoadState } from "./pull-request.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("pull request presentation", () => {
  it("permits only absolute web links", () => {
    assert.equal(safePullRequestUrl("https://github.com/a/b/pull/1"), "https://github.com/a/b/pull/1");
    assert.equal(safePullRequestUrl("http://example.com"), "http://example.com/");
    for (const url of ["javascript:alert(1)", "data:text/html,test", "//example.com", "/relative", "bad"]) assert.equal(safePullRequestUrl(url), undefined);
  });
  it("summarises CI without treating unknown checks as passing", () => {
    assert.equal(checksSummary([]), "No checks reported.");
    assert.equal(checksSummary([{ conclusion: "SUCCESS" }, { state: "ERROR" }, { status: "IN_PROGRESS" }, { status: "COMPLETED" }]), "1 passed · 1 failed · 1 pending · 1 unknown");
    assert.equal(readableStatus("CHANGES_REQUESTED"), "Changes requested");
    assert.notEqual(pullRequestKey({ repo: "a/b", number: 1, id: "one" }), pullRequestKey({ repo: "a/b", number: 2, id: "two" }));
  });
});

describe("pull request requests", () => {
  it("does not overlap polls or writes", async () => {
    const pending = deferred<string>();
    let reads = 0, writes = 0;
    const loader = new PullRequestLoader(() => { reads++; return pending.promise; }, () => {});
    const first = loader.refresh();
    await loader.refresh();
    await loader.write(async () => { writes++; }, "Posted", () => {});
    assert.equal(reads, 1);
    assert.equal(writes, 0);
    pending.resolve("first");
    await first;
  });
  it("retains old data after refresh failure", async () => {
    let state!: PullRequestLoadState<string>;
    let fail = false;
    const loader = new PullRequestLoader(async () => { if (fail) throw new Error("offline"); return "old"; }, (next) => { state = next; });
    await loader.refresh();
    fail = true;
    await loader.refresh();
    assert.equal(state.value, "old");
    assert.match(state.error, /offline/);
    assert.equal(state.busy, false);
  });
  it("ignores responses after disposal and cannot start more requests", async () => {
    const pending = deferred<string>();
    const states: PullRequestLoadState<string>[] = [];
    const loader = new PullRequestLoader(() => pending.promise, (next) => states.push(next));
    const request = loader.refresh();
    loader.dispose();
    const count = states.length;
    pending.resolve("old session");
    await request;
    await loader.refresh();
    await loader.write(async () => { assert.fail("disposed write"); }, "Posted", () => {});
    assert.equal(states.length, count);
  });
  it("clears a confirmed draft even if refresh fails and prevents double posts", async () => {
    let state!: PullRequestLoadState<string>;
    const pending = deferred<void>();
    let draft = "comment", writes = 0;
    const loader = new PullRequestLoader<string>(async () => { throw new Error("offline"); }, (next) => { state = next; });
    const action = async () => { writes++; await pending.promise; };
    const post = loader.write(action, "Comment posted.", () => { draft = ""; });
    await loader.write(action, "Comment posted.", () => { draft = ""; });
    pending.resolve();
    await post;
    assert.equal(writes, 1);
    assert.equal(draft, "");
    assert.equal(state.success, "Comment posted.");
    assert.match(state.error, /offline/);
  });
  it("keeps requests locked through the refresh after a post", async () => {
    const pending = deferred<string>();
    let reads = 0;
    const loader = new PullRequestLoader(() => { reads++; return pending.promise; }, () => {});
    const post = loader.write(async () => {}, "Posted", () => {});
    await Promise.resolve();
    await loader.refresh();
    await loader.write(async () => { assert.fail("overlapping write"); }, "Posted", () => {});
    assert.equal(reads, 1);
    pending.resolve("updated");
    await post;
  });
  it("retains the draft when a post fails", async () => {
    let draft = "comment";
    const loader = new PullRequestLoader(async () => "pr", () => {});
    await loader.write(async () => { throw new Error("denied"); }, "Posted", () => { draft = ""; });
    assert.equal(draft, "comment");
  });
  it("rejects actions from a replaced pull request", async () => {
    let current = "first";
    const loader = new PullRequestLoader(async () => current, () => {});
    await loader.refresh();
    current = "second";
    await loader.refresh();
    await loader.write(async () => { assert.fail("stale action"); }, "Posted", () => {}, (value) => value === "first");
  });
  it("does not refresh or clear a draft after an unmounted write completes", async () => {
    const pending = deferred<void>();
    const loader = new PullRequestLoader(async () => { assert.fail("disposed refresh"); }, () => {});
    const post = loader.write(() => pending.promise, "Posted", () => { assert.fail("disposed draft"); });
    loader.dispose();
    pending.resolve();
    await post;
  });
});
