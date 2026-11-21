import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { it } from "node:test";
import { transformSync } from "esbuild";
import { checkDraftBlock, threadDraftBlock } from "../web/src/presentation/pull-request.ts";

function managedStack(branches: { name: string; pr?: { number: number; state?: string; title?: string; url?: string } | undefined; isMerged?: boolean }[]) {
  const members = branches.map((branch, index) => ({ ...branch, isCurrent: index === branches.length - 1, isMerged: branch.isMerged ?? false, isQueued: false, needsRebase: false, ...(branch.pr ? { pr: { ...branch.pr, state: branch.pr.state ?? "OPEN" } } : {}) }));
  return { view: { trunk: "main", currentBranch: branches.at(-1)?.name ?? "main", branches: members } };
}

type Element = { type: string; key?: string; props: Record<string, any> };
let gitState: unknown;
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
      useEffect: (effect: () => void, deps?: unknown[]) => { effects.push(Object.assign(effect, { deps })); },
      useRef: (initial: any) => { const slot = index++; if (!(slot in states)) states[slot] = { current: initial }; return states[slot]; },
    };
    if (name === "react/jsx-runtime") return require(name);
    if (name === "@/host.tsx") return { useHost: () => ({ connection: { command } }) };
    if (name === "@/git-state.ts") return { useGitState: () => gitState };
    if (name === "@/presentation/git.ts") return require("../web/src/presentation/git.ts");
    if (name === "@/presentation/pull-request.ts") return require("../web/src/presentation/pull-request.ts");
    return new Proxy({}, { get: (_target, key) => key });
  } });
  return { render: (name: string, props: any) => { index = 0; return module.exports[name]!(props); }, effects: effects as ((() => void) & { deps?: unknown[] })[] };
}
function find(element: any, type: string, matches: (element: Element) => boolean = () => true): Element {
  if (element?.type === type && matches(element)) return element;
  for (const child of [element?.props?.children].flat(Infinity)) {
    if (!child || typeof child !== "object") continue;
    try { return find(child, type, matches); } catch {}
  }
  throw new Error(`Missing ${type}`);
}

// Match the visible label, including layout spans inside a native Button.
function textContent(value: any): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textContent).join("");
  return value && typeof value === "object" ? textContent(value.props?.children) : "";
}
function findButton(element: Element, label: string): Element {
  return find(element, "Button", node => textContent(node.props.children) === label);
}

it("uses shared mounted Git tabs, defaults to PR, preserves explicit choices and falls back", async () => {
  const pane = component("git-pane", async () => ({ repository: true, files: [] }));
  const props = { sessionId: "session" };
  const render = () => pane.render("GitPane", props);
  render();
  await Promise.resolve();
  const tabs = () => find(render(), "Tabs");
  const tab = (label: string) => find(render(), "TabsTrigger", node => node.props.value === label);
  const panel = (label: string) => find(render(), "TabsContent", node => node.props.value === label);
  assert.equal(tabs().props.value, "Changes");
  assert.equal(find(render(), "TabsList").props["aria-label"], "Git views");
  assert.throws(() => tab("PR"));
  assert.throws(() => tab("Stack"));
  for (const label of ["Changes", "Stack", "PR"]) assert.equal(panel(label).props.keepMounted, true);
  find(render(), "PullRequestPane").props.onAvailable(true);
  assert.equal(tabs().props.value, "PR");
  find(render(), "StackPane").props.onAvailable(true);
  tabs().props.onValueChange("Stack");
  assert.equal(tabs().props.value, "Stack");
  find(render(), "StackPane").props.onAvailable(false);
  assert.equal(tabs().props.value, "Changes");
  tabs().props.onValueChange("Changes");
  find(render(), "PullRequestPane").props.onAvailable(true);
  assert.equal(tabs().props.value, "Changes");
  tabs().props.onValueChange("PR");
  assert.equal(tabs().props.value, "PR");
  find(render(), "PullRequestPane").props.onAvailable(false);
  assert.equal(tabs().props.value, "Changes");
});

it("refreshes PR data without remounting comment drafts from Changes", async () => {
  const pane = component("git-pane", async () => ({ repository: true, files: [] }));
  const render = () => pane.render("GitPane", { sessionId: "session" });
  render();
  await Promise.resolve();
  const before = find(render(), "PullRequestPane");
  find(render(), "Button", node => node.props.children === "Refresh").props.onClick();
  const after = find(render(), "PullRequestPane");
  assert.equal(after.key, before.key);
  assert.equal(after.props.revision, before.props.revision + 1);
});

it("gives the Pull request tab the Add to Draft callback", () => {
  const pane = component("git-pane", async () => undefined);
  const onAddToDraft = () => {};
  assert.equal(find(pane.render("GitPane", { sessionId: "session", onAddToDraft }), "PullRequestPane").props.onAddToDraft, onAddToDraft);
});

it("refreshes local Git State and forces one pull request poll from the header Refresh", async () => {
  const calls: any[] = [];
  const pane = component("git-pane", async input => { calls.push(input); });
  const render = () => pane.render("GitPane", { sessionId: "session" });
  findButton(render(), "Refresh").props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ type: "refresh_git", sessionId: "session", pullRequest: true }]);
});

it("gives the Stack tab the Git State and no revision counter", () => {
  gitState = { revision: "a", branch: "feature", head: "h", changed: 0, ahead: 0, behind: 1, upstream: true };
  const pane = component("git-pane", async () => undefined);
  const tree = pane.render("GitPane", { sessionId: "session" });
  assert.equal(find(tree, "StackPane").props.git, gitState);
  assert.equal("revision" in find(tree, "StackPane").props, false);
  assert.equal(find(tree, "PullRequestPane").props.onChange, undefined);
  gitState = undefined;
});

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
async function stackPane(command: (input: any) => Promise<any>, props: Record<string, unknown> = {}) {
  let available: boolean | undefined;
  const pane = component("stack-pane", command);
  const all = { sessionId: "session", onChange() {}, onAvailable: (value: boolean) => { available = value; }, ...props };
  const render = () => pane.render("StackPane", all);
  render();
  pane.effects[0]!();
  await flush();
  render();
  pane.effects.at(-1)!();
  return { render, available: () => available, pane };
}
const createStatus = (create: Record<string, unknown> = {}) => ({ available: true, conflicts: [], rebasing: false,
  create: { current: "feature", trunk: "main", branches: ["feature", "main", "develop", "second", "third"], unstacked: ["feature", "main", "develop", "second"], ...create } });

for (const [name, status] of [
  ["a registered stack", { available: true, conflicts: [], rebasing: false, ...managedStack([{ name: "base" }]) }],
  ["a branch that is not in a stack", createStatus()],
  ["the trunk", { available: true, conflicts: [], rebasing: false, notice: "main is a trunk. Switch to another branch to create a stack." }],
] as const) it(`shows the Stack tab for ${name}`, async () => {
  const { render, available } = await stackPane(async () => status);
  assert.equal(available(), true);
  if ("notice" in status) assert.match(textContent(find(render(), "p", node => textContent(node).includes("trunk"))), /main is a trunk/);
});

it("hides the Stack tab when gh stack is missing", async () => {
  const { render, available } = await stackPane(async () => ({ available: false, conflicts: [], rebasing: false }));
  assert.equal(available(), false);
  assert.equal(render(), null);
});

it("opens Create stack with the default trunk and the current branch, then sends the ordered branches", async () => {
  const calls: any[] = [];
  const { render } = await stackPane(async input => { calls.push(input); return input.type === "stack_status" ? createStatus() : "Stack created"; });
  const trunk = () => find(render(), "Select", node => node.props.name === "trunk");
  const add = () => find(render(), "Select", node => node.props.name === "branch");
  const rows = () => findAll(find(render(), "ol", node => node.props["aria-label"] === "Branches to register"), "li").map(textContent);
  const click = (label: string) => find(render(), "Button", node => node.props["aria-label"] === label).props.onClick();
  assert.equal(trunk().props.value, "main");
  assert.deepEqual(rows(), ["feature"]);
  assert.deepEqual(findAll(add(), "SelectItem").map(node => node.props.value), ["develop", "second"]);
  add().props.onValueChange("second");
  add().props.onValueChange("develop");
  assert.deepEqual(rows(), ["develop", "second", "feature"]);
  assert.deepEqual(findAll(add(), "SelectItem"), []);
  click("Move develop down");
  assert.deepEqual(rows(), ["second", "develop", "feature"]);
  click("Move feature up");
  assert.deepEqual(rows(), ["second", "feature", "develop"]);
  click("Remove second");
  assert.deepEqual(rows(), ["feature", "develop"]);
  trunk().props.onValueChange("develop");
  assert.deepEqual(rows(), ["feature"]);
  trunk().props.onValueChange("main");
  add().props.onValueChange("second");
  assert.deepEqual(calls.filter(call => call.type === "change_stack"), []);
  findButton(render(), "Create stack").props.onClick();
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find(call => call.type === "change_stack"))), { type: "change_stack", sessionId: "session", input: { action: "init", branches: ["feature", "second"], trunk: "main" } });
});

it("keeps Create stack unavailable until a trunk and a branch are chosen", async () => {
  const { render } = await stackPane(async () => createStatus({ trunk: undefined }));
  find(render(), "SelectValue", node => node.props.children === "Choose the trunk");
  assert.equal(findButton(render(), "Create stack").props.disabled, true);
  find(render(), "Select", node => node.props.name === "trunk").props.onValueChange("main");
  assert.equal(findButton(render(), "Create stack").props.disabled, false);
  find(render(), "Button", node => node.props["aria-label"] === "Remove feature").props.onClick();
  assert.equal(findButton(render(), "Create stack").props.disabled, true);
});

it("lists the registered branches from top to bottom with the trunk last and their states in words", async () => {
  const url = (number: number) => `https://github.com/test/repo/pull/${number}`;
  const { render } = await stackPane(async () => ({ available: true, conflicts: [], rebasing: false, view: { trunk: "main", currentBranch: "middle", branches: [
    { name: "bottom", isCurrent: false, isMerged: true, isQueued: false, needsRebase: false, pr: { number: 1, state: "MERGED", url: url(1), title: "Bottom change" } },
    { name: "middle", isCurrent: true, isMerged: false, isQueued: true, needsRebase: false, pr: { number: 2, state: "OPEN", url: url(2), title: "Middle change" } },
    { name: "top", isCurrent: false, isMerged: false, isQueued: false, needsRebase: true },
  ] } }));
  const items = findAll(find(render(), "ol", node => node.props["aria-label"] === "Stack branches"), "li");
  assert.equal(items.length, 4);
  assert.match(textContent(items[0]), /^top.*No pull request.*Needs rebase/);
  assert.match(textContent(items[1]), /^middle.*Middle change.*#2 Open.*Queued.*Current/);
  assert.match(textContent(items[2]), /^bottom.*Bottom change.*#1 Merged/);
  assert.match(textContent(items[3]), /^main.*Trunk/);
  assert.equal(find(items[1]!, "a").props.href, url(2));
  assert.equal(findButton(items[1]!, "Switch").props.disabled, true);
  assert.equal(findButton(items[0]!, "Switch").props.disabled, false);
  for (const label of ["Rebase", "Submit stack", "Sync stack"]) findButton(render(), label);
  assert.throws(() => findButton(render(), "Create stack"));
});

it("reviews Submit and confirms it with the review token", async () => {
  const calls: any[] = [];
  const { view } = managedStack([{ name: "feature", pr: { number: 3 } }]);
  const { render } = await stackPane(async input => {
    calls.push(input);
    if (input.type === "prepare_stack") return { token: "reviewed", action: "submit", view };
    return input.type === "stack_status" ? { available: true, conflicts: [], rebasing: false, view } : "Submitted";
  });
  findButton(render(), "Submit stack").props.onClick();
  await flush();
  assert.match(textContent(find(render(), "section", node => node.props["aria-label"] === "Confirm Stack operation")), /feature · #3 OPEN/);
  assert.deepEqual(calls.filter(call => call.type === "change_stack"), []);
  findButton(render(), "Confirm and submit").props.onClick();
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find(call => call.type === "change_stack").input)), { action: "submit", token: "reviewed" });
});

it("reads the stack again when the branch, head or pull request changes, and ignores a late response", async () => {
  const pending: ((value: unknown) => void)[] = [];
  const pane = component("stack-pane", () => new Promise(resolve => pending.push(resolve)));
  const state = { revision: "a", branch: "feature", head: "h1", changed: 0, ahead: 0, behind: 0, upstream: true };
  const render = (git: object) => pane.render("StackPane", { sessionId: "session", git, onChange() {} });
  const load = () => pane.effects.at(-2)!;
  render(state);
  const first = load().deps;
  render({ ...state, revision: "b", changed: 3 });
  assert.deepEqual(load().deps, first);
  for (const change of [{ branch: "other" }, { head: "h2" }, { pr: { number: 9, state: "OPEN" } }]) {
    render({ ...state, ...change });
    assert.notDeepEqual(load().deps, first);
  }
  render(state);
  load()();
  render({ ...state, head: "h2" });
  load()();
  pending[1]!({ available: true, conflicts: [], rebasing: false, ...managedStack([{ name: "newer" }]) });
  await flush();
  pending[0]!({ available: true, conflicts: [], rebasing: false, ...managedStack([{ name: "older" }]) });
  await flush();
  const tree = JSON.stringify(render({ ...state, head: "h2" }));
  assert.match(tree, /newer/);
  assert.doesNotMatch(tree, /older/);
});

it("Pull uses the Git State branch and shows only for a clean branch that is behind", async () => {
  const calls: any[] = [];
  gitState = { revision: "a", branch: "feature", head: "h", changed: 0, ahead: 0, behind: 2, upstream: true };
  const pane = component("git-pane", async input => { calls.push(input); });
  const render = () => pane.render("GitPane", { sessionId: "session" });
  findButton(render(), "Pull").props.onClick();
  assert.equal(calls.at(-1).type, "pull_branch");
  assert.equal(calls.at(-1).branch, "feature");
  for (let i = 0; i < 10; i++) await Promise.resolve();
  gitState = { ...gitState as object, changed: 1 };
  assert.throws(() => findButton(render(), "Pull"));
  gitState = { ...gitState as object, changed: 0, behind: 0 };
  assert.throws(() => findButton(render(), "Pull"));
  gitState = undefined;
});

it("offers Push and not Pull when the branch has diverged", () => {
  gitState = { revision: "a", branch: "feature", head: "h", defaultBranch: "main", changed: 0, ahead: 1, behind: 2, upstream: true };
  const pane = component("git-pane", async () => undefined);
  const header = find(pane.render("GitPane", { sessionId: "session" }), "header");
  assert.throws(() => findButton(header, "Pull"));
  findButton(header, "Push");
  assert.equal(textContent(find(header, "p", node => textContent(node).includes("diverged"))), "This branch and its upstream have diverged.");
  gitState = undefined;
});

it("tells the user to rebase or merge in the Shell when a diverged branch has no Push step", () => {
  gitState = { revision: "a", branch: "main", head: "h", defaultBranch: "main", changed: 0, ahead: 1, behind: 2, upstream: true };
  const pane = component("git-pane", async () => undefined);
  const header = find(pane.render("GitPane", { sessionId: "session" }), "header");
  assert.throws(() => findButton(header, "Push"));
  assert.throws(() => findButton(header, "Pull"));
  assert.equal(textContent(find(header, "p", node => textContent(node).includes("diverged"))), "This branch and its upstream have diverged. Rebase or merge in the Shell.");
  gitState = undefined;
});

function findAll(element: any, type: string, matches: (element: Element) => boolean = () => true): Element[] {
  const found = element?.type === type && matches(element) ? [element] : [];
  for (const child of [element?.props?.children].flat(Infinity)) if (child && typeof child === "object") found.push(...findAll(child, type, matches));
  return found;
}
const actionsUrl = (run: number, job: number) => `https://github.com/test/repo/actions/runs/${run}/job/${job}`;
function prDetails(extra: Record<string, unknown> = {}) {
  return {
    repo: "test/repo", id: "PR_one", number: 1, url: "https://github.com/test/repo/pull/1", title: "Change", body: "Body", state: "OPEN", isDraft: false, reviewDecision: null, updatedAt: "u0",
    author: "user", headRefName: "feature", headRefOid: "a".repeat(40), baseRefName: "main", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", viewerCanComment: true, mergeMethods: ["SQUASH", "REBASE"],
    checks: [
      { name: "lint", status: "SUCCESS", url: actionsUrl(9, 1), runId: 9, jobId: 1 },
      { name: "test a", status: "FAILURE", url: actionsUrl(7, 2), runId: 7, jobId: 2 },
      { name: "test b", status: "FAILURE", url: actionsUrl(7, 3), runId: 7, jobId: 3 },
      { name: "deploy", status: "FAILURE", url: actionsUrl(8, 4), runId: 8, jobId: 4 },
      { name: "external", status: "ERROR", url: "https://ci.example.com/1" },
    ],
    comments: [{ id: "C1", author: "a", body: "first", url: "https://github.com/c1", createdAt: "2025-01-02" }],
    reviews: [{ id: "R1", author: "b", body: "", url: "https://github.com/r1", createdAt: "2025-01-01", state: "APPROVED" }],
    threads: [
      { id: "T_resolved", path: "a.ts", line: 1, isOutdated: false, isResolved: true, viewerCanReply: true, viewerCanResolve: true, viewerCanUnresolve: true, diffHunk: "@@ -1 +1 @@", comments: [] },
      { id: "T_open", path: "b.ts", line: 2, isOutdated: false, isResolved: false, viewerCanReply: true, viewerCanResolve: true, viewerCanUnresolve: true, diffHunk: "@@ -2 +2 @@", comments: [] },
    ],
    ...extra,
  };
}
const prRef = { repo: "test/repo", number: 1, id: "PR_one" };
function prPane(details: Record<string, unknown> = prDetails(), read?: () => Promise<unknown>, write?: (input: any) => Promise<unknown>) {
  const calls: any[] = [];
  const listeners: Record<string, (() => void)[]> = {};
  const document = { visibilityState: "visible", addEventListener: (type: string, listener: () => void) => { (listeners[type] ??= []).push(listener); }, removeEventListener: (type: string, listener: () => void) => { listeners[type] = (listeners[type] ?? []).filter(value => value !== listener); } };
  const pane = component("pull-request-pane", async input => {
    calls.push(input);
    if (input.type === "pull_request") return read ? read() : details;
    if (write) return write(input);
    if (input.type === "suggest_git_text") return { title: "Suggested", body: "Suggested body" };
  }, { document });
  const added: string[] = [];
  const draft = { result: "added" };
  const props: Record<string, unknown> = { sessionId: "session", revision: 0, disabled: false, onAvailable() {}, onChange() {}, onAddToDraft(block: string) { added.push(block); return draft.result; } };
  const render = () => pane.render("PullRequestPane", props);
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  const load = async (revision = 0) => { props.revision = revision; render(); pane.effects.at(-1)!(); await flush(); };
  return { calls, render, flush, load, document, listeners, added, draft, props, effects: pane.effects, writes: () => calls.filter(call => call.type !== "pull_request") };
}
const section = (tree: Element, value: string) => find(tree, "AccordionItem", node => node.props.value === value);

it("shows the pull request in sections with counts, failing checks first and resolved threads collapsed", async () => {
  const { render, load } = prPane();
  await load();
  const sections = find(render(), "Accordion", node => node.props["aria-label"] === "Pull request sections");
  assert.deepEqual(findAll(sections, "AccordionItem").filter(node => ["overview", "checks", "threads", "discussion"].includes(node.props.value)).map(node => node.props.value), ["overview", "checks", "threads", "discussion"]);
  assert.equal(textContent(find(section(render(), "checks"), "AccordionTrigger")), "Checks (5)");
  assert.equal(textContent(find(section(render(), "threads"), "AccordionTrigger")), "Review threads (2)");
  assert.equal(textContent(find(section(render(), "discussion"), "AccordionTrigger")), "Comments and reviews (2)");
  const checks = find(section(render(), "checks"), "AccordionContent");
  assert.equal(textContent(find(checks, "p")), "1 passed · 4 failed · 0 pending");
  assert.deepEqual(findAll(find(checks, "ul"), "a").map(textContent), ["test a", "test b", "deploy", "external", "lint"]);
  assert.equal(find(checks, "a", node => textContent(node) === "external").props.href, "https://ci.example.com/1");
  const threads = find(render(), "Accordion", node => node.props["aria-label"] === "Review threads");
  assert.deepEqual([...threads.props.value], ["T_open"]);
  assert.deepEqual(findAll(threads, "AccordionItem").map(node => node.props.value), ["T_open", "T_resolved"]);
  threads.props.onValueChange(["T_open", "T_resolved"]);
  assert.deepEqual([...find(render(), "Accordion", node => node.props["aria-label"] === "Review threads").props.value], ["T_open", "T_resolved"]);
});

it("shows one re-run button for each failed GitHub Actions run", async () => {
  const { render, load, writes } = prPane();
  await load();
  const buttons = findAll(render(), "Button", node => textContent(node.props.children) === "Re-run failed jobs");
  assert.equal(buttons.length, 2);
  buttons[0]!.props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(writes())), [{ type: "rerun_pull_request_checks", sessionId: "session", input: { pr: prRef, runId: 7 } }]);
});

const checkRow = (tree: Element, name: string) => findAll(find(section(tree, "checks"), "ul"), "li").find(node => textContent(find(node, "a")) === name)!;
const rowStatus = (row: Element) => textContent(find(row, "span", node => node.props.role === "status"));

it("adds a review thread to the Draft and sends nothing", async () => {
  const thread = { ...prDetails().threads[1], isOutdated: true, comments: [{ id: "C2", author: "alice", body: "Rename this.", url: "https://github.com/c2", createdAt: "2025-01-03" }] };
  const { render, load, flush, added, writes } = prPane(prDetails({ threads: [thread] }));
  await load();
  const item = () => find(render(), "AccordionItem", node => node.props.value === "T_open");
  findButton(item(), "Add to Draft").props.onClick();
  await flush();
  assert.deepEqual(added, [threadDraftBlock(thread as never)]);
  assert.deepEqual(writes(), []);
  assert.equal(rowStatus(item()), "Added to Draft.");
  findButton(item(), "Add to Draft").props.onClick();
  assert.equal(added.length, 2);
});

it("reads the log of a failed Actions check once, then adds it to the Draft", async () => {
  let answer!: (value: unknown) => void;
  const { render, load, flush, added, writes } = prPane(undefined, undefined, input => input.type === "pull_request_check_log" ? new Promise(resolve => { answer = resolve; }) : Promise.resolve());
  await load();
  const check = prDetails().checks[1]!;
  findButton(checkRow(render(), "test a"), "Add to Draft").props.onClick();
  findButton(checkRow(render(), "test a"), "Add to Draft").props.onClick();
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(writes())), [{ type: "pull_request_check_log", sessionId: "session", pr: prRef, jobId: 2 }]);
  assert.equal(findButton(checkRow(render(), "test a"), "Add to Draft").props.disabled, true);
  assert.deepEqual(added, []);
  answer({ text: "error: failed", truncated: true });
  await flush();
  assert.deepEqual(added, [checkDraftBlock(check, { text: "error: failed", truncated: true })]);
  assert.equal(rowStatus(checkRow(render(), "test a")), "Added to Draft.");
  assert.throws(() => findButton(checkRow(render(), "lint"), "Add to Draft"));
});

it("adds a check that is not a GitHub Actions job with its name and URL only", async () => {
  const { render, load, flush, added, writes } = prPane();
  await load();
  findButton(checkRow(render(), "external"), "Add to Draft").props.onClick();
  await flush();
  assert.deepEqual(writes(), []);
  assert.deepEqual(added, ["Failed check: external\nURL: https://ci.example.com/1"]);
  assert.equal(rowStatus(checkRow(render(), "external")), "Added to Draft without a log. This check is not a GitHub Actions job.");
});

it("adds nothing and shows the daemon's message when it refuses the log read", async () => {
  const { render, load, flush, added } = prPane(undefined, undefined, input => input.type === "pull_request_check_log" ? Promise.reject(new Error("The branch's pull request has changed. Reload it before continuing.")) : Promise.resolve());
  await load();
  findButton(checkRow(render(), "deploy"), "Add to Draft").props.onClick();
  await flush();
  assert.deepEqual(added, []);
  assert.equal(rowStatus(checkRow(render(), "deploy")), "Error: The branch's pull request has changed. Reload it before continuing.");
  assert.equal(findButton(checkRow(render(), "deploy"), "Add to Draft").props.disabled, false);
});

it("keeps each Add to Draft status element mounted before the first message", async () => {
  const { render, load } = prPane();
  await load();
  assert.equal(rowStatus(checkRow(render(), "deploy")), "");
  assert.equal(rowStatus(find(render(), "AccordionItem", node => node.props.value === "T_open")), "");
});

for (const [result, message] of [["question", "Answer the question first. Then add to the Draft."], ["locked", "This Agent Session cannot take a message. Nothing was added."]] as const) it(`says why nothing was added when the composer answers ${result}`, async () => {
  const { render, load, flush, draft } = prPane();
  await load();
  draft.result = result;
  const item = () => find(render(), "AccordionItem", node => node.props.value === "T_open");
  findButton(item(), "Add to Draft").props.onClick();
  await flush();
  assert.equal(rowStatus(item()), message);
  findButton(checkRow(render(), "external"), "Add to Draft").props.onClick();
  await flush();
  assert.equal(rowStatus(checkRow(render(), "external")), message);
});

it("adds a check with its name and URL only when the log cannot be read", async () => {
  const { render, load, flush, added } = prPane(undefined, undefined, input => input.type === "pull_request_check_log" ? Promise.resolve(null) : Promise.resolve());
  await load();
  findButton(checkRow(render(), "deploy"), "Add to Draft").props.onClick();
  await flush();
  assert.deepEqual(added, [checkDraftBlock(prDetails().checks[3]!)]);
  assert.equal(rowStatus(checkRow(render(), "deploy")), "Added to Draft without a log. The job log could not be read or is too large.");
  assert.throws(() => find(render(), "p", node => node.props.role === "alert"));
});

it("keeps typed reply and comment text across a reload", async () => {
  const { render, load, flush, calls } = prPane();
  await load();
  const reply = () => find(find(render(), "form", node => node.props["aria-label"] === "Reply to thread in b.ts line 2"), "Textarea");
  const comment = () => find(find(render(), "form", node => node.props["aria-label"] === "Add comment"), "Textarea");
  reply().props.onChange({ target: { value: "typed reply" } });
  comment().props.onChange({ target: { value: "typed comment" } });
  await load(1);
  assert.equal(calls.filter(call => call.type === "pull_request").length, 2);
  assert.equal(reply().props.value, "typed reply");
  assert.equal(comment().props.value, "typed comment");
  find(render(), "form", node => node.props["aria-label"] === "Reply to thread in b.ts line 2").props.onSubmit({ preventDefault() {} });
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find(call => call.type === "comment_pull_request"))), { type: "comment_pull_request", sessionId: "session", input: { pr: prRef, body: "typed reply", threadId: "T_open" } });
  assert.equal(reply().props.value, "");
  assert.equal(comment().props.value, "typed comment");
  assert.equal(calls.filter(call => call.type === "pull_request").length, 3);
});

it("edits the title and body, and fills them from Suggest only on click", async () => {
  const { render, load, flush, writes } = prPane();
  await load();
  findButton(render(), "Edit").props.onClick();
  const form = () => find(render(), "form", node => node.props["aria-label"] === "Edit pull request");
  const title = () => find(form(), "Input");
  const body = () => find(form(), "Textarea");
  assert.equal(title().props.value, "Change");
  assert.equal(body().props.value, "Body");
  await flush();
  assert.deepEqual(writes(), []);
  findButton(render(), "Suggest").props.onClick();
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(writes())), [{ type: "suggest_git_text", sessionId: "session", kind: "pull_request" }]);
  assert.equal(title().props.value, "Suggested");
  assert.equal(body().props.value, "Suggested body");
  title().props.onChange({ target: { value: "Final" } });
  await load(1);
  assert.equal(title().props.value, "Final");
  find(render(), "form", node => node.props["aria-label"] === "Edit pull request").props.onSubmit({ preventDefault() {} });
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(writes().at(-1))), { type: "edit_pull_request", sessionId: "session", input: { pr: prRef, title: "Final", body: "Suggested body" } });
  assert.throws(() => find(render(), "form", node => node.props["aria-label"] === "Edit pull request"));
});

for (const draft of [true, false]) it(`${draft ? "marks a draft ready for review" : "converts an open pull request to a draft"}`, async () => {
  const { render, load, writes } = prPane(prDetails({ isDraft: draft }));
  await load();
  findButton(render(), draft ? "Ready for review" : "Convert to draft").props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(writes())), [{ type: "set_pull_request_draft", sessionId: "session", input: { pr: prRef, draft: !draft } }]);
});

for (const action of ["merge", "rebase"]) it(`PR ${action} requires confirmation and sends the PR identity shown when it opened`, async () => {
  let details = prDetails();
  const { render, load, flush, writes } = prPane(undefined, async () => details);
  await load();
  findButton(render(), action === "merge" ? "Merge" : "Rebase").props.onClick();
  assert.deepEqual(writes(), []);
  assert.throws(() => find(render(), "select"));
  if (action === "merge") {
    const select = find(render(), "Select");
    assert.equal(select.props.value, "SQUASH");
    assert.equal(findAll(select, "SelectItem").length, 2);
    select.props.onValueChange("REBASE");
  } else assert.match(JSON.stringify(render()), /No push or stack rebase/);
  details = prDetails({ headRefOid: "b".repeat(40) });
  await load(1);
  find(render(), "form", node => node.props["aria-label"] === (action === "merge" ? "Confirm merge" : "Confirm rebase")).props.onSubmit({ preventDefault() {} });
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(writes())), [{ type: "change_pull_request", sessionId: "session", action, input: { pr: prRef, headOid: "a".repeat(40), baseBranch: "main", ...(action === "merge" ? { method: "REBASE" } : {}) } }]);
});

it("PR merge is unavailable without a permitted method or for a draft", async () => {
  for (const extra of [{ mergeMethods: [] }, { mergeMethods: ["MERGE"], isDraft: true }]) {
    const { render, load } = prPane(prDetails(extra));
    await load();
    assert.equal(findButton(render(), "Merge").props.disabled, true);
  }
});

it("has no Refresh of its own; the Git pane header owns Refresh", async () => {
  const { render, load } = prPane();
  await load();
  assert.throws(() => findButton(render(), "Refresh"));
});

it("sends one pull_request read after a comment, an edit and a manual Refresh", async () => {
  let details = prDetails();
  const { render, load, flush, calls, props, effects } = prPane(undefined, async () => details);
  const reads = () => calls.filter(call => call.type === "pull_request").length;
  const summarize = async (summary: Record<string, unknown> = {}) => {
    props.summary = { number: 1, url: details.url, state: details.state, isDraft: details.isDraft, checks: "failing", checksCompleted: 5, reviewDecision: null, unresolvedThreads: 1, updatedAt: details.updatedAt, ...summary };
    render();
    effects.at(-2)!();
    await flush();
  };
  await summarize();
  await load();
  assert.equal(reads(), 1);
  details = { ...details, updatedAt: "u1" };
  find(find(render(), "form", node => node.props["aria-label"] === "Add comment"), "Textarea").props.onChange({ target: { value: "typed comment" } });
  find(render(), "form", node => node.props["aria-label"] === "Add comment").props.onSubmit({ preventDefault() {} });
  await flush();
  await summarize();
  assert.equal(reads(), 2);
  details = { ...details, updatedAt: "u2", title: "Final" };
  findButton(render(), "Edit").props.onClick();
  find(render(), "form", node => node.props["aria-label"] === "Edit pull request").props.onSubmit({ preventDefault() {} });
  await flush();
  await summarize();
  assert.equal(reads(), 3);
  details = { ...details, updatedAt: "u3" };
  await load(1);
  await summarize();
  assert.equal(reads(), 4);
  await summarize({ checks: "passing" });
  assert.equal(reads(), 5);
  await summarize({ unresolvedThreads: 0 });
  assert.equal(reads(), 6);
  await summarize({ reviewDecision: "APPROVED" });
  assert.equal(reads(), 7);
});

it("reads again when the document becomes visible", async () => {
  const { calls, load, listeners, flush } = prPane();
  await load();
  for (const listener of listeners.visibilitychange ?? []) listener();
  await flush();
  assert.equal(calls.filter(call => call.type === "pull_request").length, 2);
});

it("prefixes only a failed read with the last-read notice", async () => {
  let fail = false;
  const { render, load, flush } = prPane(undefined, async () => { if (fail) throw new Error("offline"); return prDetails(); }, async () => { throw new Error("denied"); });
  await load();
  findButton(render(), "Convert to draft").props.onClick();
  await flush();
  assert.equal(textContent(find(render(), "p", node => node.props.role === "alert")), "Error: denied");
  fail = true;
  await load(1);
  assert.match(textContent(find(render(), "p", node => node.props.role === "alert")), /^Showing the last pull request read\. Pull request could not be read\. Error: offline$/);
});

it("keeps typed comment text and shows the error when the comment fails", async () => {
  const { render, load, flush } = prPane(undefined, undefined, async () => { throw new Error("locked"); });
  await load();
  const form = () => find(render(), "form", node => node.props["aria-label"] === "Add comment");
  find(form(), "Textarea").props.onChange({ target: { value: "typed comment" } });
  form().props.onSubmit({ preventDefault() {} });
  await flush();
  assert.equal(find(form(), "Textarea").props.value, "typed comment");
  assert.match(textContent(find(render(), "p", node => node.props.role === "alert")), /locked/);
});

it("disables every action while a write is in flight", async () => {
  let release!: () => void;
  const { render, load, flush } = prPane(undefined, undefined, () => new Promise<void>(resolve => { release = resolve; }));
  await load();
  find(find(render(), "form", node => node.props["aria-label"] === "Reply to thread in b.ts line 2"), "Textarea").props.onChange({ target: { value: "reply" } });
  findButton(render(), "Convert to draft").props.onClick();
  const buttons = findAll(render(), "Button");
  assert.ok(buttons.length >= 9);
  for (const button of buttons) assert.equal(Boolean(button.props.disabled), textContent(button.props.children) !== "Add to Draft", textContent(button.props.children));
  for (const field of findAll(render(), "Textarea")) assert.equal(field.props.disabled, true);
  release();
  await flush();
  assert.equal(findButton(render(), "Convert to draft").props.disabled, false);
});

it("shows an alert and keeps the typed title and body when Suggest fails", async () => {
  const { render, load, flush } = prPane(undefined, undefined, async () => { throw new Error("no model"); });
  await load();
  findButton(render(), "Edit").props.onClick();
  const form = () => find(render(), "form", node => node.props["aria-label"] === "Edit pull request");
  find(form(), "Input").props.onChange({ target: { value: "Typed title" } });
  find(form(), "Textarea").props.onChange({ target: { value: "Typed body" } });
  findButton(render(), "Suggest").props.onClick();
  await flush();
  assert.match(textContent(find(render(), "p", node => node.props.role === "alert")), /^No suggestion\. Error: no model$/);
  assert.equal(find(form(), "Input").props.value, "Typed title");
  assert.equal(find(form(), "Textarea").props.value, "Typed body");
});

it("closes the Edit form on Cancel and opens it again with the current title and body", async () => {
  let details = prDetails();
  const { render, load } = prPane(undefined, async () => details);
  await load();
  findButton(render(), "Edit").props.onClick();
  const form = () => find(render(), "form", node => node.props["aria-label"] === "Edit pull request");
  find(form(), "Input").props.onChange({ target: { value: "Discarded" } });
  findButton(form(), "Cancel").props.onClick();
  assert.throws(() => form());
  details = prDetails({ title: "Renamed", body: "New body" });
  await load(1);
  findButton(render(), "Edit").props.onClick();
  assert.equal(find(form(), "Input").props.value, "Renamed");
  assert.equal(find(form(), "Textarea").props.value, "New body");
});

for (const next of [null, "other"]) it(`closes the Merge, Rebase and Edit forms when the pull request becomes ${next ?? "absent"}`, async () => {
  for (const [button, label] of [["Merge", "Confirm merge"], ["Rebase", "Confirm rebase"], ["Edit", "Edit pull request"]]) {
    let details: unknown = prDetails();
    const { render, load } = prPane(undefined, async () => details);
    await load();
    findButton(render(), button!).props.onClick();
    find(render(), "form", node => node.props["aria-label"] === label);
    details = next === null ? null : prDetails({ id: "PR_two", number: 2 });
    await load(1);
    assert.throws(() => find(render(), "form", node => node.props["aria-label"] === label), label);
    if (next) {
      details = prDetails();
      await load(2);
      assert.throws(() => find(render(), "form", node => node.props["aria-label"] === label), label);
    }
  }
});

it("keeps a typed reply on its thread when a reload reorders the threads", async () => {
  let details = prDetails();
  const { render, load } = prPane(undefined, async () => details);
  await load();
  const reply = (place: string) => find(find(render(), "form", node => node.props["aria-label"] === `Reply to thread in ${place}`), "Textarea");
  reply("b.ts line 2").props.onChange({ target: { value: "on b" } });
  const threads = (details as any).threads as any[];
  details = prDetails({ threads: [{ ...threads[0], isResolved: false }, { ...threads[1], isResolved: true }] });
  await load(1);
  assert.deepEqual(findAll(find(render(), "Accordion", node => node.props["aria-label"] === "Review threads"), "AccordionItem").map(node => node.props.value), ["T_resolved", "T_open"]);
  assert.equal(reply("b.ts line 2").props.value, "on b");
  assert.equal(reply("a.ts line 1").props.value, "");
});

it("keeps the newest pull request read when an older response arrives last", async () => {
  const pending: ((value: unknown) => void)[] = [];
  const { render, load, flush } = prPane(undefined, () => new Promise(resolve => pending.push(resolve)));
  await load(0);
  await load(1);
  pending[1]!(prDetails({ title: "Newest" }));
  await flush();
  pending[0]!(prDetails({ title: "Oldest" }));
  await flush();
  const overview = textContent(section(render(), "overview"));
  assert.match(overview, /Newest/);
  assert.doesNotMatch(overview, /Oldest/);
});

it("Stack changes immediately replace the PR pane", () => {
  const pane = component("git-pane", async () => undefined);
  const before = pane.render("GitPane", { sessionId: "session" });
  find(before, "StackPane").props.onChange();
  const after = pane.render("GitPane", { sessionId: "session" });
  assert.notEqual(find(before, "PullRequestPane").key, find(after, "PullRequestPane").key);
});

function pushPane(replaced: string[]) {
  const calls: any[] = [];
  gitState = { revision: "a", branch: "feature", head: "b".repeat(40), changed: 0, ahead: 1, behind: 1, upstream: true };
  const pane = component("git-pane", async input => {
    calls.push(input);
    if (input.type === "push_state") return { branch: "feature", head: "b".repeat(40), remote: "c".repeat(40), replaced };
  });
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  return { calls, flush, render: () => pane.render("GitPane", { sessionId: "session" }) };
}

it("pushes at once when the push replaces no remote commits", async () => {
  const { calls, flush, render } = pushPane([]);
  assert.equal(findButton(render(), "Push").props.variant, "default");
  findButton(render(), "Push").props.onClick();
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), { type: "push", sessionId: "session", head: "b".repeat(40) });
  assert.match(textContent(find(render(), "p", node => node.props.role === "status").props.children), /Pushed feature/);
  gitState = undefined;
});

it("shows the commits a push replaces and pushes with replace only after confirmation", async () => {
  const { calls, flush, render } = pushPane(["ccccccc remote work"]);
  findButton(render(), "Push").props.onClick();
  await flush();
  assert.equal(calls.filter(call => call.type === "push").length, 0);
  const confirm = find(render(), "section", node => node.props["aria-label"] === "Confirm push");
  assert.match(textContent(confirm), /ccccccc remote work/);
  findButton(confirm, "Replace and push").props.onClick();
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), { type: "push", sessionId: "session", head: "b".repeat(40), replace: "c".repeat(40) });
  assert.throws(() => find(render(), "section", node => node.props["aria-label"] === "Confirm push"));
  gitState = undefined;
});

it("shows the next step first and the other steps as secondary actions", () => {
  gitState = { revision: "a", branch: "feature", head: "h", changed: 2, ahead: 1, behind: 0, upstream: true };
  const pane = component("git-pane", async () => undefined);
  const render = () => pane.render("GitPane", { sessionId: "session" });
  assert.equal(findButton(render(), "Commit").props.variant, "default");
  assert.equal(findButton(render(), "Push").props.variant, "outline");
  find(render(), "GitChanges").props.onViewChange("branch");
  findButton(render(), "Commit").props.onClick();
  assert.equal(find(render(), "GitChanges").props.view, "uncommitted");
  gitState = { ...gitState as object, changed: 0, ahead: 0 };
  findButton(render(), "Create pull request").props.onClick();
  assert.equal(find(render(), "GitPullRequestForm").props.head, "h");
  gitState = undefined;
});

function commitForm(props: Record<string, unknown>, suggestion: Record<string, string> = {}) {
  const calls: any[] = [];
  const pane = component("git-commit-form", async input => { calls.push(input); return input.type === "commit" ? "d".repeat(40) : { [input.kind === "branch" ? "branch" : "message"]: suggestion[input.kind === "branch" ? "branch" : "message"] }; });
  const all: Record<string, any> = { sessionId: "session", paths: ["a.ts"], fingerprint: "f", branch: "feature", defaultBranch: "main", canRename: false, message: "", branchName: "", onCommitted() {}, ...props };
  const set = (key: string) => (value: any) => { all[key] = typeof value === "function" ? value(all[key]) : value; };
  all.onMessage = set("message");
  all.onBranchName = set("branchName");
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  return { calls, flush, render: () => pane.render("GitCommitForm", all) };
}
const submit = (tree: Element) => find(tree, "Button", node => node.props.type === "submit");

it("sends the selected files as paths", async () => {
  const { pane, flush } = changesPane();
  const props = changesProps("a");
  pane.render("GitChanges", props);
  pane.effects.at(-1)!();
  await flush();
  const checkbox = (path: string) => find(pane.render("GitChanges", props), "Checkbox", node => node.props["aria-label"] === `Commit ${path}`);
  assert.equal(checkbox("a.ts").props.checked, true);
  assert.equal(checkbox("b.ts").props.checked, true);
  checkbox("b.ts").props.onCheckedChange(false);
  assert.equal(checkbox("b.ts").props.checked, false);
  assert.deepEqual(find(pane.render("GitChanges", props), "GitCommitForm").props.paths, ["a.ts"]);
  const form = commitForm({ paths: ["a.ts"] });
  find(form.render(), "Textarea").props.onChange({ target: { value: "Add a" } });
  find(form.render(), "form").props.onSubmit({ preventDefault() {} });
  await form.flush();
  assert.deepEqual(JSON.parse(JSON.stringify(form.calls)), [{ type: "commit", sessionId: "session", fingerprint: "f", paths: ["a.ts"], message: "Add a" }]);
});

for (const branch of ["main", undefined]) it(`requires a new branch name ${branch ? "on the default branch" : "on a detached HEAD"}`, async () => {
  const { calls, flush, render } = commitForm({ branch });
  const input = () => find(render(), "Input");
  assert.equal(input().props.required, true);
  find(render(), "Textarea").props.onChange({ target: { value: "Add a" } });
  assert.equal(submit(render()).props.disabled, true);
  input().props.onChange({ target: { value: " feat/a " } });
  assert.equal(submit(render()).props.disabled, false);
  find(render(), "form").props.onSubmit({ preventDefault() {} });
  await flush();
  assert.equal(calls[0].branch, "feat/a");
});

it("offers an optional rename only when the branch can be renamed", () => {
  assert.throws(() => find(commitForm({}).render(), "Input"));
  assert.equal(find(commitForm({ canRename: true }).render(), "Input").props.required, false);
});

it("fills only empty fields from a suggestion, and only on click", async () => {
  const { calls, flush, render } = commitForm({ branch: "main" }, { message: "Model message", branch: "feat/model" });
  const suggest = (label: string) => find(render(), "Button", node => node.props["aria-label"] === label);
  assert.equal(calls.length, 0);
  find(render(), "Textarea").props.onChange({ target: { value: "Typed message" } });
  suggest("Suggest commit message").props.onClick();
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ type: "suggest_git_text", sessionId: "session", kind: "commit", paths: ["a.ts"] }]);
  assert.equal(find(render(), "Textarea").props.value, "Typed message");
  assert.equal(find(render(), "Input").props.value, "");
  suggest("Suggest branch name").props.onClick();
  await flush();
  assert.equal(calls[1].kind, "branch");
  assert.equal(find(render(), "Input").props.value, "feat/model");
});

for (const fails of [false, true]) it(`opens and cancels new branch entry, then handles add ${fails ? "failure" : "success"}`, async () => {
  const calls: any[] = [];
  const pane = component("stack-pane", async input => {
    calls.push(input);
    if (input.type === "change_stack") {
      if (fails) throw new Error("Branch already exists");
      return "Branch added";
    }
    return { available: true, conflicts: [], rebasing: false, ...managedStack([{ name: "feature" }]) };
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
    assert.match(JSON.stringify(render()), /Branch added/);
    open().props.onClick();
    assert.equal(find(render(), "Input").props.value, "");
  }
});

for (const fails of [false, true]) it(`Stack checkout invalidates Git state after ${fails ? "failure" : "success"}`, async () => {
  let changes = 0;
  const status = { available: true, conflicts: [], rebasing: false, ...managedStack([{ name: "123" }]) };
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

it("copies linked titles top to bottom", async () => {
  const prs = [
    { number: 1, title: 'Base <fix> & "test"', url: "https://github.com/test/repo/pull/1", state: "MERGED" },
    { number: 2, title: "Top change", url: "https://github.com/test/repo/pull/2", state: "OPEN" },
  ];
  let copied: any[] = [];
  const pane = component("stack-pane", async () => ({ available: true, conflicts: [], rebasing: false,
    ...managedStack([{ name: "base", pr: prs[0] }, { name: "unpublished" }, { name: "top", pr: prs[1] }]),
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
    ...managedStack([{ name: "base", pr: { number: 1, title: "Base", url: "https://github.com/test/repo/pull/1" } }]),
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
    ...managedStack([{ name: "base", pr }]),
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
    ...managedStack([{ name: "merged-member", isMerged: true, pr: { number: 23, state: "CLOSED" } }]) }));
  const props = { sessionId: "session", onChange() {} };
  pane.render("StackPane", props);
  pane.effects[0]!();
  await Promise.resolve();
  const tree = pane.render("StackPane", props);
  assert.match(JSON.stringify(tree), /merged-member/);
  assert.match(JSON.stringify(tree), /#23 Merged/);
  assert.throws(() => find(tree, "Button", node => node.props.children === "Create stack"));
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

it("shows Git State and gives the PR pane the summary when the pull request summary changes", async () => {
  gitState = { revision: "a", branch: "feature", head: "h", changed: 1, ahead: 2, behind: 0, upstream: true };
  const pane = component("git-pane", async () => undefined);
  const render = () => pane.render("GitPane", { sessionId: "session" });
  render();
  const pr = find(render(), "PullRequestPane").props.revision;
  assert.equal(textContent(find(render(), "strong")), "feature");
  assert.equal(textContent(find(render(), "span", node => textContent(node).includes("ahead"))), "2 ahead, 0 behind");
  gitState = { ...gitState as object, revision: "b" };
  render();
  assert.equal(find(render(), "PullRequestPane").props.revision, pr);
  gitState = { ...gitState as object, pr: { number: 9, url: "https://github.com/test/repo/pull/9", state: "OPEN", isDraft: false, checks: "failing", reviewDecision: null, unresolvedThreads: 0 } };
  render();
  assert.equal(find(render(), "PullRequestPane").props.revision, pr);
  assert.equal(find(render(), "PullRequestPane").props.summary, (gitState as { pr: unknown }).pr);
  const link = find(render(), "a", node => textContent(node).includes("PR #9"));
  assert.equal(textContent(link), "PR #9 · Open · Checks failing");
  assert.equal(link.props.href, "https://github.com/test/repo/pull/9");
  gitState = undefined;
});

function changesPane() {
  const calls: any[] = [];
  let listed = [{ status: " M", path: "a.ts" }, { status: "??", path: "b.ts" }];
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
  const pane = component("git-changes", async input => {
    calls.push(input);
    if (input.type === "git_changes") return { files: listed, commits: input.view === "branch" ? ["abc Add a"] : [], ...(input.view === "uncommitted" ? { fingerprint: "f", branch: "feature", defaultBranch: "main", canRename: false } : {}) };
    return { text: `--- a/${input.path}\n+++ b/${input.path}\n@@ -1 +1 @@\n-old\n+${calls.length}\n` };
  });
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  return { calls, pane, flush, plain, list: (files: typeof listed) => { listed = files; }, diffs: () => calls.filter(call => call.type === "git_diff") };
}
function changesProps(revision: string) {
  const props: Record<string, unknown> = { sessionId: "session", revision, view: "uncommitted", onCommitted() {} };
  props.onViewChange = (view: string) => { props.view = view; };
  return props;
}

it("reads a file diff once when its Changes row opens", async () => {
  const { calls, pane, flush, plain, diffs } = changesPane();
  const props = changesProps("a");
  const render = () => pane.render("GitChanges", props);
  render();
  pane.effects.at(-1)!();
  await flush();
  assert.deepEqual(plain(calls), [{ type: "git_changes", sessionId: "session", view: "uncommitted" }]);
  assert.equal(find(render(), "Accordion").props.multiple, true);
  find(render(), "Accordion").props.onValueChange(["a.ts"]);
  await flush();
  assert.deepEqual(plain(diffs()), [{ type: "git_diff", sessionId: "session", view: "uncommitted", path: "a.ts" }]);
  find(render(), "Accordion").props.onValueChange(["a.ts", "b.ts"]);
  await flush();
  assert.deepEqual(diffs().map(call => call.path), ["a.ts", "b.ts"]);
  assert.match(find(find(render(), "AccordionItem", node => node.props.value === "a.ts"), "AccordionContent").props.children.props.diff.text, /\+2\n$/);
  find(render(), "Accordion").props.onValueChange(["b.ts"]);
  await flush();
  assert.equal(diffs().length, 2);
});

it("reads the Changes list and open diffs again when the revision changes", async () => {
  const { calls, pane, flush, plain, diffs } = changesPane();
  const props = changesProps("a");
  pane.render("GitChanges", props);
  pane.effects.at(-1)!();
  await flush();
  find(pane.render("GitChanges", props), "Accordion").props.onValueChange(["b.ts"]);
  await flush();
  props.revision = "b";
  pane.render("GitChanges", props);
  pane.effects.at(-1)!();
  await flush();
  assert.equal(calls.filter(call => call.type === "git_changes").length, 2);
  assert.deepEqual(diffs().map(call => call.path), ["b.ts", "b.ts"]);
});

it("switches the Changes view between uncommitted and branch", async () => {
  const { calls, pane, flush, plain } = changesPane();
  const props = changesProps("a");
  const render = () => pane.render("GitChanges", props);
  render();
  pane.effects.at(-1)!();
  await flush();
  find(render(), "Accordion").props.onValueChange(["a.ts"]);
  await flush();
  find(render(), "Tabs").props.onValueChange("branch");
  render();
  pane.effects.at(-1)!();
  await flush();
  assert.deepEqual(calls.filter(call => call.type === "git_changes").map(call => call.view), ["uncommitted", "branch"]);
  assert.deepEqual(plain(find(render(), "Accordion").props.value), []);
  assert.equal(textContent(find(render(), "ul", node => node.props["aria-label"] === "Branch commits")), "abc Add a");
});

it("keeps the newest diff when an older response arrives last", async () => {
  const pending: ((value: unknown) => void)[] = [];
  const pane = component("git-changes", input => input.type === "git_changes"
    ? Promise.resolve({ files: [{ status: " M", path: "a.ts" }], commits: [] })
    : new Promise(resolve => pending.push(resolve)));
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  const props = changesProps("a");
  const diffOf = () => find(find(pane.render("GitChanges", props), "AccordionItem", node => node.props.value === "a.ts"), "AccordionContent").props.children.props.diff;
  pane.render("GitChanges", props);
  pane.effects.at(-1)!();
  await flush();
  find(pane.render("GitChanges", props), "Accordion").props.onValueChange(["a.ts"]);
  props.revision = "b";
  pane.render("GitChanges", props);
  pane.effects.at(-1)!();
  await flush();
  assert.equal(pending.length, 2);
  pending[1]!({ text: "new" });
  await flush();
  pending[0]!({ text: "old" });
  await flush();
  assert.equal(diffOf().text, "new");
});

it("closes a row when its file leaves the list and reads no diff for it", async () => {
  const { pane, flush, plain, list, diffs } = changesPane();
  const props = changesProps("a");
  pane.render("GitChanges", props);
  pane.effects.at(-1)!();
  await flush();
  find(pane.render("GitChanges", props), "Accordion").props.onValueChange(["a.ts", "b.ts"]);
  await flush();
  list([{ status: " M", path: "a.ts" }]);
  for (const revision of ["b", "c"]) {
    props.revision = revision;
    pane.render("GitChanges", props);
    pane.effects.at(-1)!();
    await flush();
  }
  assert.deepEqual(plain(find(pane.render("GitChanges", props), "Accordion").props.value), ["a.ts"]);
  assert.deepEqual(diffs().map(call => call.path), ["a.ts", "b.ts", "a.ts", "a.ts"]);
});

it("keeps an unchecked file unchecked across a revision change and the Branch view, and selects new files", async () => {
  const { pane, flush, list } = changesPane();
  const props = changesProps("a");
  const render = () => pane.render("GitChanges", props);
  const reread = async () => { render(); pane.effects.at(-1)!(); await flush(); };
  await reread();
  const box = (path: string) => find(render(), "Checkbox", node => node.props["aria-label"] === `Commit ${path}`);
  box("b.ts").props.onCheckedChange(false);
  props.revision = "b";
  await reread();
  assert.equal(box("b.ts").props.checked, false);
  list([{ status: "A ", path: "a.ts" }]);
  find(render(), "Tabs").props.onValueChange("branch");
  await reread();
  list([{ status: " M", path: "a.ts" }, { status: "??", path: "b.ts" }, { status: "??", path: "c.ts" }]);
  find(render(), "Tabs").props.onValueChange("uncommitted");
  await reread();
  assert.equal(box("b.ts").props.checked, false);
  assert.equal(box("c.ts").props.checked, true);
  assert.deepEqual(find(render(), "GitCommitForm").props.paths, ["a.ts", "c.ts"]);
});

it("keeps the commit text across a view switch and shows no stale list after a view change", async () => {
  const { pane, flush } = changesPane();
  const props = changesProps("a");
  const render = () => pane.render("GitChanges", props);
  render(); pane.effects.at(-1)!(); await flush();
  find(render(), "GitCommitForm").props.onMessage("Keep this");
  find(render(), "GitCommitForm").props.onBranchName("feat/keep");
  props.view = "branch";
  assert.throws(() => find(render(), "Checkbox"));
  assert.throws(() => find(render(), "GitCommitForm"));
  render(); pane.effects.at(-1)!(); await flush();
  props.view = "uncommitted";
  render(); pane.effects.at(-1)!(); await flush();
  assert.equal(find(render(), "GitCommitForm").props.message, "Keep this");
  assert.equal(find(render(), "GitCommitForm").props.branchName, "feat/keep");
});

it("cancels a push replacement without pushing", async () => {
  const { calls, flush, render } = pushPane(["ccccccc remote work"]);
  findButton(render(), "Push").props.onClick();
  await flush();
  findButton(find(render(), "section", node => node.props["aria-label"] === "Confirm push"), "Cancel").props.onClick();
  assert.throws(() => find(render(), "section", node => node.props["aria-label"] === "Confirm push"));
  assert.equal(calls.filter(call => call.type === "push").length, 0);
  gitState = undefined;
});

it("shows an alert when the push state cannot be read", async () => {
  gitState = { revision: "a", branch: "feature", head: "h", changed: 0, ahead: 1, behind: 0, upstream: true };
  const pane = component("git-pane", async input => { if (input.type === "push_state") throw new Error("offline"); });
  const render = () => pane.render("GitPane", { sessionId: "session" });
  findButton(render(), "Push").props.onClick();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.match(textContent(find(render(), "p", node => node.props.role === "alert")), /offline/);
  gitState = undefined;
});

it("offers no Push on the default branch", () => {
  gitState = { revision: "a", branch: "main", defaultBranch: "main", head: "h", changed: 0, ahead: 1, behind: 0, upstream: true };
  const pane = component("git-pane", async () => undefined);
  assert.throws(() => findButton(pane.render("GitPane", { sessionId: "session" }), "Push"));
  gitState = undefined;
});

it("sends the HEAD shown when the pull request form opened and links the created pull request", () => {
  gitState = { revision: "a", branch: "feature", head: "h1", changed: 0, ahead: 0, behind: 0, upstream: true };
  const pane = component("git-pane", async () => undefined);
  const render = () => pane.render("GitPane", { sessionId: "session" });
  findButton(render(), "Create pull request").props.onClick();
  gitState = { ...gitState as object, head: "h2" };
  assert.equal(find(render(), "GitPullRequestForm").props.head, "h1");
  find(render(), "GitPullRequestForm").props.onCreated("https://github.com/test/repo/pull/6");
  const link = find(find(render(), "p", node => node.props.role === "status"), "a");
  assert.equal(link.props.href, "https://github.com/test/repo/pull/6");
  assert.match(find(render(), "p", node => node.props.role === "status").props.className, /break-all/);
  gitState = undefined;
});

it("fills the pull request title from the first branch commit and sends the form", async () => {
  const calls: any[] = [];
  let fail = false;
  const pane = component("git-pull-request-form", async input => {
    calls.push(input);
    if (input.type === "git_changes") return { files: [], commits: ["bbb Second change", "aaa First change"] };
    if (fail) throw new Error("GitHub refused");
    return "https://github.com/test/repo/pull/6";
  });
  const created: string[] = [];
  const props = { sessionId: "session", head: "h1", onCreated: (url: string) => created.push(url), onCancel() {} };
  const render = () => pane.render("GitPullRequestForm", props);
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  render(); pane.effects.at(-1)!(); await flush();
  assert.equal(find(render(), "Input").props.value, "First change");
  find(render(), "Textarea").props.onChange({ target: { value: "Body" } });
  find(render(), "Switch").props.onCheckedChange(false);
  fail = true;
  find(render(), "form").props.onSubmit({ preventDefault() {} });
  await flush();
  assert.match(textContent(find(render(), "p", node => node.props.role === "alert")), /GitHub refused/);
  fail = false;
  find(render(), "form").props.onSubmit({ preventDefault() {} });
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), { type: "create_pull_request", sessionId: "session", head: "h1", title: "First change", body: "Body", draft: false });
  assert.deepEqual(created, ["https://github.com/test/repo/pull/6"]);
});
