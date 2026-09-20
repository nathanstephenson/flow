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
  const ranks = new Map<string, number>();
  const pending = new Set(definition.steps.map(step => step.id));
  while (pending.size) {
    let progressed = false;
    for (const id of pending) {
      const parents = definition.edges.filter(edge => edge.to === id && !back.has(edge.id)).map(edge => edge.from);
      if (parents.some(id => !ranks.has(id))) continue;
      ranks.set(id, Math.max(-1, ...parents.map(id => ranks.get(id)!)) + 1);
      pending.delete(id);
      progressed = true;
    }
    if (!progressed) break;
  }
  // A loop's exit originates at its header, but visually follows the entire loop body.
  // Treat each loop as a rank block and propagate the shifted exits through downstream steps.
  let rankChanged = true;
  while (rankChanged) {
    rankChanged = false;
    for (const edge of definition.edges) {
      if (back.has(edge.id)) continue;
      const sourceRank = ranks.get(edge.from);
      const targetRank = ranks.get(edge.to);
      if (sourceRank === undefined || targetRank === undefined) continue;
      const containing = loops.loops.filter(loop =>
        loop.headerId === edge.from && !loop.memberIds.includes(edge.to));
      const required = Math.max(sourceRank, ...containing.flatMap(loop =>
        loop.memberIds.map(id => ranks.get(id) ?? sourceRank))) + 1;
      if (targetRank < required) {
        ranks.set(edge.to, required);
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
  // Each containing loop grows beyond its cards on both axes. Reserve that growth
  // between lanes and ranks so sibling loop boxes cannot overlap.
  const laneStride = vertical
    ? WORKFLOW_CARD_WIDTH + WORKFLOW_LANE_GAP + maxDepth * (LOOP_SIDE_HEADER_WIDTH + LOOP_PADDING)
    : WORKFLOW_CARD_HEIGHT + WORKFLOW_ROW_GAP + maxDepth * (LOOP_TOP_HEADER_HEIGHT + LOOP_PADDING);
  const rankStride = vertical
    ? WORKFLOW_CARD_HEIGHT + WORKFLOW_RANK_GAP + maxDepth * 2 * LOOP_PADDING
    : WORKFLOW_CARD_WIDTH + WORKFLOW_COLUMN_GAP + maxDepth * 2 * LOOP_PADDING;
  const lanes = new Map<number, number>();
  return { ...definition, steps: definition.steps.map(step => {
    const rank = ranks.get(step.id) ?? 0;
    const lane = lanes.get(rank) ?? 0;
    lanes.set(rank, lane + 1);
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
