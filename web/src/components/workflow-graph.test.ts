import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { it } from "node:test";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import type { ReactElement } from "react";
import type { WorkflowStep } from "../../../src/protocol/workflows.ts";
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
