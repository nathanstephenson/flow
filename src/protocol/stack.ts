export type StackPullRequest = { number: number; url?: string; title?: string; state: string };

/** The gh-stack view used to authorize mutating actions. Never populate this from broad discovery. */
export type StackView = {
  trunk: string;
  currentBranch: string;
  branches: { name: string; isCurrent: boolean; isMerged: boolean; isQueued: boolean; needsRebase: boolean; pr?: StackPullRequest }[];
};

export type StackRelationshipSource = "native" | "local" | "pull-request" | "ancestry";
export type StackGraphBranch = {
  name: string;
  /** The trunk is a parent but is not itself repeated in branches. */
  parent?: string;
  relation?: StackRelationshipSource;
  isCurrent: boolean;
  availability: "local" | "remote";
  pr?: StackPullRequest;
};

/** Read-only display data. A graph is intentionally not evidence that gh-stack actions are safe. */
export type StackGraph = {
  trunk?: string;
  currentBranch: string;
  branches: StackGraphBranch[];
  explicit: boolean;
};

export type StackCandidate = { trunk: string; branches: string[]; pullRequests: { branch: string; number: number; state: string; title?: string; url?: string }[]; fingerprint: string };
export type StackStatus = {
  /** Whether the gh-stack extension is available for actions. */
  available: boolean;
  /** Strict, local, linear candidate used only by gh stack init. */
  candidate?: StackCandidate;
  /** Strict gh-stack output used only by existing managed-stack actions. */
  view?: StackView;
  /** Broad, read-only graph used for display. */
  graph?: StackGraph;
  problem?: string;
  /** Action notices do not make an otherwise empty Stack tab visible. */
  problemKind?: "action" | "discovery";
  warnings?: string[];
  conflicts: string[];
  rebasing: boolean;
};
export type StackAction = "init" | "add" | "checkout" | "rebase" | "continue" | "abort" | "submit" | "sync";
export type StackReview = { token: string; action: "submit" | "sync"; view: StackView };
export type StackInput = { action: StackAction; branches?: string[]; fingerprint?: string; token?: string };

/** Normalize display data in the daemon. Never mutates its inputs. */
export function stackDisplayGraph(status: Pick<StackStatus, "graph" | "view" | "candidate">): StackGraph | undefined {
  const { graph, view, candidate } = status;
  let display: StackGraph | undefined = graph ? { ...graph, branches: graph.branches.map(branch => ({ ...branch, ...(branch.pr ? { pr: { ...branch.pr } } : {}) })) } : undefined;
  if (!display && view && view.currentBranch !== view.trunk) {
    let parent = view.trunk;
    display = { trunk: view.trunk, currentBranch: view.currentBranch, explicit: true, branches: view.branches.map(member => {
      const branch: StackGraphBranch = { name: member.name, parent, relation: "local", isCurrent: member.isCurrent, availability: "local", ...(member.pr ? { pr: { ...member.pr, state: member.isMerged ? "MERGED" : member.pr.state } } : {}) };
      parent = member.name;
      return branch;
    }) };
  }
  if (!display && candidate) display = { trunk: candidate.trunk, currentBranch: candidate.branches.at(-1) ?? "", explicit: false, branches: [] };
  if (!display) return;
  const byName = new Map(display.branches.map(branch => [branch.name, branch]));
  let parent = view?.trunk;
  for (const member of view?.branches ?? []) {
    const pr = member.pr ? { ...member.pr, state: member.isMerged ? "MERGED" : member.pr.state } : undefined;
    const branch: StackGraphBranch = byName.get(member.name) ?? { name: member.name, ...(parent ? { parent } : {}), relation: "local", isCurrent: member.isCurrent, availability: "local" };
    Object.assign(branch, { isCurrent: member.isCurrent, ...(pr ? { pr } : {}) });
    if (!byName.has(member.name)) { display.branches.push(branch); byName.set(member.name, branch); }
    parent = member.name;
  }
  parent = candidate?.trunk;
  for (const pr of candidate?.pullRequests ?? []) {
    const name = pr.branch;
    const branch: StackGraphBranch = byName.get(name) ?? { name, ...(parent ? { parent } : {}), relation: "pull-request", isCurrent: name === display.currentBranch, availability: "local" };
    branch.pr = { ...pr };
    if (!byName.has(name)) { display.branches.push(branch); byName.set(name, branch); }
    parent = name;
  }
  return display;
}
