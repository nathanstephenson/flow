import type { WorkflowEdge } from '../protocol/workflows.ts';

export interface WorkflowLoop {
  headerId: string;
  memberIds: string[];
  backEdgeIds: string[];
  entryEdgeIds: string[];
  exitEdgeIds: string[];
  parentHeaderId?: string;
}

export interface LoopTopology {
  loops: WorkflowLoop[];
  order: string[];
}

export function analyzeLoops(definition: { steps: { id: string }[]; edges: WorkflowEdge[] }): LoopTopology {
  const ids = definition.steps.map(step => step.id);
  const all = new Set(ids);
  if (all.size !== ids.length) throw new Error('Step IDs must be unique');
  if (new Set(definition.edges.map(edge => edge.id)).size !== definition.edges.length) throw new Error('Edge IDs must be unique');
  const incoming = new Map(ids.map(id => [id, [] as WorkflowEdge[]]));
  const outgoing = new Map(ids.map(id => [id, [] as WorkflowEdge[]]));
  for (const edge of definition.edges) {
    if (!all.has(edge.from) || !all.has(edge.to)) throw new Error('Unknown edge endpoint');
    incoming.get(edge.to)!.push(edge);
    outgoing.get(edge.from)!.push(edge);
  }
  const roots = ids.filter(id => !incoming.get(id)!.length);
  const reachable = new Set(roots);
  const queue = [...roots];
  for (let index = 0; index < queue.length; index++) {
    for (const edge of outgoing.get(queue[index]!)!) {
      if (reachable.has(edge.to)) continue;
      reachable.add(edge.to);
      queue.push(edge.to);
    }
  }
  if (reachable.size !== all.size) throw new Error('Workflow cycle has no entry from a root');
  const dominators = new Map(ids.map(id => [id, new Set(roots.includes(id) ? [id] : ids)]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of queue) {
      const edges = incoming.get(id)!;
      if (!edges.length) continue;
      const common = new Set([...dominators.get(edges[0]!.from)!].filter(candidate => edges.every(edge => dominators.get(edge.from)!.has(candidate))));
      common.add(id);
      const previous = dominators.get(id)!;
      if (common.size !== previous.size || [...common].some(candidate => !previous.has(candidate))) {
        dominators.set(id, common);
        changed = true;
      }
    }
  }
  const backEdges = definition.edges.filter(edge => dominators.get(edge.from)!.has(edge.to));
  const backIds = new Set(backEdges.map(edge => edge.id));
  const members = new Map<string, Set<string>>();
  for (const edge of backEdges) {
    const region = members.get(edge.to) ?? new Set([edge.to]);
    const pending = [edge.from];
    while (pending.length) {
      const id = pending.pop()!;
      if (region.has(id)) continue;
      region.add(id);
      pending.push(...incoming.get(id)!.map(previous => previous.from));
    }
    members.set(edge.to, region);
  }
  const loops: WorkflowLoop[] = [...members].map(([headerId, region]) => ({
    headerId,
    memberIds: ids.filter(id => region.has(id)),
    backEdgeIds: backEdges.filter(edge => edge.to === headerId).map(edge => edge.id),
    entryEdgeIds: definition.edges.filter(edge => !region.has(edge.from) && region.has(edge.to)).map(edge => edge.id),
    exitEdgeIds: definition.edges.filter(edge => region.has(edge.from) && !region.has(edge.to)).map(edge => edge.id),
  }));
  for (const loop of loops) {
    const region = members.get(loop.headerId)!;
    if (definition.edges.some(edge => !region.has(edge.from) && region.has(edge.to) && edge.to !== loop.headerId)) throw new Error('Workflow loop has multiple entry steps');
    const parents: WorkflowLoop[] = [];
    for (const other of loops) {
      if (other === loop) continue;
      const container = members.get(other.headerId)!;
      const intersection = loop.memberIds.filter(id => container.has(id)).length;
      if (!intersection) continue;
      if (intersection === region.size && region.size < container.size) parents.push(other);
      else if (intersection !== container.size || region.size === container.size) throw new Error('Workflow loops overlap without strict nesting');
    }
    parents.sort((left, right) => left.memberIds.length - right.memberIds.length);
    if (parents[0]) loop.parentHeaderId = parents[0].headerId;
  }
  const order: string[] = [];
  const remaining = new Set(ids);
  while (remaining.size) {
    const ready = [...remaining].filter(id => incoming.get(id)!.every(edge => backIds.has(edge.id) || !remaining.has(edge.from)));
    if (!ready.length) throw new Error('Workflow contains an irreducible or multiple-entry cycle');
    for (const id of ready) { order.push(id); remaining.delete(id); }
  }
  loops.sort((left, right) => right.memberIds.length - left.memberIds.length || ids.indexOf(left.headerId) - ids.indexOf(right.headerId));
  return { loops, order };
}
