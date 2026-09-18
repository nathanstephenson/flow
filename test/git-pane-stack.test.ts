import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { it } from "node:test";
import { transformSync } from "esbuild";

type Element = { type: string; key?: string; props: Record<string, any> };
function component(file: string, command: (input: any) => Promise<any>, globals: Record<string, unknown> = {}) {
  const states: any[] = [];
  let index = 0;
  const effects: (() => void)[] = [];
  const exports: Record<string, (props: any) => Element> = {};
  const module = { exports };
  const require = createRequire(import.meta.url);
  const code = transformSync(readFileSync(new URL(`../web/src/components/${file}.tsx`, import.meta.url), "utf8"), { loader: "tsx", format: "cjs", jsx: "automatic" }).code;
  runInNewContext(code, { ...globals, module, exports, require: (name: string) => {
    if (name === "react") return {
      useState: (initial: any) => { const slot = index++; if (!(slot in states)) states[slot] = initial; return [states[slot], (value: any) => { states[slot] = typeof value === "function" ? value(states[slot]) : value; }]; },
      useEffect: (effect: () => void) => { effects.push(effect); },
    };
    if (name === "react/jsx-runtime") return require(name);
    if (name === "@/host.tsx") return { useHost: () => ({ connection: { command } }) };
    return new Proxy({}, { get: (_target, key) => key });
  } });
  return { render: (name: string, props: any) => { index = 0; return module.exports[name]!(props); }, effects };
}
function find(element: any, type: string, matches: (element: Element) => boolean = () => true): Element {
  if (element?.type === type && matches(element)) return element;
  for (const child of [element?.props?.children].flat(Infinity)) {
    if (!child || typeof child !== "object") continue;
    try { return find(child, type, matches); } catch {}
  }
  throw new Error(`Missing ${type}`);
}

it("Git tabs default to PR, keep an explicit Diff choice and fall back when unavailable", async () => {
  const pane = component("git-pane", async () => ({ repository: true, files: [] }));
  const props = { sessionId: "session" };
  const render = () => pane.render("GitPane", props);
  render();
  pane.effects[0]!();
  await Promise.resolve();
  const tab = (label: string) => find(render(), "Button", node => node.props.role === "tab" && node.props.children === label);
  assert.equal(tab("Diff").props["aria-selected"], true);
  assert.throws(() => tab("PR"));
  assert.throws(() => tab("Stack"));
  find(render(), "PullRequestPane").props.onAvailable(true);
  assert.equal(tab("PR").props["aria-selected"], true);
  assert.equal(find(render(), "div", node => node.props.id === "git-session-Diff").props.hidden, true);
  find(render(), "StackPane").props.onAvailable(true);
  tab("Stack").props.onClick();
  assert.equal(tab("Stack").props["aria-selected"], true);
  find(render(), "StackPane").props.onAvailable(false);
  assert.equal(tab("Diff").props["aria-selected"], true);
  tab("Diff").props.onClick();
  find(render(), "PullRequestPane").props.onAvailable(true);
  assert.equal(tab("Diff").props["aria-selected"], true);
  tab("PR").props.onClick();
  find(render(), "PullRequestPane").props.onAvailable(false);
  assert.equal(tab("Diff").props["aria-selected"], true);
});

it("keeps Publish visible when the PR is discovered after it opens", async () => {
  const pane = component("git-pane", async input => input.type === "prepare_publish"
    ? { files: [], commits: [], branch: "feature", defaultBranch: "main" }
    : { repository: true, files: [] });
  const render = () => pane.render("GitPane", { sessionId: "session" });
  render();
  pane.effects[0]!();
  await Promise.resolve();
  find(render(), "Button", node => node.props.children === "Publish").props.onClick();
  find(render(), "PullRequestPane").props.onAvailable(true);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(find(render(), "div", node => node.props.id === "git-session-Diff").props.hidden, false);
  assert.equal(find(render(), "Button", node => node.props.role === "tab" && node.props.children === "Diff").props["aria-selected"], true);
  find(render(), "form");
});

it("refreshes PR data without remounting comment drafts from Diff", async () => {
  const pane = component("git-pane", async () => ({ repository: true, files: [] }));
  const render = () => pane.render("GitPane", { sessionId: "session" });
  render();
  pane.effects[0]!();
  await Promise.resolve();
  const before = find(render(), "PullRequestPane");
  find(render(), "Button", node => node.props.children === "Refresh").props.onClick();
  const after = find(render(), "PullRequestPane");
  assert.equal(after.key, before.key);
  assert.equal(after.props.revision, before.props.revision + 1);
});

it("refreshes Stack after a PR action or Pull", async () => {
  const pane = component("git-pane", async () => ({ repository: true, branch: { name: "feature" }, files: [] }));
  const render = () => pane.render("GitPane", { sessionId: "session" });
  render();
  pane.effects[0]!();
  await Promise.resolve();
  const before = find(render(), "StackPane").props.revision;
  find(render(), "PullRequestPane").props.onChange();
  assert.equal(find(render(), "StackPane").props.revision, before + 1);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  find(render(), "Button", node => node.props.children === "Pull").props.onClick();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(find(render(), "StackPane").props.revision, before + 2);
});

for (const candidate of [false, true]) it(`reports a ${candidate ? "candidate" : "tracked"} Stack as available`, async () => {
  let available = false;
  const pane = component("stack-pane", async () => ({ available: true, conflicts: [], rebasing: false, ...(candidate ? { candidate: { pullRequests: [] } } : { view: { branches: [] } }) }));
  const props = { sessionId: "session", onChange() {}, onAvailable: (value: boolean) => { available = value; } };
  pane.render("StackPane", props);
  pane.effects[0]!();
  await Promise.resolve();
  pane.render("StackPane", props);
  pane.effects.at(-1)!();
  assert.equal(available, true);
});

it("Pull uses the displayed branch and disables dirty files", async () => {
  const calls: any[] = [];
  const status = { repository: true, branch: { name: "feature" }, files: [] as any[] };
  const pane = component("git-pane", async input => { calls.push(input); return status; });
  const props = { sessionId: "session" };
  pane.render("GitPane", props);
  pane.effects[0]!();
  await Promise.resolve();
  const button = () => find(pane.render("GitPane", props), "Button", node => node.props.children === "Pull");
  assert.equal(button().props.disabled, false);
  button().props.onClick();
  assert.equal(calls.at(-1).type, "pull_branch");
  assert.equal(calls.at(-1).branch, "feature");
  for (let i = 0; i < 10; i++) await Promise.resolve();
  status.files.push({ path: "dirty", status: "M" });
  assert.equal(button().props.disabled, true);
});

for (const action of ["merge", "rebase"]) it(`PR ${action} requires confirmation and sends the displayed PR identity`, () => {
  const calls: any[] = [];
  const pane = component("pull-request-pane", async () => {});
  const pr = { repo: "test/repo", id: "PR_one", number: 1, state: "OPEN", headRefOid: "a".repeat(40), headRefName: "feature", baseRefName: "main", mergeMethods: ["SQUASH", "REBASE"] };
  const props = { pr, busy: false, change: (...args: any[]) => calls.push(args) };
  const render = () => pane.render("PullRequestActions", props);
  find(render(), "Button", node => node.props.children === (action === "merge" ? "Merge" : "Rebase")).props.onClick();
  assert.equal(calls.length, 0);
  if (action === "merge") {
    const select = find(render(), "select");
    assert.equal(select.props.value, "SQUASH");
    assert.equal(select.props.children.length, 2);
    select.props.onChange({ target: { value: "REBASE" } });
  } else assert.match(JSON.stringify(render()), /No push or stack rebase/);
  find(render(), "form").props.onSubmit({ preventDefault() {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], action);
  assert.equal(calls[0][1].headOid, pr.headRefOid);
  assert.equal(calls[0][1].baseBranch, "main");
  assert.equal(calls[0][1].pr.id, "PR_one");
  assert.equal(calls[0][1].method, action === "merge" ? "REBASE" : undefined);
});

it("PR merge is unavailable without a permitted method or for a draft", () => {
  const pane = component("pull-request-pane", async () => {});
  for (const extra of [{ mergeMethods: [] }, { mergeMethods: ["MERGE"], isDraft: true }]) {
    const tree = pane.render("PullRequestActions", { pr: { state: "OPEN", headRefOid: "a".repeat(40), ...extra }, busy: false, change() {} });
    assert.equal(find(tree, "Button", node => node.props.children === "Merge").props.disabled, true);
  }
});

it("Stack changes immediately replace the PR pane and clear Publish results", async () => {
  const pane = component("git-pane", async (input) => {
    if (input.type === "prepare_publish") return { files: [], commits: [], branch: "feature", defaultBranch: "main" };
    if (input.type === "publish") return { pushed: true, branch: "published-branch" };
    return { repository: true, files: [] };
  });
  pane.render("GitPane", { sessionId: "session" });
  pane.effects[0]!();
  await Promise.resolve();
  find(pane.render("GitPane", { sessionId: "session" }), "Button", node => node.props.children === "Publish").props.onClick();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  find(pane.render("GitPane", { sessionId: "session" }), "form").props.onSubmit({ preventDefault() {} });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const before = pane.render("GitPane", { sessionId: "session" });
  assert.match(JSON.stringify(before), /published-branch/);
  find(before, "StackPane").props.onChange();
  const after = pane.render("GitPane", { sessionId: "session" });
  assert.notEqual(find(before, "PullRequestPane").key, find(after, "PullRequestPane").key);
  assert.doesNotMatch(JSON.stringify(after), /published-branch/);
});

for (const branch of ["main", "flow/generated-123"]) it(`reviews and edits a suggested Publish branch from ${branch}`, async () => {
  const calls: any[] = [];
  const pane = component("git-pane", async input => {
    calls.push(input);
    if (input.type === "prepare_publish") return { files: [], commits: [], branch, defaultBranch: "main", suggestedBranch: "feat/copy-pr-links", title: "Copy PR links", commitMessage: "Copy PR links", body: "" };
    if (input.type === "publish") return { pushed: true, branch: input.input.branch };
    return { repository: true, files: [] };
  });
  const props = { sessionId: "session" };
  pane.render("GitPane", props);
  pane.effects[0]!();
  await Promise.resolve();
  find(pane.render("GitPane", props), "Button", node => node.props.children === "Publish").props.onClick();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  const tree = pane.render("GitPane", props);
  const label = find(tree, "label", node => node.props.children[0] === "Feature branch name");
  const field = find(label, "Input");
  assert.equal(field.props.value, "feat/copy-pr-links");
  assert.equal(calls.filter(call => call.type === "publish").length, 0);
  assert.match(JSON.stringify(tree), branch === "main" ? /Create a feature branch from main/ : /Rename flow\/generated-123/);
  field.props.onChange({ target: { value: "feat/edited-name" } });
  find(pane.render("GitPane", props), "form").props.onSubmit({ preventDefault() {} });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(calls.find(call => call.type === "publish").input.branch, "feat/edited-name");
  assert.match(JSON.stringify(pane.render("GitPane", props)), /feat\/edited-name/);
});

it("does not offer branch renaming without a Publish suggestion", async () => {
  const pane = component("git-pane", async input => input.type === "prepare_publish"
    ? { files: [], commits: [], branch: "feat/published", defaultBranch: "main" }
    : { repository: true, files: [] });
  const props = { sessionId: "session" };
  pane.render("GitPane", props);
  pane.effects[0]!();
  await Promise.resolve();
  find(pane.render("GitPane", props), "Button", node => node.props.children === "Publish").props.onClick();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  const tree = pane.render("GitPane", props);
  assert.throws(() => find(tree, "label", node => node.props.children[0] === "Feature branch name"));
  assert.match(JSON.stringify(tree), /feat\/published/);
});

for (const fails of [false, true]) it(`opens and cancels new branch entry, then handles add ${fails ? "failure" : "success"}`, async () => {
  const calls: any[] = [];
  const pane = component("stack-pane", async input => {
    calls.push(input);
    if (input.type === "change_stack") {
      if (fails) throw new Error("Branch already exists");
      return "Branch added";
    }
    return { available: true, conflicts: [], rebasing: false, view: { trunk: "main", branches: [] } };
  });
  const props = { sessionId: "session", onChange() {} };
  const render = () => pane.render("StackPane", props);
  render();
  pane.effects[0]!();
  await Promise.resolve();
  assert.throws(() => find(render(), "Input"));
  const open = () => find(render(), "Button", node => node.props["aria-label"] === "New branch");
  assert.equal(open().props.size, "icon-sm");
  assert.equal(find(open(), "Plus").props["aria-hidden"], "true");
  open().props.onClick();
  assert.equal(find(render(), "Input").props.autoFocus, true);
  assert.equal(find(render(), "Button", node => node.props.children === "Add branch").props.disabled, true);
  find(render(), "Input").props.onChange({ target: { value: "discard-me" } });
  find(render(), "Button", node => node.props.children === "Cancel").props.onClick();
  assert.throws(() => find(render(), "Input"));
  assert.equal(calls.filter(call => call.type === "change_stack").length, 0);
  open().props.onClick();
  assert.equal(find(render(), "Input").props.value, "");
  find(render(), "Input").props.onChange({ target: { value: "  feat/new-branch  " } });
  find(render(), "form").props.onSubmit({ preventDefault() {} });
  assert.equal(find(render(), "Button", node => node.props.children === "Cancel").props.disabled, true);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const input = calls.find(call => call.type === "change_stack").input;
  assert.equal(input.action, "add");
  assert.equal(JSON.stringify(input.branches), JSON.stringify(["feat/new-branch"]));
  if (fails) {
    assert.equal(find(render(), "Input").props.value, "  feat/new-branch  ");
    assert.match(JSON.stringify(render()), /Branch already exists/);
  } else {
    assert.throws(() => find(render(), "Input"));
    open().props.onClick();
    assert.equal(find(render(), "Input").props.value, "");
  }
});

for (const fails of [false, true]) it(`Stack checkout invalidates Git state after ${fails ? "failure" : "success"}`, async () => {
  let changes = 0;
  const status = { available: true, conflicts: [], rebasing: false, view: { trunk: "main", branches: [{ name: "123" }] } };
  const pane = component("stack-pane", async (input) => {
    if (input.type === "change_stack" && fails) throw new Error("checkout failed");
    return input.type === "stack_status" ? status : "switched";
  });
  pane.render("StackPane", { sessionId: "session", onChange: () => { changes++; } });
  pane.effects[0]!();
  await Promise.resolve();
  const tree = pane.render("StackPane", { sessionId: "session", onChange: () => { changes++; } });
  function switchButton(node: any): Element | undefined {
    if (node?.type === "Button" && node.props.children === "Switch") return node;
    for (const child of [node?.props?.children].flat(Infinity)) { if (child && typeof child === "object") { const found = switchButton(child); if (found) return found; } }
  }
  switchButton(tree)!.props.onClick();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(changes, 1);
});

for (const eligible of [false, true]) it(`shows Create stack only for an eligible chain: ${eligible}`, async () => {
  const calls: any[] = [];
  const candidate = { trunk: "main", branches: ["first", "second"], pullRequests: [{ branch: "first", number: 23, state: "MERGED" }, { branch: "second", number: 22, state: "OPEN" }], fingerprint: "reviewed" };
  const pane = component("stack-pane", async input => {
    calls.push(input);
    return { available: true, conflicts: [], rebasing: false, ...(eligible ? { candidate } : {}) };
  });
  const props = { sessionId: "session", onChange() {} };
  pane.render("StackPane", props);
  pane.effects[0]!();
  await Promise.resolve();
  const tree = pane.render("StackPane", props);
  assert.throws(() => find(tree, "Input"));
  for (const label of ["Add branch", "Rebase", "Submit stack", "Sync stack"]) assert.throws(() => find(tree, "Button", node => node.props.children === label));
  if (!eligible) assert.equal(tree, null);
  else {
    assert.match(JSON.stringify(tree), /first/);
    assert.match(JSON.stringify(tree), /second/);
    assert.match(JSON.stringify(tree), /MERGED/);
    assert.match(JSON.stringify(tree), /OPEN/);
    find(tree, "Button", node => node.props.children === "Create stack").props.onClick();
    await Promise.resolve();
    const input = calls.find(call => call.type === "change_stack").input;
    assert.equal(JSON.stringify(input.branches), JSON.stringify(candidate.branches));
    assert.equal(input.fingerprint, candidate.fingerprint);
  }
});

for (const candidate of [false, true]) it(`copies linked titles top to bottom from ${candidate ? "a candidate" : "a tracked stack"}`, async () => {
  const prs = [
    { number: 1, title: 'Base <fix> & "test"', url: "https://github.com/test/repo/pull/1", state: "MERGED" },
    { number: 2, title: "Top change", url: "https://github.com/test/repo/pull/2", state: "OPEN" },
  ];
  let copied: any[] = [];
  const pane = component("stack-pane", async () => ({ available: true, conflicts: [], rebasing: false,
    ...(candidate ? { candidate: { trunk: "main", pullRequests: prs } } : { view: { trunk: "main", branches: [{ name: "base", pr: prs[0] }, { name: "unpublished" }, { name: "top", pr: prs[1] }] } }),
  }), { Blob, ClipboardItem: class { data: any; constructor(data: any) { this.data = data; } }, navigator: { clipboard: { write: async (items: any[]) => { copied = items; } } } });
  const props = { sessionId: "session", onChange() { assert.fail("Copy must not change Git state"); } };
  pane.render("StackPane", props);
  pane.effects[0]!();
  await Promise.resolve();
  const button = find(pane.render("StackPane", props), "Button", node => node.props["aria-label"] === "Copy stack");
  assert.equal(button.props.size, "icon-sm");
  assert.equal(button.props.title, "Copy stack");
  assert.equal(find(button, "Copy").props["aria-hidden"], "true");
  assert.equal(button.props.disabled, false);
  button.props.onClick();
  await Promise.resolve();
  assert.equal(copied.length, 1);
  assert.equal(await copied[0].data["text/html"].text(), '<div><a href="https://github.com/test/repo/pull/2">Top change</a></div><div><a href="https://github.com/test/repo/pull/1">Base &lt;fix&gt; &amp; &quot;test&quot;</a></div>');
  assert.equal(await copied[0].data["text/plain"].text(), 'Top change\nBase <fix> & "test"');
  assert.match(JSON.stringify(pane.render("StackPane", props)), /Stack copied/);
  for (const pr of prs) {
    const single = find(pane.render("StackPane", props), "Button", node => node.props["aria-label"] === `Copy PR #${pr.number} link`);
    assert.equal(single.props.disabled, false);
    assert.equal(single.props.size, "icon-sm");
    assert.equal(single.props.title, `Copy PR #${pr.number} link`);
    assert.equal(find(single, "Copy").props["aria-hidden"], "true");
    single.props.onClick();
    await Promise.resolve();
    const title = pr.number === 1 ? "Base &lt;fix&gt; &amp; &quot;test&quot;" : pr.title;
    assert.equal(await copied[0].data["text/html"].text(), `<div><a href="${pr.url}">${title}</a></div>`);
    assert.equal(await copied[0].data["text/plain"].text(), pr.title);
    assert.match(JSON.stringify(pane.render("StackPane", props)), new RegExp(`PR #${pr.number} copied`));
  }
});

for (const single of [false, true]) it(`reports clipboard failures for ${single ? "one PR" : "the stack"}`, async () => {
  const pane = component("stack-pane", async () => ({ available: true, conflicts: [], rebasing: false,
    view: { trunk: "main", branches: [{ name: "base", pr: { number: 1, title: "Base", url: "https://github.com/test/repo/pull/1" } }] },
  }), { Blob, ClipboardItem: class {}, navigator: { clipboard: { write: async () => { throw new Error("Permission denied"); } } } });
  const props = { sessionId: "session", onChange() {} };
  pane.render("StackPane", props);
  pane.effects[0]!();
  await Promise.resolve();
  find(pane.render("StackPane", props), "Button", node => single ? node.props["aria-label"] === "Copy PR #1 link" : node.props["aria-label"] === "Copy stack").props.onClick();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.match(find(pane.render("StackPane", props), "p", node => node.props.role === "alert").props.children, /Could not copy .*Permission denied/);
});

for (const pr of [undefined, { number: 1, state: "OPEN" }]) it(`does not copy without ${pr ? "PR details" : "PRs"}`, async () => {
  const pane = component("stack-pane", async () => ({ available: true, conflicts: [], rebasing: false,
    view: { trunk: "main", branches: [{ name: "base", pr }] },
  }));
  const props = { sessionId: "session", onChange() {} };
  pane.render("StackPane", props);
  pane.effects[0]!();
  await Promise.resolve();
  const button = () => find(pane.render("StackPane", props), "Button", node => node.props["aria-label"] === "Copy stack");
  if (pr) assert.equal(button().props.disabled, true);
  else assert.throws(button, /Missing Button/);
  const single = () => find(pane.render("StackPane", props), "Button", node => node.props["aria-label"] === "Copy PR #1 link");
  if (pr) assert.equal(single().props.disabled, true);
  else assert.throws(single, /Missing Button/);
});

it("keeps merged members from the tracked stack visible", async () => {
  const pane = component("stack-pane", async () => ({ available: true, conflicts: [], rebasing: false,
    view: { trunk: "main", branches: [{ name: "merged-member", isMerged: true, pr: { number: 23, state: "CLOSED" } }] } }));
  const props = { sessionId: "session", onChange() {} };
  pane.render("StackPane", props);
  pane.effects[0]!();
  await Promise.resolve();
  const tree = pane.render("StackPane", props);
  assert.match(JSON.stringify(tree), /merged-member/);
  assert.match(JSON.stringify(tree), /#23 MERGED/);
  assert.throws(() => find(tree, "Button", node => node.props.children === "Create stack"));
});

it("shows a nested read-only graph without gh-stack and labels remote and inferred branches", async () => {
  let available = false;
  const status = {
    available: false,
    problem: "Install gh-stack to manage this stack.",
    problemKind: "action",
    warnings: ["Native GitHub stacks could not be read; PR relationships were used."],
    conflicts: [],
    rebasing: false,
    graph: {
      trunk: "main",
      currentBranch: "child",
      explicit: false,
      branches: [
        { name: "root", parent: "main", relation: "pull-request", isCurrent: false, availability: "local", pr: { number: 1, state: "MERGED" } },
        { name: "child", parent: "root", relation: "pull-request", isCurrent: true, availability: "local", pr: { number: 2, state: "OPEN" } },
        { name: "remote-sibling", parent: "root", relation: "ancestry", isCurrent: false, availability: "remote" },
      ],
    },
  };
  const pane = component("stack-pane", async () => status);
  const props = { sessionId: "session", onChange() {}, onAvailable: (value: boolean) => { available = value; } };
  pane.render("StackPane", props);
  pane.effects[0]!();
  await Promise.resolve();
  const tree = pane.render("StackPane", props);
  pane.effects.at(-1)!();
  assert.equal(available, true);
  assert.match(JSON.stringify(tree), /remote-sibling/);
  assert.match(JSON.stringify(tree), /remote-only/);
  assert.match(JSON.stringify(tree), /inferred/);
  assert.match(JSON.stringify(tree), /read-only stack graph/);
  assert.equal(find(tree, "ul", node => node.props.role === "tree").props.children.length, 3);
  assert.throws(() => find(tree, "Button", node => node.props.children === "Create stack"));
  assert.throws(() => find(tree, "Button", node => node.props.children === "Switch"));
});

it("keeps discovery errors visible with retry but hides an action-only notice", async () => {
  for (const discovery of [false, true]) {
    let available = false;
    const pane = component("stack-pane", async () => ({ available: false, conflicts: [], rebasing: false, problem: discovery ? "GitHub is offline" : "Install gh-stack", problemKind: discovery ? "discovery" : "action" }));
    const props = { sessionId: "session", onChange() {}, onAvailable: (value: boolean) => { available = value; } };
    pane.render("StackPane", props);
    pane.effects[0]!();
    await Promise.resolve();
    const tree = pane.render("StackPane", props);
    pane.effects.at(-1)!();
    assert.equal(available, discovery);
    if (discovery) {
      assert.match(JSON.stringify(tree), /GitHub is offline/);
      assert.equal(find(tree, "Button", node => node.props.children === "Refresh stack").props.disabled, false);
    } else assert.equal(tree, null);
  }
});

it("keeps a rejected Stack status command visible as a retryable error", async () => {
  let available = false;
  const pane = component("stack-pane", async () => { throw new Error("command rejected"); });
  const props = { sessionId: "session", onChange() {}, onAvailable: (value: boolean) => { available = value; } };
  pane.render("StackPane", props);
  pane.effects[0]!();
  await Promise.resolve();
  const tree = pane.render("StackPane", props);
  pane.effects.at(-1)!();
  assert.equal(available, true);
  assert.match(find(tree, "p", node => node.props.role === "alert").props.children, /command rejected/);
  assert.equal(find(tree, "Button", node => node.props.children === "Refresh stack").props.disabled, false);
});

it("clears stale Stack graphs and errors as soon as a refresh revision starts", async () => {
  let attempt = 0;
  let resolveSecond: ((value: any) => void) | undefined;
  const pane = component("stack-pane", async () => {
    attempt++;
    if (attempt === 1) throw new Error("stale failure");
    return await new Promise(resolve => { resolveSecond = resolve; });
  });
  const first = { sessionId: "session", revision: 0, onChange() {} };
  pane.render("StackPane", first);
  pane.effects[0]!();
  await Promise.resolve();
  assert.match(JSON.stringify(pane.render("StackPane", first)), /stale failure/);

  const second = { ...first, revision: 1 };
  const effectIndex = pane.effects.length;
  pane.render("StackPane", second);
  pane.effects[effectIndex]!();
  assert.equal(pane.render("StackPane", second), null);
  resolveSecond!({ available: true, conflicts: [], rebasing: false });
  await Promise.resolve();
  assert.equal(pane.render("StackPane", second), null);
});
