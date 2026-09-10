import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { IncomingAttachment } from "../../../src/protocol/attachments.ts";
import type { Capabilities, EffortLevel } from "../../../src/protocol/events.ts";
import type { Project } from "../../../src/protocol/projects.ts";
import { useCommand } from "@/agent-sessions.tsx";
import { useBranches } from "@/branches.ts";
import type { ComposerActions } from "@/composer-actions.ts";
import { NEW_AGENT_SESSION_DRAFT, type DraftStash } from "@/drafts.ts";
import { useHost } from "@/host.tsx";
import { useModelCatalogue } from "@/models.ts";
import { useScopeSkills } from "@/skills.ts";
import { preselectedModel } from "@/presentation/default-model.ts";
import { createCommandFor } from "@/presentation/new-agent-session.ts";
import { groupProjects, type ProjectGroup } from "@/presentation/projects.ts";
import { Composer } from "@/components/composer.tsx";
import type { Chrome } from "@/store/contract.ts";
import { Button } from "@/components/ui/button.tsx";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
} from "@/components/ui/combobox.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.tsx";
import { QUIET_TRIGGER } from "@/lib/quiet-trigger.ts";
import { cn } from "@/lib/utils.ts";

/**
 * Starting an Agent Session: a first message, and the three facts that decide where it runs.
 *
 * A page rather than a dialog, and the composer is why. This is the app's most consequential
 * action — an Agent Session is bound to its Scope and its Backend Adapter for life — and what a
 * reader came here to do is type the first message. A modal had nowhere to put one.
 *
 * It is also the empty state. `formatRoute` already gives `""` for the Agent Session route naming
 * none, so the clean URL *is* this view and it needs no `Route` member of its own. "Nothing is
 * focused" and "you are starting one" were two names for one moment, and the old empty state's copy
 * said as much: it told you to press `n`.
 *
 * ## The composer is the real one
 *
 * Not a box that looks like it — `Composer` itself, handed a `Chrome` describing the session that
 * does not exist yet and a `ComposerActions` where sending means *create, then send*. Everything in
 * its bottom strip then arrives for free and correctly: the model picker filled from the chosen
 * Backend Adapter, the Effort picker, and the branch picker. The panels that belong to a turn cost
 * nothing here because each already hides itself when it has nothing — `ContextUsageMeter` returns
 * null without a token count, the Subagent strip returns null, and the Enquiry and Permission panels
 * collapse to a zero-height row.
 *
 * That is worth more than the duplication it saves: a control added to the composer later shows up
 * here too, rather than being something somebody has to remember to add twice.
 *
 * ## What survives leaving this page
 *
 * The message, in the Draft stash under its own key, and the Project. The Backend Adapter, the
 * model, the worktree toggle and the branch are seeded fresh every time.
 *
 * That rule is *where the state lives* rather than an effect that undoes things — which is what the
 * dialog needed, being mounted for the app's whole life. This view unmounts the moment an Agent
 * Session is focused, so arriving is always a fresh mount and the seeds below are the whole of it.
 */
export function NewAgentSessionPage({
  drafts,
  onCreated,
}: {
  drafts: DraftStash;
  onCreated: (sessionId: string) => void;
}) {
  const { config, refresh } = useHost();
  const run = useCommand();
  const projects = config.projectList ?? [];
  const uncurated = (config.projectCandidates ?? []).length;

  /*
   * The Scope is a Project's path and nothing else.
   *
   * There used to be a free-text field beside the picker, and it was the wrong shape: it offered a
   * path as something to type when every path worth starting in is already a Project (ADR 0011), and
   * two controls over one string meant the picker's own value had to be *derived* from the field to
   * stop them disagreeing. One control, one value.
   *
   * A host with no Projects opted into offers nothing to choose, so the view says so and points at
   * the Settings rather than falling back to the Project Root — starting an Agent Session somewhere
   * nobody chose is how the old dialog's prefilled Scope used to bite.
   */
  const [projectPath, setProjectPath] = useState<string | undefined>(() => drafts.scope());
  const project = projects.find((candidate) => candidate.path === projectPath);
  const scope = project?.path;

  // Not held: the host's defaults, every time.
  const [backend, setBackend] = useState(config.backends[0] ?? "");
  const [chosenModel, setChosenModel] = useState<string | undefined>(undefined);
  const [effort, setEffort] = useState<EffortLevel | undefined>(undefined);
  const [inWorktree, setInWorktree] = useState(false);
  const [cutFrom, setCutFrom] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const projectField = useRef<HTMLLabelElement | null>(null);

  /*
   * Ask again on the way in, so a repository cloned since the page loaded is in the list. The
   * Session Host walks uncached precisely so that this is worth doing. On mount only: a reaction to
   * arriving, not a subscription to the config.
   */
  useEffect(() => {
    void refresh();
  }, []);

  /*
   * What the Scope is, and what it offers — asked, because a Project need not be a repository
   * (ADR 0011) and its Skills are read off disk.
   *
   * No debounce any more, and that is the quiet win from dropping the free-text field: the Scope now
   * changes when somebody picks from a list rather than on every keystroke of a path, so there is
   * nothing to settle and `useSettled` is gone from this view.
   */
  const branches = useBranches(scope);
  useEffect(() => {
    if (config.git !== false) branches.load();
  }, [scope]);
  const listSkills = useScopeSkills(scope, backend);

  const repository = branches.list?.repository === true;
  const head = branches.list?.head;
  const checkedOut = head?.detached ? undefined : head?.name;
  /** The base a worktree would be cut from: the chosen one, else wherever the repository is now. */
  const base = cutFrom ?? checkedOut ?? "";

  const { catalogue: models } = useModelCatalogue();
  const backendModels = models?.find((entry) => entry.backend === backend);
  const model =
    backendModels?.models.find((candidate) => candidate.id === chosenModel) ??
    preselectedModel(models, config.providers?.defaults, backend);

  const command = createCommandFor({
    scope: scope ?? "",
    backend,
    modelId: model?.id,
    effort,
    inWorktree,
    repository,
    base,
  });

  /*
   * The branch the picker shows, and it means two different things.
   *
   * With the worktree toggle **off** it is the Scope's checkout, and choosing moves it — a real
   * `git switch` in a directory other Agent Sessions may be bound to, which is why the hint below
   * the toggle says so out loud. With it **on** nothing is moved: the choice is the base the new
   * worktree will be cut from, and the Scope's own checkout is left where it is.
   *
   * One control for both because it is one question — which branch does this session start from —
   * and the toggle above it is what changes the answer's consequence rather than its meaning.
   */
  const shownBranch = inWorktree
    ? base === ""
      ? undefined
      : { name: base }
    : head;

  const chrome = useMemo<Chrome>(
    () => ({
      /*
       * Idle, which is what unlocks the composer: `occupied` would show Abort in place of Send, and
       * `ended` would disable the box outright. Nothing here is a lie about a session that exists —
       * this Chrome describes the one about to.
       */
      status: "idle",
      backend,
      scope,
      // `models` is all the picker reads of this; the booleans gate controls that need a turn, so
      // they are false rather than guessed — and `compaction: false` is what keeps `/compact` out of
      // the Skill menu, correctly, since there is no Conversation Context to compact yet.
      capabilities: backendModels
        ? ({
            providers: [],
            models: backendModels.models,
            compaction: false,
            fork: false,
            subagents: false,
            enquiries: false,
            permissions: false,
          } satisfies Capabilities)
        : undefined,
      model,
      effort,
      branch: shownBranch,
      worktree: undefined,
      contextUsage: undefined,
      endedReason: undefined,
      queueDepth: 0,
      activeSubagents: 0,
      activeBackgroundCalls: 0,
      asking: undefined,
      authorising: undefined,
      compacting: false,
      spoken: false,
      link: "live",
    }),
    [backend, backendModels, effort, model, scope, shownBranch],
  );

  /**
   * Create the Agent Session, then send the first message to it.
   *
   * Two commands, because `create` carries no message and `send` needs somewhere to carry one to.
   * Neither is optimistic: the session appears in the rail because the host made it and the poll
   * noticed, as everywhere else (ADR 0001).
   */
  const send = useCallback(
    async (text: string, attachments: IncomingAttachment[]): Promise<unknown | undefined> => {
      if (command === undefined) return undefined;
      setFailure(undefined);

      const created = await run<string>(command);
      if (created === undefined) {
        // A create refused by git — a base branch that has gone, a directory in the way — is the one
        // failure worth saying out loud here, because the page stays put and can be corrected.
        setFailure("The Session Host refused this. Check the branch to cut from.");
        return undefined;
      }

      const queued =
        text === "" && attachments.length === 0
          ? true
          : await run<{ queued?: boolean }>({
              type: "send",
              sessionId: created,
              text,
              ...(attachments.length > 0 ? { attachments } : {}),
              // Always `after_turn` — see the Composer for why `now` is not what a plain send means.
              when: "after_turn",
            });

      /*
       * A create that took and a send that did not.
       *
       * The Agent Session exists, so staying here would strand one nobody can reach. Focus it, and
       * report the refusal upward so the Composer puts the words back in *its* box — which is the
       * one the reader is about to be looking at.
       */
      drafts.write(NEW_AGENT_SESSION_DRAFT, { text: "", attachments: [] });
      onCreated(created);
      return queued;
    },
    [command, drafts, onCreated, run],
  );

  const actions = useMemo<ComposerActions>(
    () => ({
      send,
      setModel: setChosenModel,
      setEffort,
      /*
       * Either a real checkout or a choice of base, depending on the toggle — see `shownBranch`.
       * The worktree case answers true without asking the host anything, because nothing has
       * happened yet: the base travels on `create` when Start is pressed.
       */
      switchBranch: async (branch: string) => {
        if (inWorktree) {
          setCutFrom(branch);
          return true;
        }
        if (scope === undefined) return false;
        const moved = await run({ type: "switch_scope_branch", scope, branch });
        if (moved !== undefined) branches.load();
        return moved !== undefined;
      },
      listSkills,
      // No `compact`, `abort`, `answerEnquiry` or `answerPermission`: all four need a turn, and
      // there is no session to hold one. See web/src/composer-actions.ts.
    }),
    [branches, inWorktree, listSkills, run, scope, send],
  );

  // The first real decision, focused on arrival: the Project when none is chosen, the message
  // otherwise — which is the common case, because the Project comes back with the Draft.
  useEffect(() => {
    if (scope === undefined) projectField.current?.querySelector("button")?.focus();
    else document.querySelector<HTMLElement>("[data-new-session] [data-composer-input]")?.focus();
  }, []);

  // Remember the Project on the way out. The message is the Composer's own to stash.
  useEffect(
    () => () => {
      if (projectPath !== undefined) drafts.setScope(projectPath);
    },
    [drafts, projectPath],
  );

  const groups = groupProjects(projects);

  return (
    // The child owns its scroller: `SidebarInset` hands it one `minmax(0,1fr)` row, the contract
    // `SettingsPage` renders under. Deliberately no `data-pane` — that is how `focus-pane` and ⌘F
    // find a transcript, and there is none here. `data-new-session` is this view's own handle.
    <div data-new-session="" className="transcript-scroller min-h-0 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-6 py-12">
        <h1 className="text-center text-lg font-medium">New Agent Session</h1>

        {projects.length === 0 ? (
          <NoProjects uncurated={uncurated} />
        ) : (
          <>
            {/*
              * The two bindings an Agent Session can never change, on one quiet row above the
              * message: which Backend Adapter runs it and which Project it runs in. Compact and
              * centred because in the common case nobody touches either — the host's first backend
              * and the Project you were last in are almost always the answer — so they read as a
              * caption over the box rather than as a form to fill in.
              *
              * The prose that used to sit under the title said the same thing in a sentence nobody
              * needed twice; the controls are the better place for it, and what is irreversible is
              * legible from the fact that these two are the only things above the composer.
              */}
            <div className="flex items-center justify-center gap-2">
              <Select
                value={backend}
                onValueChange={(value) => {
                  if (typeof value !== "string") return;
                  setBackend(value);
                  // The chosen model belonged to the old backend's list. Cleared rather than
                  // remapped: `preselectedModel` picks the new backend's default next render.
                  setChosenModel(undefined);
                  setEffort(undefined);
                }}
              >
                <SelectTrigger aria-label="Backend" size="sm" className={cn(QUIET_TRIGGER, "w-auto")}>
                  <SelectValue>{() => backend}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {config.backends.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <label ref={projectField} className="flex">
                <Combobox
                  items={groups}
                  value={project ?? null}
                  isItemEqualToValue={(left: Project, right: Project) => left.path === right.path}
                  // The label carries the group, so typing "work" narrows to that folder and the two
                  // repositories both called `api` are told apart in the trigger.
                  itemToStringLabel={projectLabel}
                  itemToStringValue={(candidate: Project) => candidate.path}
                  onValueChange={(value) => {
                    const picked = value as Project | null;
                    if (!picked) return;
                    setProjectPath(picked.path);
                    // The old Project's answers do not describe the new one.
                    setCutFrom(undefined);
                    setInWorktree(false);
                  }}
                >
                  {/*
                   * The one and only Trigger in this subtree, which is load-bearing: Base UI anchors
                   * the popup to a single trigger element, so a second one steals the anchor. See the
                   * `showTrigger={false}` below.
                   */}
                  <ComboboxTrigger
                    aria-label="Project"
                    render={<Button variant="ghost" size="sm" className={cn(QUIET_TRIGGER, "w-auto")} />}
                  >
                    <ComboboxValue>
                      {(picked: Project | null) =>
                        picked === null ? (
                          <span className="text-muted-foreground">Choose a Project</span>
                        ) : (
                          <span className="font-mono text-xs">{projectLabel(picked)}</span>
                        )
                      }
                    </ComboboxValue>
                  </ComboboxTrigger>
                  <ComboboxContent>
                    {/*
                     * `showTrigger={false}` is not cosmetic. Left at its default, ComboboxInput
                     * renders `render={<ComboboxTrigger />}` inside the popup — a *second* Trigger,
                     * which mounts later than the real one and so becomes what Base UI anchors to.
                     * The popup then measures a 28px icon button inside itself, `--anchor-width`
                     * collapses, and it lands in the corner of the viewport at that width.
                     */}
                    <ComboboxInput
                      showTrigger={false}
                      placeholder={`Filter ${projects.length} ${projects.length === 1 ? "Project" : "Projects"}`}
                    />
                    <ComboboxList>
                      {(group: ProjectGroup) => (
                        <ComboboxGroup key={group.group ?? ""} items={group.items}>
                          {/*
                           * The Projects sitting directly in the Project Root get no heading. Naming
                           * that group "Root" or "Other" would invent a folder its reader never made.
                           */}
                          {group.group === undefined ? null : (
                            <ComboboxLabel>{group.group}</ComboboxLabel>
                          )}
                          <ComboboxCollection>
                            {(candidate: Project) => (
                              <ComboboxItem key={candidate.path} value={candidate}>
                                <span className="font-mono text-xs">{candidate.name}</span>
                              </ComboboxItem>
                            )}
                          </ComboboxCollection>
                        </ComboboxGroup>
                      )}
                    </ComboboxList>
                    <ComboboxEmpty>No Project matches.</ComboboxEmpty>
                  </ComboboxContent>
                </Combobox>
              </label>
            </div>

            <Composer
              id={NEW_AGENT_SESSION_DRAFT}
              chrome={chrome}
              actions={actions}
              // In flow rather than pinned to a bottom edge: there is no transcript to hang over.
              floating={false}
              // The only state here in which nothing could be created at all.
              unavailable={backend === "" ? "This Session Host advertises no backend" : undefined}
              placeholder="What should it work on? Enter starts the Agent Session."
              drafts={drafts}
              authorisingSummary={undefined}
              // Nothing can be delegating yet, so the strip that offers this never renders.
              onShowSubagents={() => {}}
            />

            {repository && config.git !== false ? (
              <div className="flex flex-col gap-1">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={inWorktree}
                    onChange={(event) => setInWorktree(event.target.checked)}
                  />
                  <span className="text-sm font-medium">Start in a new worktree</span>
                </label>
                <span className="text-xs text-muted-foreground">
                  {inWorktree ? (
                    <>
                      The branch above is what it will be cut from; a name is chosen for you. The
                      worktree is kept by the Session Host and removed when this Agent Session is
                      reaped, but only if nothing is uncommitted.
                    </>
                  ) : (
                    <>
                      This Agent Session shares {project?.name ?? "the Project"}&rsquo;s checkout, so
                      choosing a branch above moves it — for anything else already working there
                      too. A worktree gives this one its own.
                    </>
                  )}
                </span>
              </div>
            ) : null}

            {failure ? <p className="text-xs text-destructive">{failure}</p> : null}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * A host with nothing to start an Agent Session in.
 *
 * The state every installation begins in even with a Project Root set, because Projects are opted
 * into rather than found (ADR 0011) — so this has to say where to opt in, or the way to turn the
 * picker on would be discoverable only by reading the Settings on a hunch.
 */
function NoProjects({ uncurated }: { uncurated: number }) {
  return (
    <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
      No Projects yet.{" "}
      {uncurated > 0 ? (
        <>
          {uncurated} {uncurated === 1 ? "repository was" : "repositories were"} found beneath the
          Project Root — opt in under Settings → Projects to start an Agent Session in one.
        </>
      ) : (
        <>Add one under Settings → Projects to start an Agent Session in it.</>
      )}
    </p>
  );
}

/** `work/api` — the group is part of the name here, because two Projects may share a basename. */
function projectLabel(project: Project): string {
  return project.group === undefined ? project.name : `${project.group}/${project.name}`;
}
