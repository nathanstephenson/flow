import { localStack, localStacks, type LocalStack } from "./stack-metadata.ts";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { gh, repositoryTarget, type Gh } from "./publish.ts";
import { head, run, GIT_READ_TIMEOUT_MS, GIT_WRITE_TIMEOUT_MS } from "./git.ts";
import type { StackCandidate, StackGraph, StackGraphBranch, StackInput, StackPullRequest, StackStatus, StackView } from "../protocol/stack.ts";

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
  created_at?: string;
  updated_at?: string;
  head: { ref: string; repo: { node_id?: string; id?: number } | null };
  base: { ref: string; repo: { node_id?: string; id?: number } | null };
};

type NativeStack = {
  id: number;
  number?: number;
  open?: boolean;
  base: { ref: string };
  pull_requests: {
    number: number;
    state: string;
    draft?: boolean;
    merged_at: string | null;
    head: { ref: string; sha?: string };
  }[];
};

type RefState = {
  local: Map<string, { oid: string; ref: string }>;
  remote: Map<string, { oid: string; ref: string }>;
  remoteName?: string;
  remoteHead?: string;
};

type Edge = { parent: string; relation: NonNullable<StackGraphBranch["relation"]> };
type Discovery = { graph?: StackGraph; warnings: string[] };

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
    if (ref.startsWith("refs/heads/")) result.local.set(ref.slice("refs/heads/".length), { oid, ref });
    else if (ref.startsWith("refs/remotes/") && !ref.endsWith("/HEAD")) {
      const short = ref.slice("refs/remotes/".length);
      const slash = short.indexOf("/");
      if (slash >= 0 && !result.remote.has(short.slice(slash + 1))) result.remote.set(short.slice(slash + 1), { oid, ref });
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

async function isAncestor(scope: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await run(scope, ["merge-base", "--is-ancestor", ancestor, descendant], GIT_READ_TIMEOUT_MS);
  return result.ok;
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
      try {
        nativeStacks = pages<NativeStack>(await github(scope, ["api", "--paginate", "--slurp", `repos/${destination.repo}/stacks?per_page=100`]), "native stack");
        if (nativeStacks.some(stack => !Number.isInteger(stack?.id) || typeof stack?.base?.ref !== "string" || !Array.isArray(stack.pull_requests) || stack.pull_requests.some(pr =>
          !Number.isInteger(pr?.number) || typeof pr?.head?.ref !== "string" || !["open", "closed"].includes(pr.state) || !(pr.merged_at === null || typeof pr.merged_at === "string")))) {
          nativeStacks = [];
          addWarning(warnings, "GitHub returned invalid native stack data.");
        }
      } catch (error) {
        if (!expectedNativeUnavailable(error)) addWarning(warnings, `Native GitHub stacks could not be read: ${message(error)}`);
      }
      try {
        const raw = await github(scope, ["api", "--paginate", "--slurp", `repos/${destination.repo}/pulls?state=all&per_page=100`]);
        const loaded = pages<PullRequest>(raw, "pull request");
        if (loaded.some(pr => !validPull(pr))) addWarning(warnings, "Some invalid pull request relationships were ignored.");
        prs = loaded.filter(validPull);
      } catch (error) { addWarning(warnings, `Pull request relationships could not be read: ${message(error)}`); }
    }
  }

  const repositoryId = destination?.id ? String(destination.id) : undefined;
  if (repositoryId) prs = prs.filter(pr => sameRepository(pr, repositoryId));
  else prs = [];

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

  // Fill only genuinely unknown local relationships, and only above a known trunk.
  const trunkRef = trunk ? reference.local.get(trunk)?.ref ?? reference.remote.get(trunk)?.ref : undefined;
  if (trunk && trunkRef) {
    const usable: string[] = [];
    for (const [branch, value] of reference.local) {
      if (branch === trunk || await isAncestor(scope, value.ref, trunkRef)) continue;
      if (await isAncestor(scope, trunkRef, value.ref)) usable.push(branch);
    }
    for (const child of usable) {
      if (claimed.has(child) || blocked.has(child) || edges.has(child)) continue;
      const childRef = reference.local.get(child)!;
      const ancestors: string[] = [];
      for (const parent of usable) {
        if (parent === child) continue;
        const parentRef = reference.local.get(parent)!;
        if (parentRef.oid === childRef.oid) continue;
        if (await isAncestor(scope, parentRef.ref, childRef.ref)) ancestors.push(parent);
      }
      const nearest: string[] = [];
      for (const candidate of ancestors) {
        let shadowed = false;
        for (const other of ancestors) {
          if (other === candidate) continue;
          const candidateRef = reference.local.get(candidate)!;
          const otherRef = reference.local.get(other)!;
          if (candidateRef.oid !== otherRef.oid && await isAncestor(scope, candidateRef.ref, otherRef.ref)) { shadowed = true; break; }
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
  } else if (!trunk && new Set([...reference.local.values()].map(value => value.oid)).size >= 2 && !explicitMembers.size && !selected.size) {
    addWarning(warnings, "The trunk branch is unknown, so local branch relationships could not be inferred.");
  } else if (trunk && !trunkRef && new Set([...reference.local.values()].map(value => value.oid)).size >= 2 && !explicitMembers.size && !selected.size) {
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

  if (current === trunk || !nodes.has(current)) return { warnings };

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
  if (!explicit && (component.size < 2 || !related)) return { warnings };

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
  return { graph: { ...(trunk ? { trunk } : {}), currentBranch: current, branches, explicit }, warnings };
}

/**
 * Finds the deliberately narrow, local, linear PR chain that gh stack init may register.
 * This is separate from discoverStackGraph so a broad display graph never authorizes mutation.
 */
export async function discoverStack(scope: string, github: Gh = gh): Promise<StackCandidate | undefined> {
  const current = await head(scope);
  if (!current.ok || current.value.detached) return;
  const stacks = await localStacks(scope);
  const tracked = new Set(stacks.flatMap(stack => [stack.trunk.branch, ...stack.branches.map(branch => branch.branch)]));
  if (stacks.some(stack => stack.branches.some(branch => branch.branch === current.value.name))) return;
  const localRefs = (await git(scope, ["for-each-ref", "--format=%(refname:strip=2) %(objectname)", "refs/heads"])).trim().split("\n").filter(Boolean).map(line => line.split(" ") as [string, string]);
  let destination: Awaited<ReturnType<typeof repositoryTarget>>;
  let loaded: PullRequest[];
  try {
    destination = await repositoryTarget(scope, github);
    loaded = pages<PullRequest>(await github(scope, ["api", "--paginate", "--slurp", `repos/${destination.repo}/pulls?state=all&per_page=100`]), "pull request");
  } catch { return; }
  if (current.value.name === destination.defaultBranch || !destination.id || loaded.some(pr => !validPull(pr))) return;
  const pullRequests = loaded.filter(pr => sameRepository(pr, String(destination.id)));
  const trunk = destination.defaultBranch;
  const base = localRefs.find(([name]) => name === trunk);
  if (!base) return;

  const choose = (branch: string, merged: boolean): PullRequest | undefined => {
    const matching = pullRequests.filter(pr => pr.head.ref === branch);
    const open = matching.filter(pr => pr.state === "open");
    if (open.length === 1) return open[0];
    if (open.length > 1 || !merged) return;
    const history = matching.filter(pr => Boolean(pr.merged_at));
    return new Set(history.map(pr => pr.base.ref)).size === 1 ? history[0] : undefined;
  };

  const chain: PullRequest[] = [];
  const seen = new Set<string>();
  let branch = current.value.name;
  while (branch !== trunk) {
    if (seen.has(branch)) return;
    seen.add(branch);
    const parent = choose(branch, true);
    if (!parent) return;
    chain.unshift(parent);
    branch = parent.base.ref;
  }
  branch = current.value.name;
  while (true) {
    const children = pullRequests.filter(pr => pr.state === "open" && pr.base.ref === branch);
    if (!children.length) break;
    if (children.length !== 1 || seen.has(children[0]!.head.ref)) return;
    chain.push(children[0]!);
    branch = children[0]!.head.ref;
    seen.add(branch);
  }
  if (chain.length < 2 || !chain.some(pr => pr.state === "open")) return;
  for (const pr of chain) {
    if (pr.head.ref === trunk || tracked.has(pr.head.ref) || !localRefs.some(([name]) => name === pr.head.ref)) return;
  }
  // Registration is linear: any other active child makes the display a branching graph only.
  for (const pr of chain) if (pullRequests.filter(other => other.state === "open" && other.base.ref === pr.head.ref).length > (pr === chain.at(-1) ? 0 : 1)) return;
  const candidatePulls = chain.map(pr => ({ branch: pr.head.ref, ...pullRequest(pr) }));
  return {
    trunk,
    branches: chain.map(pr => pr.head.ref),
    pullRequests: candidatePulls,
    fingerprint: createHash("sha256").update(JSON.stringify({ destination, base, chain, localRefs, current: current.value.name })).digest("hex"),
  };
}

function graphFromView(view: StackView): StackGraph | undefined {
  if (view.currentBranch === view.trunk) return;
  let parent = view.trunk;
  return {
    trunk: view.trunk,
    currentBranch: view.currentBranch,
    explicit: true,
    branches: view.branches.map(branch => {
      const result: StackGraphBranch = { name: branch.name, parent, relation: "local", isCurrent: branch.isCurrent, availability: "local", ...(branch.pr ? { pr: branch.pr } : {}) };
      parent = branch.name;
      return result;
    }),
  };
}

export async function stackStatus(scope: string, github: Gh = gh): Promise<StackStatus> {
  const status: StackStatus = { available: false, conflicts: [], rebasing: false };
  let actionProblem: string | undefined;
  try { await github(scope, ["stack", "--help"]); status.available = true; }
  catch { actionProblem = "Install GitHub CLI, then run gh extension install github/gh-stack on the Session Host to manage this stack. Viewing does not require the extension. Run gh auth login if needed."; }

  try {
    status.conflicts = (await git(scope, ["diff", "--name-only", "--diff-filter=U", "-z"])).split("\0").filter(Boolean);
    const path = (await git(scope, ["rev-parse", "--git-path", "gh-stack-rebase-state"])).trim();
    status.rebasing = await access(resolve(scope, path)).then(() => true, () => false);
  } catch (error) {
    status.problem = message(error);
    status.problemKind = "discovery";
  }

  const warnings: string[] = [];
  if (status.available) {
    try { status.view = parseStack(await github(scope, ["stack", "view", "--json"])); }
    catch (error) {
      if (!/current branch .+ (?:is not|not) (?:a )?part of (?:a |any )?stack/i.test(message(error))) addWarning(warnings, `Managed stack details could not be read: ${message(error)}`);
    }
    if (status.view) {
      await Promise.all(status.view.branches.map(async ({ pr }) => {
        if (!pr) return;
        try {
          const details = JSON.parse(await github(scope, ["pr", "view", pr.url || String(pr.number), "--json", "title,url"]));
          if (typeof details.title !== "string" || typeof details.url !== "string") throw new Error("GitHub returned invalid pull request details.");
          pr.title = details.title;
          pr.url = details.url;
        } catch (error) { addWarning(warnings, `PR #${pr.number} details could not be loaded: ${message(error)}`); }
      }));
    }
  }

  try {
    const discovery = await discoverStackGraph(scope, github);
    if (discovery.graph) status.graph = discovery.graph;
    for (const warning of discovery.warnings) addWarning(warnings, warning);
  } catch (error) { addWarning(warnings, `Stack discovery failed: ${message(error)}`); }
  if (!status.graph && status.view) {
    const fallback = graphFromView(status.view);
    if (fallback) status.graph = fallback;
  }
  if (status.graph && status.view) {
    const managed = new Map(status.view.branches.map(branch => [branch.name, branch]));
    for (const branch of status.graph.branches) {
      const pr = managed.get(branch.name)?.pr;
      if (pr) branch.pr = pr;
    }
  }

  if (!status.view && !status.rebasing) {
    try {
      const candidate = await discoverStack(scope, github);
      if (candidate) status.candidate = candidate;
    }
    catch (error) {
      // Broad discovery may still have produced a useful graph. Candidate failure only removes Init.
      if (status.graph) addWarning(warnings, `This graph is read-only because registration eligibility could not be verified: ${message(error)}`);
    }
  }
  if (warnings.length) status.warnings = warnings;

  const hasDisplay = Boolean(status.graph || (status.view && status.view.currentBranch !== status.view.trunk) || status.candidate || status.rebasing);
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
      const pages = JSON.parse(await github(scope, ["api", "--paginate", "--slurp", "repos/{owner}/{repo}/stacks?per_page=100"])) as { id: number; pull_requests: { number: number; head: { ref: string } }[] }[][];
      if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) throw new Error("Cannot verify remote stack membership.");
      const remote = pages.flat().find(s => String(s.id) === stack.id);
      membership = remote ?? null;
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
    const state = await stackStatus(scope, github);
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
      const state = await stackStatus(scope, github);
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
