import { localStack, localStacks, type LocalStack } from "./stack-metadata.ts";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { gh, repositoryTarget, type Gh } from "./publish.ts";
import { head, run, GIT_READ_TIMEOUT_MS, GIT_WRITE_TIMEOUT_MS } from "./git.ts";
import { stackDisplayGraph, type StackCandidate, type StackGraph, type StackGraphBranch, type StackInput, type StackPullRequest, type StackStatus, type StackView } from "../protocol/stack.ts";

async function git(scope: string, args: string[], write = false): Promise<string> {
  const result = await run(scope, args, write ? GIT_WRITE_TIMEOUT_MS : GIT_READ_TIMEOUT_MS);
  if (!result.ok) throw new Error(result.failure.message);
  return result.value;
}

export function parseStack(raw: string): StackView {
  const value = JSON.parse(raw) as StackView;
  if (!value || typeof value.trunk !== "string" || typeof value.currentBranch !== "string" || !Array.isArray(value.branches) || value.branches.some((branch) =>
    !branch || typeof branch.name !== "string" || [branch.isCurrent, branch.isMerged, branch.isQueued, branch.needsRebase].some((flag) => typeof flag !== "boolean") ||
    (branch.pr !== undefined && (!branch.pr || !Number.isInteger(branch.pr.number) || typeof branch.pr.state !== "string")))) throw new Error("Invalid gh stack view JSON.");
  return value;
}

type PullRequest = {
  number: number;
  title?: string;
  html_url?: string;
  state: string;
  merged_at: string | null;
  head: { ref: string; repo: { node_id?: string; id?: number } | null };
  base: { ref: string; repo: { node_id?: string; id?: number } | null };
};

type NativeStack = {
  id: number;
  base: { ref: string };
  pull_requests: {
    number: number;
    state: string;
    merged_at: string | null;
    head: { ref: string };
  }[];
};

type RefState = {
  local: Map<string, { oid: string }>;
  remote: Map<string, { oid: string }>;
  remoteName?: string;
  remoteHead?: string;
};

type Edge = { parent: string; relation: NonNullable<StackGraphBranch["relation"]> };
type DiscoverySnapshot = { current: string; reference: RefState; stacks: LocalStack[]; destination?: Awaited<ReturnType<typeof repositoryTarget>>; prs: PullRequest[] };
type Discovery = { graph?: StackGraph; warnings: string[]; snapshot?: DiscoverySnapshot };

const pullProjection = "map(map({number,title,html_url,state,merged_at,head:{ref:.head.ref,repo:(.head.repo|if . then {node_id,id} else null end)},base:{ref:.base.ref,repo:(.base.repo|if . then {node_id,id} else null end)}}))";
const nativeProjection = "map(map({id,base:{ref:.base.ref},pull_requests:(.pull_requests|map({number,state,merged_at,head:{ref:.head.ref}}))}))";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pages<T>(raw: string, label: string): T[] {
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value) || value.some(page => !Array.isArray(page))) throw new Error(`GitHub returned invalid ${label} data.`);
  return (value as T[][]).flat();
}

function pullRequest(pr: { number: number; state: string; merged_at: string | null; title?: string; html_url?: string }): StackPullRequest {
  return {
    number: pr.number,
    state: pr.merged_at ? "MERGED" : pr.state.toUpperCase(),
    ...(pr.title && pr.html_url ? { title: pr.title, url: pr.html_url } : {}),
  };
}

function validPull(pr: PullRequest): boolean {
  return Number.isInteger(pr?.number) && typeof pr?.head?.ref === "string" && typeof pr?.base?.ref === "string" &&
    ["open", "closed"].includes(pr.state) && (pr.merged_at === null || typeof pr.merged_at === "string");
}

function sameRepository(pr: PullRequest, id: string): boolean {
  const identity = (repo: PullRequest["head"]["repo"]) => repo?.node_id ?? (repo?.id === undefined ? undefined : String(repo.id));
  return identity(pr.head.repo) === id && identity(pr.base.repo) === id;
}

async function refs(scope: string): Promise<RefState> {
  const result: RefState = { local: new Map(), remote: new Map() };
  const raw = await git(scope, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/remotes"]);
  for (const line of raw.trim().split("\n").filter(Boolean)) {
    const space = line.lastIndexOf(" ");
    if (space < 0) continue;
    const ref = line.slice(0, space);
    const oid = line.slice(space + 1);
    if (ref.startsWith("refs/heads/")) result.local.set(ref.slice("refs/heads/".length), { oid });
    else if (ref.startsWith("refs/remotes/") && !ref.endsWith("/HEAD")) {
      const short = ref.slice("refs/remotes/".length);
      const slash = short.indexOf("/");
      if (slash >= 0 && !result.remote.has(short.slice(slash + 1))) result.remote.set(short.slice(slash + 1), { oid });
    }
  }
  const remotes = (await git(scope, ["remote"])).trim().split("\n").filter(Boolean);
  if (remotes.length === 1) {
    result.remoteName = remotes[0]!;
    try {
      const target = (await git(scope, ["symbolic-ref", "--quiet", `refs/remotes/${remotes[0]!}/HEAD`])).trim();
      const prefix = `refs/remotes/${remotes[0]!}/`;
      if (target.startsWith(prefix)) result.remoteHead = target.slice(prefix.length);
    } catch { /* A remote without an existing HEAD is not an error. */ }
  }
  return result;
}

function expectedNativeUnavailable(error: unknown): boolean {
  return /(?:HTTP 404|not found|stacked pull requests (?:are )?not (?:enabled|available))/i.test(message(error));
}

function addWarning(warnings: string[], value: string): void {
  if (value && !warnings.includes(value)) warnings.push(value);
}

async function ancestry(scope: string, tips: string[]): Promise<(ancestor: string, descendant: string) => boolean> {
  const unique = [...new Set(tips)];
  const merged = new Map<string, Set<string>>();
  // Ask Git to walk each tip, but emit only matching refs. Unlike rev-list this keeps output
  // bounded by the number of refs rather than by repository history.
  await Promise.all(unique.map(async descendant => {
    const raw = await git(scope, ["for-each-ref", `--merged=${descendant}`, "--format=%(objectname)", "refs/heads", "refs/remotes"]);
    merged.set(descendant, new Set(raw.trim().split("\n").filter(Boolean)));
  }));
  return (ancestor, descendant) => ancestor === descendant || Boolean(merged.get(descendant)?.has(ancestor));
}

/**
 * Read-only discovery for the current branch. It deliberately uses only inspection commands:
 * no fetch, import, registration, checkout, rebase, or push is performed here.
 */
export async function discoverStackGraph(scope: string, github: Gh = gh): Promise<Discovery> {
  const warnings: string[] = [];
  const currentResult = await head(scope);
  if (!currentResult.ok) return { warnings: [currentResult.failure.message] };
  if (currentResult.value.detached) return { warnings };
  const current = currentResult.value.name;

  let reference: RefState;
  try { reference = await refs(scope); }
  catch (error) { return { warnings: [message(error)] }; }

  let stacks: LocalStack[] = [];
  try { stacks = await localStacks(scope); }
  catch (error) { addWarning(warnings, `Local stack metadata could not be read: ${message(error)}`); }
  const localMatches = stacks.filter(stack => stack.branches.some(branch => branch.branch === current));

  let destination: Awaited<ReturnType<typeof repositoryTarget>> | undefined;
  let prs: PullRequest[] = [];
  let nativeStacks: NativeStack[] = [];
  if (reference.remoteName) {
    try { destination = await repositoryTarget(scope, github); }
    catch (error) { addWarning(warnings, `GitHub stack discovery failed: ${message(error)}`); }
    if (destination) {
      const [nativeResult, pullsResult] = await Promise.allSettled([
        github(scope, ["api", "--paginate", "--slurp", "--jq", nativeProjection, `repos/${destination.repo}/stacks?per_page=100`]),
        github(scope, ["api", "--paginate", "--slurp", "--jq", pullProjection, `repos/${destination.repo}/pulls?state=all&per_page=100`]),
      ]);
      if (nativeResult.status === "fulfilled") {
        try {
          const loaded = pages<NativeStack>(nativeResult.value, "native stack");
          nativeStacks = loaded.filter(stack => Number.isInteger(stack?.id) && typeof stack?.base?.ref === "string" && Array.isArray(stack.pull_requests) && stack.pull_requests.every(pr =>
            Number.isInteger(pr?.number) && typeof pr?.head?.ref === "string" && ["open", "closed"].includes(pr.state) && (pr.merged_at === null || typeof pr.merged_at === "string")));
          if (nativeStacks.length !== loaded.length) addWarning(warnings, "Some invalid native stack data was ignored.");
        } catch (error) { addWarning(warnings, `Native GitHub stack data could not be parsed: ${message(error)}`); }
      } else if (!expectedNativeUnavailable(nativeResult.reason)) addWarning(warnings, `Native GitHub stacks could not be read: ${message(nativeResult.reason)}`);
      if (pullsResult.status === "fulfilled") {
        try {
          const loaded = pages<PullRequest>(pullsResult.value, "pull request");
          if (loaded.some(pr => !validPull(pr))) addWarning(warnings, "Some invalid pull request relationships were ignored.");
          prs = loaded.filter(validPull);
        } catch (error) { addWarning(warnings, `Pull request relationship data could not be parsed: ${message(error)}`); }
      } else addWarning(warnings, `Pull request relationships could not be read: ${message(pullsResult.reason)}`);
    }
  }

  const repositoryId = destination?.id ? String(destination.id) : undefined;
  if (repositoryId) prs = prs.filter(pr => sameRepository(pr, repositoryId));
  else prs = [];
  const snapshot: DiscoverySnapshot = { current, reference, stacks, ...(destination ? { destination } : {}), prs };

  const nodes = new Set<string>();
  const prsByBranch = new Map<string, StackPullRequest>();
  const edges = new Map<string, Edge>();
  const claimed = new Set<string>();
  const explicitMembers = new Set<string>();
  const blocked = new Set<string>();
  const explicitEdges = new Map<string, { parent: string; relation: "native" | "local" }[]>();
  const explicitTrunks = new Set<string>();

  const offerExplicit = (child: string, parent: string, relation: "native" | "local") => {
    nodes.add(child);
    explicitMembers.add(child);
    const choices = explicitEdges.get(child) ?? [];
    choices.push({ parent, relation });
    explicitEdges.set(child, choices);
  };

  for (const stack of localMatches) {
    explicitTrunks.add(stack.trunk.branch);
    let parent = stack.trunk.branch;
    for (const branch of stack.branches) {
      offerExplicit(branch.branch, parent, "local");
      if (branch.pullRequest) prsByBranch.set(branch.branch, { number: branch.pullRequest.number, state: branch.pullRequest.merged ? "MERGED" : "OPEN" });
      parent = branch.branch;
    }
  }

  for (const stack of nativeStacks.filter(stack => stack.pull_requests.some(pr => pr.head.ref === current))) {
    const topOpen = stack.pull_requests.reduce((last, pr, index) => pr.state === "open" ? index : last, -1);
    if (topOpen < 0) continue;
    explicitTrunks.add(stack.base.ref);
    let parent: string | undefined = stack.base.ref;
    for (let index = 0; index <= topOpen; index++) {
      const pr = stack.pull_requests[index]!;
      if (pr.state === "closed" && !pr.merged_at) {
        // Do not let a closed-unmerged member connect the members around it.
        parent = undefined;
        continue;
      }
      if (parent) offerExplicit(pr.head.ref, parent, "native");
      else {
        nodes.add(pr.head.ref);
        explicitMembers.add(pr.head.ref);
        claimed.add(pr.head.ref);
        blocked.add(pr.head.ref);
        addWarning(warnings, `A closed-unmerged native stack member precedes ${pr.head.ref}; its parent was omitted.`);
      }
      prsByBranch.set(pr.head.ref, pullRequest(pr));
      parent = pr.head.ref;
    }
  }

  for (const [child, choices] of explicitEdges) {
    const parents = [...new Set(choices.map(choice => choice.parent))];
    claimed.add(child);
    if (parents.length !== 1) {
      blocked.add(child);
      addWarning(warnings, `Conflicting explicit stack parents for ${child}; its parent was omitted.`);
      continue;
    }
    edges.set(child, { parent: parents[0]!, relation: choices.some(choice => choice.relation === "native") ? "native" : "local" });
  }

  let trunk: string | undefined;
  if (explicitTrunks.size === 1) trunk = [...explicitTrunks][0];
  else if (explicitTrunks.size > 1) addWarning(warnings, "Conflicting explicit stack trunks were found; the trunk was left unknown.");
  else trunk = destination?.defaultBranch ?? reference.remoteHead;

  const byHead = new Map<string, PullRequest[]>();
  for (const pr of prs) {
    const list = byHead.get(pr.head.ref) ?? [];
    list.push(pr);
    byHead.set(pr.head.ref, list);
  }
  const selected = new Map<string, PullRequest>();
  for (const [branch, branchPRs] of byHead) {
    const open = branchPRs.filter(pr => pr.state === "open");
    if (open.length === 1) selected.set(branch, open[0]!);
    else if (open.length > 1) {
      claimed.add(branch);
      blocked.add(branch);
      addWarning(warnings, `Multiple open pull requests describe ${branch}; its parent was omitted.`);
    }
  }

  // A merged PR only participates when it is needed to connect an active descendant.
  const queue = [...selected.values()].map(pr => pr.base.ref);
  const visitedBases = new Set<string>();
  while (queue.length) {
    const branch = queue.shift()!;
    if (branch === trunk || visitedBases.has(branch) || selected.has(branch)) continue;
    visitedBases.add(branch);
    const merged = (byHead.get(branch) ?? []).filter(pr => Boolean(pr.merged_at));
    if (!merged.length) continue;
    const parents = [...new Set(merged.map(pr => pr.base.ref))];
    if (parents.length !== 1) {
      claimed.add(branch);
      blocked.add(branch);
      addWarning(warnings, `Historical pull requests disagree about the parent of ${branch}; its parent was omitted.`);
      continue;
    }
    // GitHub lists newest PRs first. Equivalent historical relationships do not compete.
    selected.set(branch, merged[0]!);
    queue.push(merged[0]!.base.ref);
  }

  for (const [child, pr] of selected) {
    nodes.add(child);
    if (pr.base.ref !== trunk) nodes.add(pr.base.ref);
    prsByBranch.set(child, pullRequest(pr));
    claimed.add(child);
    if (!edges.has(child) && !blocked.has(child)) edges.set(child, { parent: pr.base.ref, relation: "pull-request" });
  }

  const trunkValues = trunk ? [reference.local.get(trunk), reference.remote.get(trunk)].filter((value): value is { oid: string } => Boolean(value)) : [];
  const trunkValue = trunkValues[0];
  if (trunk && trunkValue) {
    const localValues = [...reference.local.values()];
    let isAncestor: ((ancestor: string, descendant: string) => boolean) | undefined;
    try { isAncestor = await ancestry(scope, [...localValues, ...trunkValues].map(value => value.oid)); }
    catch (error) { addWarning(warnings, `Local ancestry could not be read: ${message(error)}`); }
    const usable: string[] = [];
    if (isAncestor) {
    for (const [branch, value] of reference.local) {
      // Either trunk tip may know that a branch is already merged. A stale local trunk
      // must never resurrect a branch contained by the remote tracking tip.
      if (branch === trunk || trunkValues.some(tip => isAncestor(value.oid, tip.oid))) continue;
      if (trunkValues.some(tip => isAncestor(tip.oid, value.oid))) usable.push(branch);
    }
    for (const child of usable) {
      if (claimed.has(child) || blocked.has(child) || edges.has(child)) continue;
      const childRef = reference.local.get(child)!;
      const ancestors: string[] = [];
      for (const parent of usable) {
        if (parent === child) continue;
        const parentRef = reference.local.get(parent)!;
        if (parentRef.oid === childRef.oid) continue;
        if (isAncestor(parentRef.oid, childRef.oid)) ancestors.push(parent);
      }
      const nearest: string[] = [];
      for (const candidate of ancestors) {
        let shadowed = false;
        for (const other of ancestors) {
          if (other === candidate) continue;
          const candidateRef = reference.local.get(candidate)!;
          const otherRef = reference.local.get(other)!;
          if (candidateRef.oid !== otherRef.oid && isAncestor(candidateRef.oid, otherRef.oid)) { shadowed = true; break; }
        }
        if (!shadowed) nearest.push(candidate);
      }
      if (nearest.length === 1) {
        nodes.add(child);
        nodes.add(nearest[0]!);
        edges.set(child, { parent: nearest[0]!, relation: "ancestry" });
      } else if (nearest.length > 1) {
        blocked.add(child);
        addWarning(warnings, `Local history has multiple equally near parents for ${child}; its parent was omitted.`);
      } else {
        // This records the root without making a lone branch qualify as an inferred stack.
        nodes.add(child);
        edges.set(child, { parent: trunk, relation: "ancestry" });
      }
    }
    }
  } else if (!trunk && new Set([...reference.local.values()].map(value => value.oid)).size >= 2 && !explicitMembers.size && !selected.size) {
    addWarning(warnings, "The trunk branch is unknown, so local branch relationships could not be inferred.");
  } else if (trunk && !trunkValue && new Set([...reference.local.values()].map(value => value.oid)).size >= 2 && !explicitMembers.size && !selected.size) {
    addWarning(warnings, `The trunk ${trunk} is not available in local refs, so local branch relationships could not be inferred.`);
  }

  // A parent map cannot safely contain a cycle. Remove every edge in each cycle rather than
  // selecting an arbitrary edge to break it.
  const checked = new Set<string>();
  for (const start of edges.keys()) {
    if (checked.has(start)) continue;
    const path: string[] = [];
    const position = new Map<string, number>();
    let branch: string | undefined = start;
    while (branch && edges.has(branch) && !checked.has(branch)) {
      const seen = position.get(branch);
      if (seen !== undefined) {
        const cycle = path.slice(seen);
        for (const member of cycle) { edges.delete(member); blocked.add(member); }
        addWarning(warnings, `A stack relationship cycle involving ${[...cycle].sort().join(", ")} was omitted.`);
        break;
      }
      position.set(branch, path.length);
      path.push(branch);
      branch = edges.get(branch)?.parent;
    }
    for (const member of path) checked.add(member);
  }

  if (current === trunk || !nodes.has(current)) return { warnings, snapshot };

  // Scope through non-trunk edges only. Trunk is a boundary, not a hub joining unrelated stacks.
  const adjacent = new Map<string, Set<string>>();
  const join = (a: string, b: string) => {
    const aSet = adjacent.get(a) ?? new Set<string>(); aSet.add(b); adjacent.set(a, aSet);
    const bSet = adjacent.get(b) ?? new Set<string>(); bSet.add(a); adjacent.set(b, bSet);
  };
  for (const [child, edge] of edges) if (edge.parent !== trunk && nodes.has(edge.parent)) join(child, edge.parent);
  const component = new Set<string>([current]);
  const pending = [current];
  while (pending.length) for (const next of adjacent.get(pending.shift()!) ?? []) if (!component.has(next)) { component.add(next); pending.push(next); }

  const explicit = [...component].some(branch => explicitMembers.has(branch));
  const related = [...component].some(branch => {
    const parent = edges.get(branch)?.parent;
    return parent !== undefined && parent !== trunk && component.has(parent);
  });
  if (!explicit && (component.size < 2 || !related)) return { warnings, snapshot };

  const children = new Map<string, string[]>();
  for (const branch of component) {
    const parent = edges.get(branch)?.parent;
    if (!parent || !component.has(parent)) continue;
    const list = children.get(parent) ?? [];
    list.push(branch);
    children.set(parent, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.localeCompare(b));
  const roots = [...component].filter(branch => !component.has(edges.get(branch)?.parent ?? "")).sort((a, b) => a.localeCompare(b));
  const order: string[] = [];
  const append = (branch: string) => { order.push(branch); for (const child of children.get(branch) ?? []) append(child); };
  for (const root of roots) append(root);

  const branches = order.map(name => {
    const edge = edges.get(name);
    return {
      name,
      ...(edge ? { parent: edge.parent, relation: edge.relation } : {}),
      isCurrent: name === current,
      availability: reference.local.has(name) ? "local" as const : "remote" as const,
      ...(prsByBranch.has(name) ? { pr: prsByBranch.get(name)! } : {}),
    };
  });
  return { graph: { ...(trunk ? { trunk } : {}), currentBranch: current, branches, explicit }, warnings, snapshot };
}

type PullIndexes = { byHead: Map<string, PullRequest[]>; openByBase: Map<string, PullRequest[]> };

function indexPullRequests(pullRequests: PullRequest[]): PullIndexes {
  const byHead = new Map<string, PullRequest[]>();
  const openByBase = new Map<string, PullRequest[]>();
  for (const pr of pullRequests) {
    const heads = byHead.get(pr.head.ref) ?? [];
    heads.push(pr);
    byHead.set(pr.head.ref, heads);
    if (pr.state === "open") {
      const children = openByBase.get(pr.base.ref) ?? [];
      children.push(pr);
      openByBase.set(pr.base.ref, children);
    }
  }
  return { byHead, openByBase };
}

function candidateFromSnapshot(snapshot: DiscoverySnapshot): StackCandidate | undefined {
  const { current, reference, stacks, destination } = snapshot;
  const { byHead, openByBase } = indexPullRequests(snapshot.prs);
  if (!destination?.id || current === destination.defaultBranch) return;
  const tracked = new Set(stacks.flatMap(stack => [stack.trunk.branch, ...stack.branches.map(branch => branch.branch)]));
  if (stacks.some(stack => stack.branches.some(branch => branch.branch === current))) return;
  const localRefs = [...reference.local].map(([name, value]) => [name, value.oid] as [string, string]);
  const trunk = destination.defaultBranch;
  const base = localRefs.find(([name]) => name === trunk);
  if (!base) return;
  const choose = (branch: string, merged: boolean): PullRequest | undefined => {
    const matching = byHead.get(branch) ?? [];
    const open = matching.filter(pr => pr.state === "open");
    if (open.length === 1) return open[0];
    if (open.length > 1 || !merged) return;
    const history = matching.filter(pr => Boolean(pr.merged_at));
    return new Set(history.map(pr => pr.base.ref)).size === 1 ? history[0] : undefined;
  };
  const chain: PullRequest[] = [];
  const seen = new Set<string>();
  let branch = current;
  while (branch !== trunk) {
    if (seen.has(branch)) return;
    seen.add(branch);
    const parent = choose(branch, true);
    if (!parent) return;
    chain.unshift(parent);
    branch = parent.base.ref;
  }
  branch = current;
  while (true) {
    const children = openByBase.get(branch) ?? [];
    if (!children.length) break;
    if (children.length !== 1 || seen.has(children[0]!.head.ref)) return;
    chain.push(children[0]!);
    branch = children[0]!.head.ref;
    seen.add(branch);
  }
  if (chain.length < 2 || !chain.some(pr => pr.state === "open")) return;
  for (const pr of chain) if (pr.head.ref === trunk || tracked.has(pr.head.ref) || !reference.local.has(pr.head.ref)) return;
  for (const pr of chain) if ((openByBase.get(pr.head.ref)?.length ?? 0) > (pr === chain.at(-1) ? 0 : 1)) return;
  return {
    trunk,
    branches: chain.map(pr => pr.head.ref),
    pullRequests: chain.map(pr => ({ branch: pr.head.ref, ...pullRequest(pr) })),
    fingerprint: createHash("sha256").update(JSON.stringify({ destination, base, chain, localRefs, current })).digest("hex"),
  };
}

export async function discoverStack(scope: string, github: Gh = gh): Promise<StackCandidate | undefined> {
  try {
    const current = await head(scope);
    if (!current.ok || current.value.detached) return;
    const [reference, stacks, destination] = await Promise.all([refs(scope), localStacks(scope), repositoryTarget(scope, github)]);
    const loaded = pages<PullRequest>(await github(scope, ["api", "--paginate", "--slurp", "--jq", pullProjection, `repos/${destination.repo}/pulls?state=all&per_page=100`]), "pull request");
    if (loaded.some(pr => !validPull(pr)) || !destination.id) return;
    const prs = loaded.filter(pr => sameRepository(pr, String(destination.id)));
    return candidateFromSnapshot({ current: current.value.name, reference, stacks, destination, prs });
  } catch { return; }
}

export async function actionStackStatus(scope: string, github: Gh = gh): Promise<StackStatus> {
  const status: StackStatus = { available: false, conflicts: [], rebasing: false };
  try { await github(scope, ["stack", "--help"]); status.available = true; }
  catch {
    status.problem = "Install GitHub CLI, then run gh extension install github/gh-stack on the Session Host to manage this stack. Viewing does not require the extension. Run gh auth login if needed.";
    status.problemKind = "action";
  }
  try {
    status.conflicts = (await git(scope, ["diff", "--name-only", "--diff-filter=U", "-z"])).split("\0").filter(Boolean);
    const path = (await git(scope, ["rev-parse", "--git-path", "gh-stack-rebase-state"])).trim();
    status.rebasing = await access(resolve(scope, path)).then(() => true, () => false);
  } catch (error) {
    status.problem = message(error);
    status.problemKind = "discovery";
  }
  if (status.available) {
    try { status.view = parseStack(await github(scope, ["stack", "view", "--json"])); }
    catch (error) {
      if (/current branch .+ (?:is not|not) (?:a )?part of (?:a |any )?stack/i.test(message(error))) {
        status.warnings = ["gh-stack reports that the current branch is not part of a managed stack."];
      } else status.warnings = [`Managed stack details could not be read: ${message(error)}`];
    }
  }
  return status;
}

export async function stackStatus(scope: string, github: Gh = gh): Promise<StackStatus> {
  const status = await actionStackStatus(scope, github);
  const actionProblem = status.problemKind === "action" ? status.problem : undefined;
  if (actionProblem) { delete status.problem; delete status.problemKind; }
  const notManagedWarning = "gh-stack reports that the current branch is not part of a managed stack.";
  const warnings = [...(status.warnings ?? [])];
  delete status.warnings;
  let discovery: Discovery | undefined;
  try {
    discovery = await discoverStackGraph(scope, github);
    if (discovery.graph) status.graph = discovery.graph;
    if (status.view && discovery.snapshot) {
      const details = new Map(discovery.snapshot.prs.map(pr => [pr.number, pr]));
      for (const branch of status.view.branches) {
        if (!branch.pr) continue;
        const found = details.get(branch.pr.number);
        if (found?.title && found.html_url) Object.assign(branch.pr, { title: found.title, url: found.html_url });
      }
    }
    for (const warning of discovery.warnings) addWarning(warnings, warning);
    if (!discovery.snapshot?.stacks.some(stack => stack.branches.some(branch => branch.branch === discovery!.snapshot!.current))) {
      const index = warnings.indexOf(notManagedWarning);
      if (index >= 0) warnings.splice(index, 1);
    }
  } catch (error) { addWarning(warnings, `Stack discovery failed: ${message(error)}`); }
  if (!status.view && !status.rebasing) {
    try {
      const candidate = discovery?.snapshot ? candidateFromSnapshot(discovery.snapshot) : undefined;
      if (candidate) status.candidate = candidate;
    }
    catch (error) {
      // Broad discovery may still have produced a useful graph. Candidate failure only removes Init.
      if (status.graph) addWarning(warnings, `This graph is read-only because registration eligibility could not be verified: ${message(error)}`);
    }
  }
  const displayGraph = stackDisplayGraph(status);
  if (displayGraph) status.graph = displayGraph;
  else delete status.graph;
  if (warnings.length) status.warnings = warnings;

  const hasDisplay = Boolean(status.graph || status.rebasing);
  if (!status.problem && warnings.length && !hasDisplay) {
    status.problem = warnings.shift()!;
    status.problemKind = "discovery";
    if (warnings.length) status.warnings = warnings;
    else delete status.warnings;
  } else if (!status.problem && actionProblem) {
    status.problem = actionProblem;
    status.problemKind = "action";
  }
  return status;
}

export async function cleanStack(scope: string): Promise<void> {
  if ((await git(scope, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).length) throw new Error("This Scope has uncommitted changes. Use Publish or commit them first. Stack operations never stash changes.");
  for (const operation of ["rebase-merge", "rebase-apply", "sequencer", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "gh-stack-rebase-state"]) {
    const path = (await git(scope, ["rev-parse", "--git-path", operation])).trim();
    if (await access(resolve(scope, path)).then(() => true, () => false)) throw new Error("Finish or abort the current Git operation first.");
  }
}

export async function stackFingerprint(scope: string, view: StackView, sync = false, github: Gh = gh): Promise<string> {
  let membership: unknown;
  if (sync) {
    if (view.currentBranch === view.trunk) throw new Error("Switch to a branch in the stack before reviewing Sync.");
    const stack = await localStack(scope, view.currentBranch);
    if (stack?.id) {
      const remote = JSON.parse(await github(scope, ["api", `repos/{owner}/{repo}/stacks/${stack.id}`, "--jq", "{id,pull_requests:(.pull_requests|map({number,head:{ref:.head.ref}}))}"])) as { id: number; pull_requests: { number: number; head: { ref: string } }[] };
      if (!remote || !Number.isInteger(remote.id)) throw new Error("Cannot verify remote stack membership.");
      membership = remote;
      if (remote && (!Array.isArray(remote.pull_requests) || JSON.stringify(remote.pull_requests.map(pr => [pr.head?.ref, pr.number])) !== JSON.stringify(stack.branches.filter(b => b.pullRequest).map(b => [b.branch, b.pullRequest!.number])))) throw new Error("Remote stack membership differs from the local stack. Review and import remote branches with gh stack outside Flow, then review Sync again.");
    }
  }
  const refs = await git(scope, ["show-ref", "--head"]);
  const config = await git(scope, ["config", "--local", "--list"]);
  return createHash("sha256").update(JSON.stringify({ view, refs, config, membership })).digest("hex");
}

export async function changeStack(scope: string, input: StackInput, github: Gh = gh): Promise<string> {
  const { action } = input;
  if (!["init", "add", "checkout", "rebase", "continue", "abort", "submit", "sync"].includes(action)) throw new Error("Unknown Stack action.");
  if (action === "continue" || action === "abort") {
    const state = await actionStackStatus(scope, github);
    if (!state.rebasing) throw new Error("No Stack rebase is in progress.");
    if (action === "continue" && state.conflicts.length) throw new Error("Resolve and stage all conflict files before continuing.");
  } else await cleanStack(scope);
  const args = ["stack", action];
  if (action === "init") {
    const candidate = await discoverStack(scope, github);
    if (!candidate || input.fingerprint !== candidate.fingerprint || JSON.stringify(input.branches) !== JSON.stringify(candidate.branches)) throw new Error("The existing branch chain changed or is not eligible. Refresh Stack and review it again.");
    args.push("--base", candidate.trunk);
  }
  if (action === "init" || action === "add" || action === "checkout") {
    if (!Array.isArray(input.branches) || !input.branches.length || (action !== "init" && input.branches.length !== 1)) throw new Error("Enter a branch name.");
    for (const branch of input.branches) {
      if (typeof branch !== "string" || branch.startsWith("-") || !branch.trim()) throw new Error("Invalid branch name.");
      await git(scope, ["check-ref-format", "--branch", branch]);
    }
    if (action === "checkout") {
      const state = await actionStackStatus(scope, github);
      const branch = input.branches[0]!;
      if (!state.view?.branches.some(b => b.name === branch)) throw new Error("Choose a branch in the current local stack.");
      await git(scope, ["show-ref", "--verify", `refs/heads/${branch}`]);
      return git(scope, ["switch", "--no-guess", "--", branch], true);
    }
    args.push(...input.branches);
  }
  if (action === "continue" || action === "abort") args.splice(1, 1, "rebase", `--${action}`);
  if (action === "submit") args.push("--auto");
  return github(scope, args);
}

export const stackConflictMessage = "Resolve the current gh stack rebase conflicts in this Scope. Inspect the Stack rebase state and conflict files first. Preserve the intended changes and stage only resolved files. Run gh stack rebase --continue only after git diff --name-only --diff-filter=U is empty and all conflicts are resolved. Repeat for further conflicts; stop and report if the intended resolution is unclear. This request permits local conflict repair and Stack rebase continuation only. Do not push, publish, submit, sync, merge, or restructure the stack. Report the result so I can review it before any separate Sync confirmation.";
