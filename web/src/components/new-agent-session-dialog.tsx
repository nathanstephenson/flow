import { useEffect, useRef, useState } from "react";

import type { Project } from "../../../src/protocol/projects.ts";
import { useCommand } from "@/agent-sessions.tsx";
import { useBranches } from "@/branches.ts";
import { useHost } from "@/host.tsx";
import { useSettled } from "@/settled.ts";
import { groupProjects, type ProjectGroup } from "@/presentation/projects.ts";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.tsx";

/**
 * Starting an Agent Session: a Project, a Scope and a backend.
 *
 * The Scope is the value that is sent, and it is the only one — a Project is a *candidate* Scope
 * (CONTEXT.md), so choosing one writes its path into the field below rather than travelling
 * separately. That is why the picker's own value is derived from the field and not stored beside it:
 * two controls, one string, and no way for them to disagree.
 *
 * **The dialog offers nothing by default when Projects exist.** It used to prefill the host's
 * default Scope and put the cursor on Start, which made `n` then Enter start an Agent Session in
 * whatever directory the daemon happened to be launched from. Now `n` opens with the picker focused,
 * so the same gesture is `n`, a few letters, Enter, Enter — and it lands somewhere chosen. Where the
 * host offers no Projects the old behaviour is kept exactly, because there is nothing to choose from
 * and an empty field would be a worse dialog than the one it replaced.
 *
 * The Projects offered are the **opted-in** ones, not everything the host can see (ADR 0011). That
 * makes "no Projects" the state every installation starts in even with a Project Root set, which is
 * why the note about candidates below exists: without it, the way to turn the picker on would be
 * discoverable only by reading the Settings page on a hunch.
 *
 * **A model still cannot be offered here.** `create` accepts a `modelId`, but `Capabilities` arrive
 * on `session_started` *per Agent Session* — so at this moment the list of models does not exist
 * yet. The model picker in the pane header is the first honest moment to choose.
 */
export function NewAgentSessionDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (sessionId: string) => void;
}) {
  const { config, refresh } = useHost();
  const run = useCommand();
  const projects = config.projectList ?? [];
  const offersProjects = projects.length > 0;
  // Repositories the host found but nobody has opted into. Only interesting when there are no
  // Projects at all — once the picker is on screen, the place to add more is the Settings page.
  const uncurated = offersProjects ? 0 : (config.projectCandidates ?? []).length;

  const [scope, setScope] = useState("");
  const [backend, setBackend] = useState(config.backends[0] ?? "");
  const [creating, setCreating] = useState(false);
  const [inWorktree, setInWorktree] = useState(false);
  const [cutFrom, setCutFrom] = useState("");
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const create = useRef<HTMLButtonElement | null>(null);
  const projectField = useRef<HTMLLabelElement | null>(null);

  /*
   * Reopening offers the host's defaults again rather than whatever was typed and abandoned.
   *
   * Keyed on `open` alone, deliberately. The config is also read here, but listing it as a
   * dependency would make the refresh below reset a Scope its reader is halfway through typing —
   * this is a reaction to the dialog opening, not a subscription to the config.
   */
  useEffect(() => {
    if (!open) return;
    setScope(offersProjects ? "" : config.scope);
    setBackend(config.backends[0] ?? "");
    setInWorktree(false);
    setCutFrom("");
    setFailure(undefined);
    // Ask again on the way in, so a repository cloned since the page loaded is in the list. The
    // Session Host walks uncached precisely so that this is worth doing.
    void refresh();
  }, [open]);

  /*
   * Whether the Scope in the field is a repository, and what could be cut from it.
   *
   * Asked rather than known, because the Scope field is free text: a Project picked from the
   * dropdown might not be a repository (opting in removed that requirement — ADR 0011), and a
   * hand-typed path inside a monorepo might be. Debounced because this fires as someone types a
   * path, which is the same reason `/api/directories` is a query.
   */
  const settled = useSettled(scope.trim(), 250);
  const branches = useBranches(settled);
  useEffect(() => {
    if (config.git !== false) branches.load();
  }, [settled]);

  const repository = branches.list?.repository === true;
  const head = branches.list?.head;
  // Absent until the answer arrives, so the base branch defaults to wherever the repository is now.
  const base = cutFrom || (head?.detached ? "" : head?.name) || "";

  // Derived, not stored: the Project whose path the field currently holds, or none once it has been
  // hand-edited to somewhere else.
  const selected = projects.find((project) => project.path === scope.trim()) ?? null;
  const groups = groupProjects(projects);

  const submit = async (): Promise<void> => {
    if (creating || scope.trim() === "" || backend === "") return;
    setCreating(true);
    // `create` resolves to the new Agent Session's id as a bare string (SessionHost.create), not to
    // an object wrapping it.
    setFailure(undefined);
    const created = await run<string>({
      type: "create",
      scope: scope.trim(),
      backend,
      // Only when the control was on screen *and* on: a stale toggle from a Scope that has since
      // been typed over must not cut a worktree nobody asked for.
      ...(inWorktree && repository && base !== "" ? { worktree: { from: base } } : {}),
    });
    setCreating(false);
    if (created === undefined) {
      // A create refused by git — a base branch that has gone, a directory in the way — is the one
      // failure here worth saying out loud, because the dialog stays open and can be corrected.
      setFailure("The Session Host refused this. Check the branch to cut from.");
      return;
    }
    onOpenChange(false);
    onCreated(created);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        /*
         * Whichever control is the first real decision: the Project picker when there is a choice
         * to make, and Start when there is not.
         *
         * The picker is found by querying its field rather than by holding a ref to it. A ref would
         * have to reach the button through `ComboboxTrigger`'s `render` prop, and Base UI needs its
         * own ref on that same element to anchor the popup to it — so the safe thing is to not put
         * one there at all. Falls back to Start if the query finds nothing.
         */
        initialFocus={() =>
          (offersProjects ? projectField.current?.querySelector("button") : null) ?? create.current
        }
      >
        <DialogHeader>
          <DialogTitle>New Agent Session</DialogTitle>
          <DialogDescription>
            It is bound to this Scope for its whole life, and the backend cannot be changed
            afterwards.
          </DialogDescription>
        </DialogHeader>

        {/* No `mt-*`: upstream's content is a grid with `gap-6`, so margins here would double up. */}
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
                 *
                 * No ref here either. It would have to reach the button through `render`, and
                 * whether Base UI's own ref survives that is exactly the kind of thing the anchor
                 * depends on — so focus is found by querying the field instead (`initialFocus`).
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
            * and here it also keeps the dialog from implying that a `notes` Project is broken.
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

          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium">Backend</span>
            <Select
              value={backend}
              onValueChange={(value) => {
                if (typeof value === "string") setBackend(value);
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
        </div>

        {failure ? <p className="text-xs text-destructive">{failure}</p> : null}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            ref={create}
            size="sm"
            disabled={creating || scope.trim() === "" || backend === ""}
            onClick={() => void submit()}
          >
            {creating ? "starting…" : "Start"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** `work/api` — the group is part of the name here, because two Projects may share a basename. */
function projectLabel(project: Project): string {
  return project.group === undefined ? project.name : `${project.group}/${project.name}`;
}
