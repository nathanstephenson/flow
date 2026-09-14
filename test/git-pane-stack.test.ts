import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { it } from "node:test";
import { transformSync } from "esbuild";

type Element = { type: string; key?: string; props: Record<string, any> };
function component(file: string, command: (input: any) => Promise<any>) {
  const states: any[] = [];
  let index = 0;
  const effects: (() => void)[] = [];
  const exports: Record<string, (props: any) => Element> = {};
  const module = { exports };
  const require = createRequire(import.meta.url);
  const code = transformSync(readFileSync(new URL(`../web/src/components/${file}.tsx`, import.meta.url), "utf8"), { loader: "tsx", format: "cjs", jsx: "automatic" }).code;
  runInNewContext(code, { module, exports, require: (name: string) => {
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
  const candidate = { trunk: "main", branches: ["first", "second"], fingerprint: "reviewed" };
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
    find(tree, "Button", node => node.props.children === "Create stack").props.onClick();
    await Promise.resolve();
    const input = calls.find(call => call.type === "change_stack").input;
    assert.equal(JSON.stringify(input.branches), JSON.stringify(candidate.branches));
    assert.equal(input.fingerprint, candidate.fingerprint);
  }
});
