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
import {
  absolutePosition,
  cleanLoopSettings,
  loopLayout,
  loopProgress,
} from "../presentation/workflow-loops.ts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select.tsx";

const nodeTypes = { workflow: WorkflowNode, loop: LoopNode };
function LoopNode({
  data,
}: NodeProps<
  Node<{
    title: string;
    maxTries: number;
    progress?: string;
    change?: (value: number) => void;
  }>
>) {
  return (
    <div className="h-full rounded-lg border border-primary/40 bg-primary/5 p-3 text-xs">
      <div className="nodrag nopan flex items-center gap-3">
        <strong
          title={data.title}
          className="min-w-0 max-w-48 truncate text-sm"
        >
          Loop · {data.title}
        </strong>
        <span className="shrink-0">Max tries</span>
        <Select
          value={data.maxTries}
          disabled={!data.change}
          onValueChange={(value) => value !== null && data.change?.(value)}
        >
          <SelectTrigger size="sm" aria-label={`Max tries · ${data.title}`}>
            <SelectValue>{data.maxTries}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {Array.from({ length: 100 }, (_, i) => (
              <SelectItem key={i + 1} value={i + 1}>
                {i + 1}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p className="mt-1 text-muted-foreground">
        {data.progress ??
          "First check included. Inner limits reset on each outer try."}
      </p>
    </div>
  );
}
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
      className="workflow-step h-36 w-52 rounded-lg border bg-card p-3 text-xs text-card-foreground"
    >
      <Handle type="target" position={Position.Left} />
      <strong
        title={step.name}
        className="block truncate text-sm font-semibold"
      >
        {step.name}
      </strong>
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
      const step = nodes.find((node) => node.type === "workflow");
      if (step) onSelect(step.id);
      else if (!controlledSelection) onSelect("");
    },
    [onSelect, controlledSelection],
  );
  useEffect(() => {
    let layout: Node[];
    try {
      layout = loopLayout(definition);
    } catch {
      layout = definition.steps.map((step, i) => ({
        id: step.id,
        type: "workflow",
        position: step.position ?? {
          x: (i % 3) * 270,
          y: Math.floor(i / 3) * 180,
        },
        data: { step },
      }));
    }
    setNodes((previous) =>
      layout.map((node) => {
        if (node.type === "loop") {
          const headerId = node.data.headerId as string;
          const maxTries = definition.loopSettings?.[headerId]?.maxTries ?? 3;
          return {
            ...node,
            data: {
              title: definition.steps.find((step) => step.id === headerId)!
                .name,
              maxTries,
              progress: execution?.loops?.[headerId]
                ? loopProgress(execution.loops[headerId], maxTries)
                : undefined,
              change: onChange
                ? (value: number) =>
                    onChange({
                      ...definition,
                      loopSettings: {
                        ...definition.loopSettings,
                        [headerId]: { maxTries: value },
                      },
                    })
                : undefined,
            },
          };
        }
        const step = node.data.step as WorkflowStep;
        return {
          ...node,
          selected:
            selectedStepId === undefined
              ? previous.find((n) => n.id === step.id)?.selected
              : selectedStepId === step.id,
          data: {
            step,
            permission:
              step.permission ?? definition.permission ?? "auto-accept",
            status: awaitingSteps.includes(step.id)
              ? "awaiting-input"
              : execution?.steps[step.id]?.status,
          },
        };
      }),
    );
    setEdges((previous) =>
      definition.edges.map((edge) => ({
        id: edge.id,
        source: edge.from,
        target: edge.to,
        sourceHandle: edge.outcome,
        label: edge.outcome,
        selected: previous.find((old) => old.id === edge.id)?.selected,
      })),
    );
  }, [definition, execution, selectedStepId, JSON.stringify(awaitingSteps)]);
  const connect = (connection: Connection) => {
    if (connection.source && connection.target)
      onChange?.({
        ...definition,
        edges: [
          ...definition.edges,
          {
            id: crypto.randomUUID(),
            from: connection.source,
            to: connection.target,
            outcome: (connection.sourceHandle ?? "success") as WorkflowOutcome,
          },
        ],
      });
  };
  return (
    <div className="workflow-canvas overflow-hidden rounded-lg border">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={(changes) =>
          setNodes((current) => applyNodeChanges(changes, current))
        }
        onEdgesChange={(changes) =>
          setEdges((current) => applyEdgeChanges(changes, current))
        }
        onConnect={connect}
        onNodeClick={(_, node) => node.type === "workflow" && onSelect(node.id)}
        onSelectionChange={selectionChanged}
        onNodeDragStop={(_, node, dragged) =>
          onChange?.({
            ...definition,
            steps: definition.steps.map((step) => {
              const moved = (dragged.length ? dragged : [node]).find(
                (item) => item.id === step.id,
              );
              return moved
                ? { ...step, position: absolutePosition(moved, nodes) }
                : step;
            }),
          })
        }
        onDelete={({ nodes: removedNodes, edges: removedEdges }) =>
          onChange?.(
            cleanLoopSettings({
              ...definition,
              steps: definition.steps.filter(
                (step) =>
                  !removedNodes.some(
                    (node) => node.type === "workflow" && node.id === step.id,
                  ),
              ),
              edges: definition.edges.filter(
                (edge) =>
                  !removedEdges.some((item) => item.id === edge.id) &&
                  !removedNodes.some(
                    (node) =>
                      node.type === "workflow" &&
                      (node.id === edge.from || node.id === edge.to),
                  ),
              ),
            }),
          )
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
