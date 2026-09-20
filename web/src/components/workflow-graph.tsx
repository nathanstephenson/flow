import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  EDITOR_MIN_ZOOM,
  EXECUTION_MIN_ZOOM,
  executionLayout,
} from "../presentation/workflow-execution.ts";
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
  WORKFLOW_CARD_HEIGHT,
  WORKFLOW_CARD_WIDTH,
  workflowFallbackPosition,
} from "../presentation/workflow-dimensions.ts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select.tsx";

const nodeTypes = { workflow: WorkflowNode, loop: LoopNode };
const FIT_VIEW_OPTIONS = {
  padding: 0.08,
  maxZoom: 1,
};
const BRANCH_OUTCOMES = ["true", "false", "failure", "timeout"] satisfies WorkflowOutcome[];
const STEP_OUTCOMES = ["success", "failure", "timeout"] satisfies WorkflowOutcome[];
function LoopNode({
  data,
}: NodeProps<
  Node<{
    title: string;
    maxTries: number;
    progress?: string;
    change?: (value: number) => void;
    orientation: "horizontal" | "vertical";
  }>
>) {
  return (
    <div
      className="workflow-loop h-full rounded-lg border border-primary/40 bg-primary/5 p-3 text-xs"
      data-orientation={data.orientation}
    >
      <div className="workflow-loop__summary">
        <div className="workflow-loop__heading nodrag nopan">
          <strong title={data.title} className="line-clamp-2 min-w-0 text-sm">
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
    </div>
  );
}
export function WorkflowNode({
  data,
}: NodeProps<
  Node<{ step: WorkflowStep; permission: string; status?: string; vertical?: boolean; execution?: boolean }>
>) {
  const { step } = data;
  const outcomes = step.kind === "branch" ? BRANCH_OUTCOMES : STEP_OUTCOMES;
  const sourcePosition = data.vertical ? Position.Bottom : Position.Right;
  return (
    <div
      data-status={data.status}
      data-orientation={data.vertical ? "vertical" : "horizontal"}
      className="workflow-step relative rounded-lg border bg-card p-3 text-xs text-card-foreground"
      style={{ width: WORKFLOW_CARD_WIDTH, height: WORKFLOW_CARD_HEIGHT }}
    >
      <Handle type="target" position={data.vertical ? Position.Top : Position.Left} />
      <strong
        title={step.name}
        className={`block text-sm font-semibold ${data.execution ? "line-clamp-2 whitespace-normal" : "truncate"}`}
      >
        {step.name}
      </strong>
      <div className="text-muted-foreground">
        {step.kind} · {data.permission}
      </div>
      {data.status && <div>{data.status.replaceAll("-", " ")}</div>}
      <div
        className={`workflow-step__outcomes ${data.vertical ? "workflow-step__outcomes--vertical" : "workflow-step__outcomes--horizontal"}`}
      >
        {outcomes.map((outcome) => (
          <div key={outcome} className="workflow-step__outcome" data-outcome={outcome}>
            <span>{outcome}</span>
            <Handle
              id={outcome}
              type="source"
              position={sourcePosition}
            />
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
  orientation = "horizontal",
}: {
  definition: WorkflowDefinition;
  onChange?: (d: WorkflowDefinition) => void;
  onSelect: (id: string) => void;
  execution?: WorkflowExecution;
  awaitingSteps?: string[];
  selectedStepId?: string;
  orientation?: "horizontal" | "vertical";
}) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const canvas = useRef<HTMLDivElement>(null);
  const flow = useRef<ReactFlowInstance<Node, Edge>>(null);
  const fitted = useRef(false);
  const fitting = useRef(false);
  const mounted = useRef(true);
  const fitGeneration = useRef(0);
  const fitOnceVisible = useCallback(() => {
    const element = canvas.current;
    const instance = flow.current;
    if (
      fitted.current ||
      fitting.current ||
      !element ||
      !instance ||
      !instance.getNodes().length ||
      element.clientWidth === 0 ||
      element.clientHeight === 0
    ) return;
    fitting.current = true;
    const generation = fitGeneration.current;
    void instance.fitView(FIT_VIEW_OPTIONS).then((didFit) => {
      const current = canvas.current;
      if (
        mounted.current &&
        generation === fitGeneration.current &&
        current &&
        current.clientWidth > 0 &&
        current.clientHeight > 0
      ) fitted.current ||= didFit;
      fitting.current = false;
    });
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      fitGeneration.current++;
    };
  }, []);
  useEffect(() => {
    fitted.current = false;
    fitting.current = false;
    fitGeneration.current++;
  }, [execution?.id, orientation]);
  useEffect(() => {
    if (typeof ResizeObserver === "undefined" || !canvas.current) return;
    const observer = new ResizeObserver(fitOnceVisible);
    observer.observe(canvas.current);
    fitOnceVisible();
    return () => observer.disconnect();
  }, [fitOnceVisible]);
  useEffect(fitOnceVisible, [fitOnceVisible, nodes.length, execution?.id, orientation]);
  const controlledSelection = selectedStepId !== undefined;
  const selectionChanged = useCallback(
    ({ nodes }: { nodes: Node[] }) => {
      const step = nodes.find((node) => node.type === "workflow");
      if (step) onSelect(step.id);
      else if (!controlledSelection) onSelect("");
    },
    [onSelect, controlledSelection],
  );
  const topologyKey = execution?.id ?? definition;
  const staticGraph = useMemo(() => {
    let layout: Node[];
    try {
      layout = loopLayout(
        execution
          ? executionLayout(definition, orientation === "vertical")
          : definition,
        { orientation },
      );
    } catch {
      layout = definition.steps.map((step, i) => ({
        id: step.id,
        type: "workflow",
        position: step.position ?? workflowFallbackPosition(i),
        data: { step },
      }));
    }
    return {
      layout,
      edges: definition.edges.map((edge) => ({
        id: edge.id, source: edge.from, target: edge.to,
        sourceHandle: edge.outcome, label: edge.outcome, zIndex: 0,
      })),
      steps: new Map(definition.steps.map(step => [step.id, step])),
    };
  }, [topologyKey, orientation]);
  useEffect(() => {
    const awaiting = new Set(awaitingSteps);
    setNodes((previous) => {
      const previousById = new Map(previous.map(node => [node.id, node]));
      return staticGraph.layout.map((node) => {
        if (node.type === "loop") {
          const headerId = node.data.headerId as string;
          const maxTries = definition.loopSettings?.[headerId]?.maxTries ?? 3;
          return {
            ...node,
            data: {
              title: staticGraph.steps.get(headerId)!.name,
              maxTries,
              orientation,
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
              ? previousById.get(step.id)?.selected
              : selectedStepId === step.id,
          data: {
            step,
            vertical: !!execution && orientation === "vertical",
            execution: !!execution,
            permission:
              step.permission ?? definition.permission ?? "auto-accept",
            status: awaiting.has(step.id)
              ? "awaiting-input"
              : execution?.steps[step.id]?.status,
          },
        };
      });
    });
    setEdges((previous) => {
      const selected = new Set(previous.filter(edge => edge.selected).map(edge => edge.id));
      return staticGraph.edges.map(edge => ({ ...edge, selected: selected.has(edge.id) }));
    });
  }, [staticGraph, execution, selectedStepId, awaitingSteps, definition, onChange, orientation]);
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
    <div ref={canvas} className="workflow-canvas overflow-hidden rounded-lg border">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onInit={(instance) => {
          flow.current = instance;
          fitOnceVisible();
        }}
        onNodesChange={(changes) =>
          setNodes((current) => applyNodeChanges(changes, current))
        }
        onEdgesChange={(changes) =>
          setEdges((current) => applyEdgeChanges(changes, current))
        }
        onConnect={connect}
        onNodeClick={(_, node) => node.type === "workflow" && onSelect(node.id)}
        // A controlled selection is presentation state supplied by its parent. Reporting it back on
        // every graph repaint would immediately reopen a mobile inspector its Back button hid.
        onSelectionChange={execution || controlledSelection ? undefined : selectionChanged}
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
        defaultViewport={{ x: 32, y: definition.loopSettings && Object.keys(definition.loopSettings).length ? 120 : 24, zoom: 1 }}
        minZoom={execution ? EXECUTION_MIN_ZOOM : EDITOR_MIN_ZOOM}
        fitViewOptions={FIT_VIEW_OPTIONS}
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
