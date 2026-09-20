import type {
  WorkflowDefinition,
} from '../../../src/protocol/workflows.ts';
import { analyzeLoops } from '../../../src/workflows/loops.ts';
import {
  LOOP_PADDING,
  LOOP_SIDE_HEADER_WIDTH,
  LOOP_TOP_HEADER_HEIGHT,
} from './workflow-loops.ts';
import {
  WORKFLOW_CARD_HEIGHT,
  WORKFLOW_CARD_WIDTH,
  WORKFLOW_COLUMN_GAP,
  WORKFLOW_LANE_GAP,
  WORKFLOW_RANK_GAP,
  WORKFLOW_ROW_GAP,
} from './workflow-dimensions.ts';

export function attemptDuration(startedAt: number, finishedAt?: number): string {
  if (finishedAt === undefined) return 'In progress';
  const seconds = Math.max(0, Math.floor((finishedAt - startedAt) / 1000));
  return [[Math.floor(seconds / 3600), 'h'], [Math.floor(seconds / 60) % 60, 'm'], [seconds % 60, 's']]
    .filter(([value]) => value !== 0).map(([value, unit]) => `${value}${unit}`).join(' ') || '0s';
}

export const EDITOR_MIN_ZOOM = 0.1;
export const EXECUTION_MIN_ZOOM = 0.05;

/** Ignore editor coordinates, but keep the same loop grouping and every outcome edge. */
export function executionLayout(definition: WorkflowDefinition, vertical: boolean): WorkflowDefinition {
  const loops = analyzeLoops(definition);
  const back = new Set(loops.loops.flatMap(loop => loop.backEdgeIds));
  const incoming = new Map(definition.steps.map(step => [step.id, [] as string[]]));
  for (const edge of definition.edges) {
    if (!back.has(edge.id)) incoming.get(edge.to)!.push(edge.from);
  }
  const exitLoops = new Map<string, typeof loops.loops>();
  const edgeById = new Map(definition.edges.map(edge => [edge.id, edge]));
  for (const loop of loops.loops) {
    for (const id of loop.exitEdgeIds) {
      if (back.has(id)) continue;
      const target = edgeById.get(id)?.to;
      if (target) exitLoops.set(target, [...(exitLoops.get(target) ?? []), loop]);
    }
  }

  const ranks = new Map<string, number>();
  // Loop exits are hyper-edge constraints: their target follows every member of
  // every loop exited by that edge. Replaying topological order reaches a fixed
  // point while also propagating those shifts through ordinary downstream edges.
  let rankChanged = true;
  while (rankChanged) {
    rankChanged = false;
    for (const id of loops.order) {
      const required = Math.max(
        -1,
        ...incoming.get(id)!.map(parent => ranks.get(parent) ?? -1),
        ...(exitLoops.get(id) ?? []).flatMap(loop =>
          loop.memberIds.map(member => ranks.get(member) ?? -1)),
      ) + 1;
      if ((ranks.get(id) ?? -1) < required) {
        ranks.set(id, required);
        rankChanged = true;
      }
    }
  }
  const loopByHeader = new Map(loops.loops.map(loop => [loop.headerId, loop]));
  const loopDepth = (id: string) => {
    let depth = 0;
    let loop = [...loops.loops].reverse().find(candidate => candidate.memberIds.includes(id));
    while (loop) {
      depth++;
      loop = loop.parentHeaderId ? loopByHeader.get(loop.parentHeaderId) : undefined;
    }
    return depth;
  };
  const maxDepth = Math.max(0, ...definition.steps.map(step => loopDepth(step.id)));

  // Allocate each loop subtree a contiguous lane interval. Nodes directly in a
  // region share an interval, while child loops occupy disjoint intervals. This
  // makes loop rectangles layout blocks instead of relying on per-rank packing.
  const laneById = new Map<string, number>();
  const allocateRegion = (parentHeaderId: string | undefined, offset: number): number => {
    const childLoops = loops.loops.filter(loop => loop.parentHeaderId === parentHeaderId);
    const childMembers = new Set(childLoops.flatMap(loop => loop.memberIds));
    const parent = parentHeaderId ? loopByHeader.get(parentHeaderId) : undefined;
    const direct = definition.steps.filter(step =>
      (parent ? parent.memberIds.includes(step.id) : loopDepth(step.id) === 0) &&
      !childMembers.has(step.id));
    const usedByRank = new Map<number, number>();
    for (const step of direct) {
      const rank = ranks.get(step.id) ?? 0;
      const lane = usedByRank.get(rank) ?? 0;
      laneById.set(step.id, offset + lane);
      usedByRank.set(rank, lane + 1);
    }
    let next = offset + Math.max(1, ...usedByRank.values());
    for (const child of childLoops) next += allocateRegion(child.headerId, next);
    return next - offset;
  };
  allocateRegion(undefined, 0);

  // Loop chrome extends beyond its cards, so lane/rank spacing includes the
  // maximum possible nesting expansion.
  const laneStride = vertical
    ? WORKFLOW_CARD_WIDTH + WORKFLOW_LANE_GAP + maxDepth * (LOOP_SIDE_HEADER_WIDTH + LOOP_PADDING)
    : WORKFLOW_CARD_HEIGHT + WORKFLOW_ROW_GAP + maxDepth * (LOOP_TOP_HEADER_HEIGHT + LOOP_PADDING);
  const rankStride = vertical
    ? WORKFLOW_CARD_HEIGHT + WORKFLOW_RANK_GAP + maxDepth * 2 * LOOP_PADDING
    : WORKFLOW_CARD_WIDTH + WORKFLOW_COLUMN_GAP + maxDepth * 2 * LOOP_PADDING;
  return { ...definition, steps: definition.steps.map(step => {
    const rank = ranks.get(step.id) ?? 0;
    const lane = laneById.get(step.id) ?? 0;
    return {
      ...step,
      position: vertical
        ? {
            x: lane * laneStride,
            y: rank * rankStride,
          }
        : {
            x: rank * rankStride,
            y: lane * laneStride,
          },
    };
  }) };
}
