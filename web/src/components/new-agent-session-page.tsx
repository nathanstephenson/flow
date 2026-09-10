import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Project } from "../../../src/protocol/projects.ts";
import { useCommand } from "@/agent-sessions.tsx";
import { attachPasted } from "@/attachments.ts";
import { useBranches } from "@/branches.ts";
import { NEW_AGENT_SESSION_DRAFT, type DraftStash } from "@/drafts.ts";
import { useHost } from "@/host.tsx";
import { useModelCatalogue } from "@/models.ts";
import { useScopeSkills } from "@/skills.ts";
import { useSettled } from "@/settled.ts";
import { preselectedModel } from "@/presentation/default-model.ts";
import { outgoing, type Draft, type PendingAttachment } from "@/presentation/drafts.ts";
import { createCommandFor } from "@/presentation/new-agent-session.ts";
import { groupProjects, type ProjectGroup } from "@/presentation/projects.ts";
import { completed, matching, menuQuery, triggerables } from "@/presentation/composer-menu.ts";
import { AttachmentTray } from "@/components/attachment-tray.tsx";
import { ComposerInput, type ComposerInputHandle } from "@/components/composer-input.tsx";
import { ComposerMenu } from "@/components/composer-menu.tsx";
import {
  INERT_ENQUIRY_KEYS,
  INERT_PERMISSION_KEYS,
} from "@/components/composer-extensions.ts";
import { ModelPicker } from "@/components/model-picker.tsx";
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
import { Input } from "@/components/ui/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.tsx";
import { toast } from "@/components/ui/toaster.tsx";
import { cn } from "@/lib/utils.ts";

/**
 * Starting an Agent Session: a first message, and the four facts that decide where it runs.
 *
 * A page rather than a dialog, and the composer is why. This is the app's most consequential
 * action — an Agent Session is bound to its Scope and its Backend Adapter for life — and what a
 * reader actually came to do is type the first message. A modal had nowhere to put one, so the
 * message was typed *after* creating the session, on a screen that then had to explain itself.
 *
 * It is also the empty state. `formatRoute` already gives `""` for the Agent Session route naming
 * none (web/src/presentation/route.ts), so the clean URL *is* this view and it needs no `Route`
 * member of its own. "Nothing is focused" and "you are starting one" were two names for the same
 * moment, and the old empty state's copy said as much: it told you to press `n`.
 *
 * **A model is offered here, which the dialog this replaces deliberately refused.** That refusal was
 * right when it was made and its premise is gone: a model id was only knowable from a live Backend
 * Session, and `GET /api/models` (ADR 0020) now answers without one. The reason to *want* it is the
 * paste guard. `acceptsImages` is a fact about a `ModelInfo` (ADR 0014), and that ADR is explicit
 * that a composer must treat an unknown model as one that cannot be shown an image — so a page
 * offering Attachments without a chosen model would either guess or refuse every paste. Choosing
 * makes the answer exact. Effort is still not offered: it belongs to the next turn rather than to the
 * session, and the turn strip is where a reader first sees the session they are choosing for.
 *
 * ## What survives leaving this page, and what does not
 *
 * The message and the Scope are held in the Draft stash and come back; the Backend Adapter, the
 * model, the worktree toggle and the branch are seeded from the host's defaults every time.
 *
 * That rule is *where the state lives* rather than an effect that undoes things — which is what the
 * dialog needed, because a dialog is mounted for the app's whole life and had to be reset on open.
 * This view is unmounted the moment an Agent Session is focused, so arriving is always a fresh
 * mount, and the seeds below are the whole of the specification.
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
  const offersProjects = projects.length > 0;
  // Repositories the host found but nobody has opted into. Only interesting when there are no
  // Projects at all — once the picker is on screen, the place to add more is the Settings page.
  const uncurated = offersProjects ? 0 : (config.projectCandidates ?? []).length;

  // Held: read once, and written back on the way out. See the header.
  const seed = useRef(drafts.read(NEW_AGENT_SESSION_DRAFT)).current;
  const [text, setText] = useState(seed.text);
  const [attachments, setAttachments] = useState<PendingAttachment[]>(seed.attachments);
  const [scope, setScope] = useState(
    () => drafts.scope() ?? (offersProjects ? "" : config.scope),
  );

  // Not held: the host's defaults, every time.
  const [backend, setBackend] = useState(config.backends[0] ?? "");
  const [chosenModel, setChosenModel] = useState<string | undefined>(undefined);
  const [inWorktree, setInWorktree] = useState(false);
  const [cutFrom, setCutFrom] = useState("");

  // Never held: a menu that was open, a request in flight, and a refusal already read are not
  // things to come back to.
  const [query, setQuery] = useState<string | undefined>(undefined);
  const [highlighted, setHighlighted] = useState(0);
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const input = useRef<ComposerInputHandle | null>(null);
  const projectField = useRef<HTMLLabelElement | null>(null);

  /*
   * Ask again on the way in, so a repository cloned since the page loaded is in the list. The
   * Session Host walks uncached precisely so that this is worth doing. On mount only — this is a
   * reaction to arriving, not a subscription to the config, and re-running it would reset a Scope
   * somebody is halfway through typing.
   */
  useEffect(() => {
    void refresh();
  }, []);

  /*
   * Whether the Scope in the field is a repository, what could be cut from it, and which Skills it
   * offers.
   *
   * All three asked rather than known, because the Scope field is free text: a Project picked from
   * the dropdown might not be a repository (opting in removed that requirement — ADR 0011), and a
   * hand-typed path inside a monorepo might be. Debounced because this fires as someone types a
   * path.
   *
   * The Skills are fetched here rather than when the menu opens, which is the opposite of what the
   * Composer in an Agent Session does. Asking costs a Backend Session — about nine seconds for
   * Claude — so the wait is spent while somebody is still choosing a backend and typing, instead of
   * in front of them with a menu open and empty. See web/src/skills.ts.
   */
  const settled = useSettled(scope.trim(), 250);
  const branches = useBranches(settled);
  useEffect(() => {
    if (config.git !== false) branches.load();
  }, [settled]);
  const catalogueSkills = useScopeSkills(settled, backend);

  const repository = branches.list?.repository === true;
  const head = branches.list?.head;
  // Absent until the answer arrives, so the base branch defaults to wherever the repository is now.
  const base = cutFrom || (head?.detached ? "" : head?.name) || "";

  const { catalogue } = useModelCatalogue();
  const backendModels = catalogue?.find((entry) => entry.backend === backend);
  const preselected = preselectedModel(catalogue, config.providers?.defaults, backend);
  /*
   * The chosen model, else the preselected one. Derived rather than pushed into state by an effect:
   * the catalogue arrives after the first render and the backend can change under it, and an effect
   * that wrote the default into `chosenModel` would fight a reader who picked one first.
   */
  const model =
    backendModels?.models.find((candidate) => candidate.id === chosenModel) ?? preselected;

  /*
   * The composer is inert until there is a model, and says which.
   *
   * In practice this is only the moment before `/api/models` answers, or a backend that could not
   * answer at all — `preselectedModel` falls back to the backend's first model rather than requiring
   * anybody to have configured a Default Model. The Draft is still seeded and still written back
   * while it is inert, so text typed against a backend that then stalls is not lost.
   */
  const blocked =
    backend === "" ? "Choose a Backend Adapter first" : model === undefined ? whyNoModel(backendModels?.problem) : undefined;

  const command = createCommandFor({
    scope,
    backend,
    modelId: model?.id,
    inWorktree,
    repository,
    base,
  });

  // Derived, not stored: the Project whose path the field currently holds, or none once it has been
  // hand-edited to somewhere else.
  const selected = projects.find((project) => project.path === scope.trim()) ?? null;
  const groups = groupProjects(projects);

  /*
   * Hand the unsent message and the Scope to the stash on the way out, and do *not* revoke the
   * Attachments' object URLs — the Draft outlives this component on purpose. Reads refs and depends
   * on nothing, so it cannot write a stale copy over a fresher one. See web/src/drafts.ts.
   */
  const latest = useRef<Draft & { scope: string }>({ ...seed, scope });
  useEffect(() => {
    latest.current = { text, attachments, scope };
  }, [text, attachments, scope]);
  useEffect(
    () => () => {
      drafts.write(NEW_AGENT_SESSION_DRAFT, latest.current);
      drafts.setScope(latest.current.scope);
    },
    [drafts],
  );

  /*
   * No compaction, deliberately: a Command occupies an Agent Session and there is no Conversation
   * Context to compact yet, so `/compact` is correctly absent from the menu — and the submit path
   * below needs no Command branch as a result.
   */
  const triggerable = useMemo(
    () => triggerables(undefined, catalogueSkills.skills ?? []),
    [catalogueSkills.skills],
  );
  const items = useMemo(
    () => (query === undefined ? [] : matching(triggerable, query)),
    [triggerable, query],
  );
  const menuOpen = query !== undefined;

  const forget = useCallback((pending: PendingAttachment[]): void => {
    for (const attachment of pending) URL.revokeObjectURL(attachment.url);
  }, []);

  const remove = useCallback(
    (key: string): void => {
      setAttachments((current) => {
        forget(current.filter((attachment) => attachment.key === key));
        return current.filter((attachment) => attachment.key !== key);
      });
    },
    [forget],
  );

  /*
   * The paste policy, which is the one place this view and the Composer disagree.
   *
   * The Composer treats an unknown model as one that cannot be shown an image (ADR 0014) because it
   * cannot always name the model in force. Here the model is chosen, so the check is exact — and the
   * composer is inert until it resolves, which is what makes an unguarded paste unreachable rather
   * than merely unlikely.
   */
  const paste = useCallback(
    (files: File[]): boolean => {
      if (model?.acceptsImages !== true) {
        toast.info("This model cannot be shown an image", model?.label ?? model?.id);
        return true;
      }
      void attachPasted(files, attachments.length).then((accepted) => {
        if (accepted.length > 0) setAttachments((current) => [...current, ...accepted]);
      });
      return true;
    },
    [attachments.length, model],
  );

  /**
   * Create the Agent Session, then send the first message to it.
   *
   * Two commands rather than one, because `create` carries no message and `send` needs a session to
   * carry one to. The create is not optimistic in either direction: the session appears in the rail
   * because the host made it and the poll noticed, exactly as everywhere else.
   */
  const start = useCallback(
    async (override?: string): Promise<void> => {
      if (command === undefined || creating) return;
      const message = (override ?? text).trim();

      setCreating(true);
      setFailure(undefined);
      const created = await run<string>(command);
      setCreating(false);
      if (created === undefined) {
        // A create refused by git — a base branch that has gone, a directory in the way — is the one
        // failure here worth saying out loud, because the page stays put and can be corrected.
        setFailure("The Session Host refused this. Check the branch to cut from.");
        return;
      }

      if (message !== "" || attachments.length > 0) {
        const sent = attachments;
        const queued = await run<{ queued?: boolean }>({
          type: "send",
          sessionId: created,
          text: message,
          ...(sent.length > 0 ? { attachments: sent.map(outgoing) } : {}),
          // Always `after_turn`, for the reason the Composer states: it already means "queue if a
          // turn is in flight, else dispatch now", and `now` is a real interrupt rather than what a
          // plain send means.
          when: "after_turn",
        });
        /*
         * A create that took and a send that did not.
         *
         * The Agent Session exists, so staying here would strand one nobody can reach. Focus it, and
         * hand the message to *its* Draft rather than leaving it in this view's — the reader lands in
         * front of the session with their words in the box and Enter still to press.
         */
        if (queued === undefined) drafts.write(created, { text: message, attachments: sent });
        else forget(sent);
      }

      /*
       * Cleared in the ref as well as in state, and the ref is the half that matters.
       *
       * `onCreated` changes the route, so this component unmounts in the same commit as these two
       * `set`s — which means the effect that maintains `latest` never runs, and the unmount write
       * below would hand the stash the message that was just sent. Coming back to this view would
       * then show it again, as though nothing had been started. Writing the ref directly is what
       * makes the clear survive its own unmount, and is the reason `latest` is a ref rather than
       * something derived during render.
       *
       * The Scope is deliberately kept: starting one Agent Session in a Project is a good reason to
       * think somebody will start another.
       */
      setText("");
      setAttachments([]);
      latest.current = { text: "", attachments: [], scope };
      onCreated(created);
    },
    [attachments, command, creating, drafts, forget, onCreated, run, scope, text],
  );

  /** Put the highlighted name in the box — Tab completes it, Enter takes it as the whole message. */
  const choose = useCallback(
    (item: (typeof triggerable)[number], andSend = false): void => {
      const filled = completed(text, item.name);
      setQuery(undefined);
      if (andSend) {
        void start(filled.text);
        return;
      }
      setText(filled.text);
      input.current?.replace(filled.text, filled.caret);
      input.current?.focus();
    },
    [start, text],
  );

  const onChange = useCallback((next: string, caret: number): void => {
    setText(next);
    setQuery(menuQuery(next, caret));
    setHighlighted(0);
  }, []);

  const menuKeys = useMemo(() => {
    const pick = (andSend: boolean) => (): boolean => {
      const picked = items[highlighted];
      if (!picked) return false;
      choose(picked, andSend);
      return true;
    };
    return {
      active: menuOpen,
      move: (delta: number) =>
        setHighlighted((current) =>
          items.length === 0 ? 0 : (current + delta + items.length) % items.length,
        ),
      complete: pick(false),
      submit: pick(true),
      dismiss: () => setQuery(undefined),
    };
  }, [choose, highlighted, items, menuOpen]);

  /*
   * Whichever control is the first real decision: the Project picker when there is a Scope to choose
   * and none chosen, and the message box otherwise — which is now the common case, because the Scope
   * comes back with the Draft.
   *
   * The picker is found by querying its field rather than by holding a ref, for the reason the dialog
   * gave: a ref would have to reach the button through `ComboboxTrigger`'s `render` prop, and Base UI
   * needs its own ref on that element to anchor the popup to it.
   */
  useEffect(() => {
    if (offersProjects && scope.trim() === "") {
      projectField.current?.querySelector("button")?.focus();
      return;
    }
    input.current?.focus();
  }, []);

  return (
    // The child owns its scroller: `SidebarInset` hands it one `minmax(0,1fr)` row, the same
    // contract `SettingsPage` renders under. Deliberately no `data-pane` — that attribute is how
    // `focus-pane` and ⌘F find a transcript, and there is no transcript here to find.
    <div className="transcript-scroller min-h-0 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-6 py-10">
        <header className="flex flex-col gap-1">
          <h1 className="text-lg font-medium">New Agent Session</h1>
          <p className="text-sm text-muted-foreground">
            It is bound to this Scope for its whole life, and the backend cannot be changed
            afterwards.
          </p>
        </header>

        {/* The message first, because it is what somebody came here to write. */}
        <div className="rounded-xl border bg-card shadow-sm">
          <ComposerMenu
            open={menuOpen}
            items={items}
            loading={catalogueSkills.skills === undefined}
            highlighted={highlighted}
            onChoose={choose}
            onHighlight={setHighlighted}
          />

          {attachments.length === 0 ? null : (
            <AttachmentTray attachments={attachments} onRemove={remove} />
          )}

          <div className="flex items-center gap-1">
            <ComposerInput
              value={text}
              placeholder={blocked ?? "What should it work on? Enter starts the Agent Session."}
              disabled={blocked !== undefined}
              catalogue={triggerable}
              menu={menuKeys}
              // Nothing before an Agent Session exists can be asked a Question or an authorisation.
              enquiry={INERT_ENQUIRY_KEYS}
              permission={INERT_PERMISSION_KEYS}
              handle={input}
              onChange={onChange}
              onSubmit={() => void start()}
              onPasteFiles={paste}
            />
            <div className="flex shrink-0 items-center pr-2">
              <Button
                size="sm"
                disabled={creating || command === undefined}
                onClick={() => void start()}
              >
                {creating ? "starting…" : "Start"}
              </Button>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          {offersProjects ? (
            <label ref={projectField} className="flex flex-col gap-1">
              <span className="text-sm font-medium">Project</span>
              <Combobox
                items={groups}
                value={selected}
                isItemEqualToValue={(left: Project, right: Project) => left.path === right.path}
                // The label carries the group, so typing "work" narrows to that folder and the two
                // repositories both called `api` are told apart in the trigger.
                itemToStringLabel={projectLabel}
                itemToStringValue={(project: Project) => project.path}
                onValueChange={(value) => {
                  const project = value as Project | null;
                  if (project) setScope(project.path);
                }}
              >
                {/*
                 * The one and only Trigger in this subtree, which is load-bearing: Base UI anchors
                 * the popup to a single trigger element, so a second one steals the anchor. See the
                 * `showTrigger={false}` below.
                 */}
                <ComboboxTrigger
                  render={<Button variant="outline" className="w-full justify-between font-normal" />}
                >
                  <ComboboxValue>
                    {(project: Project | null) =>
                      project === null ? (
                        <span className="text-muted-foreground">Choose a Project</span>
                      ) : (
                        <span className="font-mono text-xs">{projectLabel(project)}</span>
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
                   *
                   * It is also the right control to drop on its own merits: a chevron that opens
                   * the dropdown, inside the filter field of a dropdown that is already open.
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
                          {(project: Project) => (
                            <ComboboxItem key={project.path} value={project}>
                              <span className="font-mono text-xs">{project.name}</span>
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
          ) : null}

          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium">Scope</span>
            <Input
              className="font-mono"
              value={scope}
              onChange={(event) => setScope(event.target.value)}
              placeholder="/path/to/the/working/directory"
              spellCheck={false}
            />
            {offersProjects ? (
              <span className="text-xs text-muted-foreground">
                Set by the Project above. Type over it for a directory outside the Project Root —
                inside a monorepo, say.
              </span>
            ) : uncurated > 0 ? (
              <span className="text-xs text-muted-foreground">
                {uncurated} {uncurated === 1 ? "repository" : "repositories"} found beneath the
                Project Root. Opt in under Settings → Projects to pick from them here.
              </span>
            ) : null}
          </label>

          {/*
            * Offered only where it could work: a Scope that is a repository, on a host that has
            * git. Hidden otherwise rather than disabled — the same rule the Effort picker follows,
            * and here it also keeps the page from implying that a `notes` Project is broken.
            */}
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
              {inWorktree ? (
                <>
                  <label className="mt-1 flex flex-col gap-1">
                    <span className="text-xs text-muted-foreground">Cut from</span>
                    <Select
                      value={base === "" ? null : base}
                      onValueChange={(value) => {
                        if (typeof value === "string") setCutFrom(value);
                      }}
                    >
                      <SelectTrigger aria-label="Cut from" className="font-mono">
                        <SelectValue placeholder="branch">{() => base}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {(branches.list?.branches ?? []).map((name) => (
                          <SelectItem key={name} value={name} className="font-mono">
                            {name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  <span className="text-xs text-muted-foreground">
                    A branch is named for you and the worktree is kept by the Session Host. It is
                    removed when this Agent Session is reaped, but only if nothing is uncommitted.
                  </span>
                </>
              ) : (
                <span className="text-xs text-muted-foreground">
                  Two Agent Sessions in one directory fight over the working tree. A worktree gives
                  this one its own.
                </span>
              )}
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">Backend</span>
              <Select
                value={backend}
                onValueChange={(value) => {
                  if (typeof value !== "string") return;
                  setBackend(value);
                  // The chosen model belonged to the old backend's list. Cleared rather than
                  // remapped: `preselectedModel` picks the new backend's default on the next render.
                  setChosenModel(undefined);
                }}
              >
                <SelectTrigger className="w-full">
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
            </label>

            {/* Absent rather than empty while the catalogue is in flight — the composer's
                placeholder is already saying why nothing can be typed yet. */}
            <label className={cn("flex flex-col gap-1", model === undefined && "hidden")}>
              <span className="text-sm font-medium">Model</span>
              <ModelPicker
                models={backendModels?.models}
                model={model}
                onSelect={setChosenModel}
              />
            </label>
          </div>
        </div>

        {failure ? <p className="text-xs text-destructive">{failure}</p> : null}
      </div>
    </div>
  );
}

/** `work/api` — the group is part of the name here, because two Projects may share a basename. */
function projectLabel(project: Project): string {
  return project.group === undefined ? project.name : `${project.group}/${project.name}`;
}

/**
 * Why there is no model to start on.
 *
 * The backend's own words where it gave any — "not logged in" is the whole answer, and paraphrasing
 * it would lose the only thing the reader can act on.
 */
function whyNoModel(problem: string | undefined): string {
  return problem === undefined ? "Looking for models…" : `${problem} — check Settings → Providers`;
}
