import { useCallback, useEffect, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  applyNodeChanges,
  applyEdgeChanges,
  type Edge,
  type NodeProps,
  type Node,
  type Connection,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type {
  WorkflowDefinition,
  WorkflowStep,
  WorkflowExecution,
  WorkflowOutcome,
} from "../../../src/protocol/workflows.ts";
const nodeTypes = { workflow: WorkflowNode };
function WorkflowNode({
  data,
}: NodeProps<
  Node<{ step: WorkflowStep; permission: string; status?: string }>
>) {
  const { step } = data;
  const outcomes =
    step.kind === "branch"
      ? ["true", "false"]
      : ["success", "failure", "timeout"];
  return (
    <div
      data-status={data.status}
      className="workflow-step min-w-48 rounded-lg border bg-card p-3 text-xs text-card-foreground"
    >
      <Handle type="target" position={Position.Left} />
      <strong className="text-sm font-semibold">{step.name}</strong>
      <div className="text-muted-foreground">
        {step.kind} · {data.permission}
      </div>
      {data.status && <div>{data.status.replaceAll("-", " ")}</div>}
      <div className="mt-2 flex flex-col gap-1">
        {outcomes.map((outcome) => (
          <div key={outcome} className="relative -mr-3 pr-3 text-right text-xs">
            {outcome}
            <Handle id={outcome} type="source" position={Position.Right} />
          </div>
        ))}
      </div>
    </div>
  );
}
export function WorkflowGraph({
  definition,
  onChange,
  onSelect,
  execution,
  awaitingSteps = [],
  selectedStepId,
}: {
  definition: WorkflowDefinition;
  onChange?: (d: WorkflowDefinition) => void;
  onSelect: (id: string) => void;
  execution?: WorkflowExecution;
  awaitingSteps?: string[];
  selectedStepId?: string;
}) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const controlledSelection = selectedStepId !== undefined;
  const selectionChanged = useCallback(
    ({ nodes }: { nodes: Node[] }) => {
      if (nodes[0]) onSelect(nodes[0].id);
      else if (!controlledSelection) onSelect("");
    },
    [onSelect, controlledSelection],
  );
  useEffect(() => {
    setNodes((previous) =>
      definition.steps.map((step, i) => ({
        id: step.id,
        type: "workflow",
        selected:
          selectedStepId === undefined
            ? previous.find((n) => n.id === step.id)?.selected
            : selectedStepId === step.id,
        position: step.position ?? {
          x: (i % 3) * 270,
          y: Math.floor(i / 3) * 180,
        },
        data: {
          step,
          permission: step.permission ?? definition.permission ?? "auto-accept",
          status: awaitingSteps.includes(step.id)
            ? "awaiting-input"
            : execution?.steps[step.id]?.status,
        },
      })),
    );
    setEdges((previous) =>
      definition.edges.map((e) => ({
        id: e.id,
        source: e.from,
        target: e.to,
        sourceHandle: e.outcome,
        label: e.outcome,
        selected: previous.find((old) => old.id === e.id)?.selected,
      })),
    );
  }, [definition, execution, selectedStepId, JSON.stringify(awaitingSteps)]);
  const connect = (c: Connection) => {
    if (c.source && c.target)
      onChange?.({
        ...definition,
        edges: [
          ...definition.edges,
          {
            id: crypto.randomUUID(),
            from: c.source,
            to: c.target,
            outcome: (c.sourceHandle ?? "success") as WorkflowOutcome,
          },
        ],
      });
  };
  return (
    <div className="workflow-canvas overflow-hidden rounded-lg border">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={(changes) =>
          setNodes((current) => applyNodeChanges(changes, current))
        }
        onEdgesChange={(changes) =>
          setEdges((current) => applyEdgeChanges(changes, current))
        }
        nodeTypes={nodeTypes}
        onConnect={connect}
        onNodeClick={(_, n) => onSelect(n.id)}
        onSelectionChange={selectionChanged}
        onNodeDragStop={(_, node) =>
          onChange?.({
            ...definition,
            steps: definition.steps.map((s) =>
              s.id === node.id ? { ...s, position: node.position } : s,
            ),
          })
        }
        onNodesDelete={(nodes) =>
          onChange?.({
            ...definition,
            steps: definition.steps.filter(
              (s) => !nodes.some((n) => n.id === s.id),
            ),
            edges: definition.edges.filter(
              (e) => !nodes.some((n) => n.id === e.from || n.id === e.to),
            ),
          })
        }
        onEdgesDelete={(edges) =>
          onChange?.({
            ...definition,
            edges: definition.edges.filter(
              (e) => !edges.some((x) => x.id === e.id),
            ),
          })
        }
        nodesDraggable={!!onChange}
        nodesConnectable={!!onChange}
        deleteKeyCode={onChange ? ["Backspace", "Delete"] : null}
        fitView
        minZoom={0.1}
        fitViewOptions={{ minZoom: 0.1, maxZoom: 1 }}
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
