import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { it } from "node:test";
import { transformSync } from "esbuild";

type Element = { type: string; key?: string; props: Record<string, any> };
let repositoryState: boolean | undefined;
let gitState: { changed: number } | undefined;
const storage = new Map<string, string>();
function component(file: string, command: (input: any) => Promise<any>) {
  const states: any[] = [];
  let index = 0;
  const effects: (() => void)[] = [];
  const timers: { run: () => void; delay: number }[] = [];
  const module = { exports: {} as Record<string, (props: any) => Element> };
  const require = createRequire(import.meta.url);
  const code = transformSync(readFileSync(new URL(`../web/src/components/${file}.tsx`, import.meta.url), "utf8"), { loader: "tsx", format: "cjs", jsx: "automatic" }).code;
  const window = { setTimeout: (run: () => void, delay: number) => timers.push({ run, delay }), clearTimeout() {}, localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } };
  runInNewContext(code, { window, module, exports: module.exports, require: (name: string) => {
    if (name === "react") return {
      useState: (initial: any) => { const slot = index++; if (!(slot in states)) states[slot] = initial; return [states[slot], (value: any) => { states[slot] = typeof value === "function" ? value(states[slot]) : value; }]; },
      useEffect: (effect: () => void) => { effects.push(effect); },
      useRef: (initial: any) => { const slot = index++; if (!(slot in states)) states[slot] = { current: initial }; return states[slot]; },
    };
    if (name === "react/jsx-runtime") return require(name);
    if (name === "@/host.tsx") return { useHost: () => ({ connection: { command } }) };
    if (name === "@/git-state.ts") return { useGitState: () => ({ git: gitState, repository: repositoryState }) };
    if (name === "@/presentation/git.ts") return require("../web/src/presentation/git.ts");
    return new Proxy({}, { get: (_target, key) => key });
  } });
  return { render: (name: string, props: any) => { index = 0; effects.length = 0; return module.exports[name]!(props); }, effects, timers };
}
function find(element: any, type: string, matches: (element: Element) => boolean = () => true): Element {
  if (element?.type === type && matches(element)) return element;
  for (const child of [element?.props?.children].flat(Infinity)) {
    if (!child || typeof child !== "object") continue;
    try { return find(child, type, matches); } catch {}
  }
  throw new Error(`Missing ${type}`);
}
function textContent(value: any): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textContent).join("");
  return value && typeof value === "object" ? textContent(value.props?.children) : "";
}
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

function tour(views: any[]) {
  const sent: string[] = [];
  const pane = component("tour-pane", async input => { sent.push(input.type); return views.shift(); });
  const render = () => pane.render("TourPane", { target: { sessionId: "session" } });
  return { pane, sent, render };
}

it("switches between the branch diff and the Tour in the Branch view of Changes", () => {
  const pane = component("git-changes", async () => ({ files: [], commits: [] }));
  const render = (view: string) => pane.render("GitChanges", { sessionId: "session", revision: "r", view, onViewChange() {}, onCommitted() {} });
  const branchViews = (view: string) => find(render(view), "Tabs", node => find(node, "TabsList").props["aria-label"] === "Branch views");
  assert.throws(() => branchViews("uncommitted"));
  assert.throws(() => find(render("branch"), "TourPane"));
  branchViews("branch").props.onValueChange("tour");
  assert.equal(find(render("branch"), "TourPane").props.target.sessionId, "session");
  assert.doesNotMatch(textContent(render("branch")), /Reading changes/);
  assert.throws(() => find(render("uncommitted"), "TourPane"));
  branchViews("branch").props.onValueChange("diff");
  assert.throws(() => find(render("branch"), "TourPane"));
});

it("opens Changes on Branch when nothing is uncommitted", () => {
  repositoryState = true;
  const view = (changed: number) => {
    gitState = { changed };
    const pane = component("git-pane", async () => ({ files: [] }));
    pane.render("GitPane", { sessionId: "session" });
    return find(pane.render("GitPane", { sessionId: "session" }), "GitChanges").props.view;
  };
  assert.equal(view(0), "branch");
  assert.equal(view(2), "uncommitted");
  gitState = undefined;
});

it("reopens the remembered Tour only when the branch has a tour", async () => {
  const shown = async (tour: { state: string }) => {
    const pane = component("git-changes", async input => input.type === "tour" ? tour : { files: [], commits: [] });
    const render = () => pane.render("GitChanges", { sessionId: "session", revision: "r", view: "branch", onViewChange() {}, onCommitted() {} });
    render();
    for (const effect of pane.effects) effect();
    await settle();
    try { find(render(), "TourPane"); return "tour"; } catch { return "diff"; }
  };
  storage.clear();
  assert.equal(await shown({ state: "done" }), "diff");
  const pane = component("git-changes", async () => ({ files: [], commits: [] }));
  const tabs = find(pane.render("GitChanges", { sessionId: "session", revision: "r", view: "branch", onViewChange() {}, onCommitted() {} }), "Tabs", node => find(node, "TabsList").props["aria-label"] === "Branch views");
  tabs.props.onValueChange("tour");
  assert.equal(storage.get("flow.git-branch-view"), "tour");
  assert.equal(await shown({ state: "done" }), "tour");
  assert.equal(await shown({ state: "idle" }), "diff");
  storage.clear();
});

it("has no top-level Tour tab", () => {
  repositoryState = true;
  const pane = component("git-pane", async () => ({ files: [] }));
  assert.throws(() => find(pane.render("GitPane", { sessionId: "session" }), "TabsTrigger", node => node.props.value === "Tour"));
});

it("polls while running and renders the done tour with its sha", async () => {
  const { pane, sent, render } = tour([
    { state: "running" },
    { state: "done", text: "# Walk", branch: "feature", head: "0123456789abcdef", repo: "owner/repo" },
  ]);
  render();
  pane.effects[0]!();
  await settle();
  render();
  pane.effects[1]!();
  assert.equal(pane.timers[0]!.delay, 2_000);
  pane.timers[0]!.run();
  await settle();
  const view = render();
  pane.effects[1]!();
  assert.equal(pane.timers.length, 1);
  assert.deepEqual(sent, ["tour", "tour"]);
  assert.deepEqual({ ...find(view, "PullRequestMarkdown").props }, { body: "# Walk", repo: "owner/repo", headRefName: "0123456789abcdef" });
  find(view, "p", node => textContent(node) === "Made for feature at 01234567");
  find(view, "Button", node => textContent(node) === "Run tour again");
});

it("shows a failed tour as an alert", async () => {
  const { pane, render } = tour([{ state: "failed", problem: "No remote.", branch: "feature", head: "0123456789abcdef" }]);
  render();
  pane.effects[0]!();
  await settle();
  const view = render();
  find(view, "p", node => node.props.role === "alert" && textContent(node) === "No remote.");
  find(view, "p", node => textContent(node) === "Made for feature at 01234567");
});

it("starts and cancels a tour", async () => {
  const { pane, sent, render } = tour([{ state: "idle" }, { state: "running" }, { state: "idle" }]);
  render();
  pane.effects[0]!();
  await settle();
  find(render(), "Button", node => textContent(node) === "Tour").props.onClick();
  await settle();
  find(render(), "Button", node => textContent(node) === "Cancel").props.onClick();
  await settle();
  assert.deepEqual(sent, ["tour", "start_tour", "cancel_tour"]);
  assert.throws(() => find(render(), "Button", node => textContent(node) === "Cancel"));
});
