import type { Node } from "@xyflow/react";
import type {
  WorkflowDefinition,
  WorkflowExecution,
  WorkflowLoopRecord,
} from "../../../src/protocol/workflows.ts";
import type { RecoverWorkflow } from "../../../src/protocol/workflow-executions.ts";
import { analyzeLoops } from "../../../src/workflows/loops.ts";

export function cleanLoopSettings(
  definition: WorkflowDefinition,
): WorkflowDefinition {
  let headers: Set<string>;
  try {
    headers = new Set(
      analyzeLoops(definition).loops.map((loop) => loop.headerId),
    );
  } catch {
    headers = new Set(
      definition.steps
        .filter((step) => {
          const pending = definition.edges
            .filter((edge) => edge.from === step.id)
            .map((edge) => edge.to);
          const seen = new Set<string>();
          while (pending.length) {
            const id = pending.pop()!;
            if (id === step.id) return true;
            if (seen.has(id)) continue;
            seen.add(id);
            pending.push(
              ...definition.edges
                .filter((edge) => edge.from === id)
                .map((edge) => edge.to),
            );
          }
          return false;
        })
        .map((step) => step.id),
    );
  }
  return {
    ...definition,
    loopSettings: Object.fromEntries(
      Object.entries(definition.loopSettings ?? {}).filter(([id]) =>
        headers.has(id),
      ),
    ),
    steps: definition.steps.map((step) => {
      if (headers.has(step.id) || !step.repeatMapping) return step;
      const next = { ...step };
      delete next.repeatMapping;
      return next;
    }),
  };
}

export function loopLayout(definition: WorkflowDefinition): Node[] {
  const loops = analyzeLoops(definition).loops;
  const positions = new Map(
    definition.steps.map((step, i) => [
      step.id,
      step.position ?? { x: (i % 3) * 270, y: Math.floor(i / 3) * 180 },
    ]),
  );
  const boxes = new Map<
    string,
    { x: number; y: number; width: number; height: number }
  >();
  for (const loop of [...loops].reverse()) {
    const children = loops.filter(
      (child) => child.parentHeaderId === loop.headerId,
    );
    const contents = [
      ...loop.memberIds
        .filter((id) => !children.some((child) => child.memberIds.includes(id)))
        .map((id) => ({ ...positions.get(id)!, width: 210, height: 150 })),
      ...children.map((child) => boxes.get(child.headerId)!),
    ];
    const x = Math.min(...contents.map((box) => box.x)) - 24;
    const y = Math.min(...contents.map((box) => box.y)) - 100;
    boxes.set(loop.headerId, {
      x,
      y,
      width: Math.max(...contents.map((box) => box.x + box.width)) + 24 - x,
      height: Math.max(...contents.map((box) => box.y + box.height)) + 24 - y,
    });
  }
  let prefix = "loop:";
  while (definition.steps.some((step) => step.id.startsWith(prefix)))
    prefix += ":";
  const groupId = (id: string) => `${prefix}${id}`;
  const relative = (position: { x: number; y: number }, parent?: string) => {
    const origin = parent ? boxes.get(parent)! : { x: 0, y: 0 };
    return { x: position.x - origin.x, y: position.y - origin.y };
  };
  return [
    ...loops.map((loop) => ({
      id: groupId(loop.headerId),
      type: "loop",
      ...(loop.parentHeaderId
        ? { parentId: groupId(loop.parentHeaderId) }
        : {}),
      position: relative(boxes.get(loop.headerId)!, loop.parentHeaderId),
      style: {
        width: boxes.get(loop.headerId)!.width,
        height: boxes.get(loop.headerId)!.height,
      },
      selectable: false,
      deletable: false,
      draggable: false,
      connectable: false,
      data: { headerId: loop.headerId },
    })),
    ...definition.steps.map((step) => {
      const parent = [...loops]
        .reverse()
        .find((loop) => loop.memberIds.includes(step.id));
      return {
        id: step.id,
        type: "workflow",
        ...(parent ? { parentId: groupId(parent.headerId) } : {}),
        position: relative(positions.get(step.id)!, parent?.headerId),
        data: { step },
      };
    }),
  ];
}

export function absolutePosition(
  node: Node,
  nodes: Node[],
): { x: number; y: number } {
  const parent = nodes.find((item) => item.id === node.parentId);
  const origin = parent ? absolutePosition(parent, nodes) : { x: 0, y: 0 };
  return { x: node.position.x + origin.x, y: node.position.y + origin.y };
}

export function loopProgress(
  record: WorkflowLoopRecord,
  maxTries: number,
): string {
  const maximum =
    maxTries +
    record.grants.filter((grant) => grant.activation === record.activation)
      .length;
  const current = record.try;
  return `${record.phase === "inactive" ? "Not started" : `Try ${current} of ${maximum}`} · ${record.phase === "limit" ? "Loop limit reached" : record.phase}`;
}
export function limitedLoops(execution: Pick<WorkflowExecution, "loops">) {
  return Object.entries(execution.loops ?? {}).filter(
    ([, record]) => record.phase === "limit",
  );
}
export function extendLoop(
  headerId: string,
  record: WorkflowLoopRecord,
  guidance: string,
): RecoverWorkflow {
  return {
    kind: "extend-loop",
    headerId,
    activation: record.activation,
    try: record.try,
    ...(guidance ? { guidance } : {}),
  };
}
