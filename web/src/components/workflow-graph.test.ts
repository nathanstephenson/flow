import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { it } from "node:test";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import type { ReactElement } from "react";
import type { WorkflowDefinition, WorkflowStep } from "../../../src/protocol/workflows.ts";
import {
  WORKFLOW_CARD_HEIGHT,
  WORKFLOW_CARD_WIDTH,
} from "../presentation/workflow-dimensions.ts";

type Element = ReactElement<Record<string, any>>;

function workflowNode(step: WorkflowStep, vertical: boolean): Element {
  const module = { exports: {} as { WorkflowNode: (props: any) => Element } };
  const require = createRequire(import.meta.url);
  const code = transformSync(
    readFileSync(new URL("./workflow-graph.tsx", import.meta.url), "utf8"),
    { loader: "tsx", format: "cjs", jsx: "automatic" },
  ).code;
  runInNewContext(code, {
    module,
    exports: module.exports,
    require: (name: string) => {
      if (name.endsWith(".css")) return {};
      if (name === "@xyflow/react") {
        return { Handle: "Handle", Position: { Bottom: "bottom", Right: "right", Top: "top", Left: "left" } };
      }
      if (name === "react" || name === "react/jsx-runtime") return require(name);
      if (name === "../presentation/workflow-dimensions.ts") {
        return { WORKFLOW_CARD_HEIGHT, WORKFLOW_CARD_WIDTH };
      }
      return new Proxy({}, { get: (_target, key) => key });
    },
  });
  return module.exports.WorkflowNode({
    data: { step, permission: "auto-accept", status: "completed", vertical, execution: true },
  });
}

function descendants(element: any): Element[] {
  if (!element || typeof element !== "object" || !("props" in element)) return [];
  return [element, ...[element.props.children].flat(Infinity).flatMap(descendants)];
}

const branch: WorkflowStep = {
  id: "check",
  name: "A branch title long enough to occupy two rendered lines",
  kind: "branch",
  condition: { operator: "equals", path: ["ready"], value: true },
};

it("delegates one-shot initial fitting to React Flow without update or resize refits", () => {
  const source = readFileSync(new URL("./workflow-graph.tsx", import.meta.url), "utf8");
  assert.match(source, /<ReactFlow[\s\S]*?\sfitView\s+fitViewOptions=\{FIT_VIEW_OPTIONS\}/);
  assert.match(source, /<Controls fitViewOptions=\{FIT_VIEW_OPTIONS\} \/>/);
  assert.doesNotMatch(source, /\.fitView\(|ResizeObserver|onInit=/);
});

it("uses manual graph layering so loop-connected edges stay below containers and cards", () => {
  const source = readFileSync(new URL("./workflow-graph.tsx", import.meta.url), "utf8");
  assert.match(source, /zIndexMode="manual"/);
  assert.match(source, /sourceHandle: edge\.outcome, label: edge\.outcome, zIndex: 0/);
});

it("refreshes root and child topology with one execution id without relayout on polling", () => {
  const module = { exports: {} as { WorkflowGraph: (props: any) => Element } };
  const require = createRequire(import.meta.url);
  const states: any[] = [];
  const memos: { deps: any[]; value: any }[] = [];
  const effectDeps: any[][] = [];
  let stateIndex = 0, memoIndex = 0, effectIndex = 0, layouts = 0;
  let pending: (() => void)[] = [];
  const same = (a: any[] | undefined, b: any[]) =>
    a?.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const code = transformSync(
    readFileSync(new URL("./workflow-graph.tsx", import.meta.url), "utf8"),
    { loader: "tsx", format: "cjs", jsx: "automatic" },
  ).code;
  runInNewContext(code, {
    module,
    exports: module.exports,
    require: (name: string) => {
      if (name.endsWith(".css")) return {};
      if (name === "react") return {
        useState(initial: any) {
          const index = stateIndex++;
          if (!(index in states)) states[index] = initial;
          return [states[index], (value: any) => {
            states[index] = typeof value === "function" ? value(states[index]) : value;
          }];
        },
        useCallback: (callback: any) => callback,
        useMemo(factory: () => any, deps: any[]) {
          const index = memoIndex++;
          if (!same(memos[index]?.deps, deps)) memos[index] = { deps, value: factory() };
          return memos[index].value;
        },
        useEffect(effect: () => void, deps: any[]) {
          const index = effectIndex++;
          if (!same(effectDeps[index], deps)) {
            effectDeps[index] = deps;
            pending.push(effect);
          }
        },
      };
      if (name === "@xyflow/react") return { ReactFlow: "ReactFlow", Position: {} };
      if (name === "../presentation/workflow-execution.ts") {
        const actual = require(name);
        return { ...actual, executionLayout: (...args: any[]) => {
          layouts++;
          return actual.executionLayout(...args);
        } };
      }
      if (name.startsWith("./ui/")) return {};
      return require(name);
    },
  });
  const render = (definition: WorkflowDefinition) => {
    const props = { definition, execution: { id: "shared-root", steps: {} }, onSelect() {} };
    for (let pass = 0; pass < 5; pass++) {
      stateIndex = memoIndex = effectIndex = 0;
      pending = [];
      const element = module.exports.WorkflowGraph(props);
      if (!pending.length) return descendants(element).find(item => item.type === "ReactFlow")!.props.nodes;
      for (const effect of pending) effect();
    }
    assert.fail("graph effects did not settle");
  };
  const root: WorkflowDefinition = {
    version: 1, id: "root", name: "Root", backend: "fake",
    inputSchema: { type: "object", fields: {} },
    steps: [{ id: "root-step", name: "Root step", kind: "join" }], edges: [],
  };
  const child: WorkflowDefinition = {
    ...root, id: "child", name: "Child",
    steps: [{ id: "child-step", name: "Child step", kind: "join" }],
  };
  for (const [index, definition] of [root, child, root].entries()) {
    const nodes = render(definition);
    assert.deepEqual(Array.from(nodes, (node: any) => node.id), definition.steps.map(step => step.id));
    assert.equal(layouts, index + 1);
    const polledNodes = render(structuredClone(definition));
    assert.deepEqual(Array.from(polledNodes, (node: any) => node.id), definition.steps.map(step => step.id));
    assert.strictEqual(polledNodes[0].position, nodes[0].position);
    assert.equal(layouts, index + 1, "polling must reuse layout");
  }
});

for (const [vertical, position, orientation] of [
  [true, "bottom", "vertical"],
  [false, "right", "horizontal"],
] as const) {
  it(`renders all branch outcome ports on the ${position} of ${orientation} execution cards`, () => {
    const card = workflowNode(branch, vertical);
    assert.equal(card.props.style.width, WORKFLOW_CARD_WIDTH);
    assert.equal(card.props.style.height, WORKFLOW_CARD_HEIGHT);
    assert.equal(card.props["data-orientation"], orientation);
    const outcomeRows = descendants(card).filter((item) => item.props["data-outcome"]);
    assert.deepEqual(outcomeRows.map((item) => item.props["data-outcome"]), ["true", "false", "failure", "timeout"]);
    const handles = descendants(card).filter((item) => item.type === "Handle" && item.props.type === "source");
    assert.deepEqual(handles.map((item) => item.props.id), ["true", "false", "failure", "timeout"]);
    assert.ok(handles.every((item) => item.props.position === position));
  });
}
