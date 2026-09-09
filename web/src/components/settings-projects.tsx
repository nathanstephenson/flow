import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";

import type { DirectoryMatches, Project } from "../../../src/protocol/projects.ts";
import { useHost } from "@/host.tsx";
import { searchKind, worthSearching } from "@/presentation/directory-search.ts";
import { groupProjects, includeEntryFor } from "@/presentation/projects.ts";
import { SaveRow, SettingsGroup, useSaveSettings } from "@/components/settings-parts.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";

/**
 * Projects: where to look for them, which ones you have opted into, and how to add another.
 *
 * The list is the feature. `projects.include` is what a client offers, so this page is the only
 * place it can be built — and the reason it is built here rather than being inferred is that a root
 * full of repositories is mostly repositories you are not working on today (ADR 0011).
 *
 * Three ways in, in descending order of how often they are the right one: the candidates the
 * Session Host already found, a search for a directory it would never offer, and the Project Root
 * field that decides what either of those can see.
 */
export function ProjectsSettings() {
  const { config, refresh } = useHost();
  const { save, saving } = useSaveSettings();

  const included = config.projectList ?? [];
  const candidates = config.projectCandidates ?? [];
  const configuredRoot = config.projects?.root ?? "";
  const include = config.projects?.include ?? [];

  /**
   * Write a new list and re-ask.
   *
   * `include` replaces rather than merges (src/protocol/settings.ts), so every add and remove sends
   * the whole list. The re-ask is not optional: the paths are the Setting, but the Projects they
   * resolve to are derived, so the PUT can only report the former.
   */
  const writeInclude = useCallback(
    (next: string[], announced: string): void => {
      void (async () => {
        if (!(await save({ projects: { include: next } }, announced))) return;
        await refresh();
      })();
    },
    [save, refresh],
  );

  const add = (path: string): void => {
    // Written relative to the Project Root where possible, so config.json stays legible by hand.
    // `config.scope` is the expanded root whenever one is configured (src/daemon/server.ts), which
    // is what these absolute paths have to be compared against.
    const entry = includeEntryFor(path, config.projects?.root === undefined ? undefined : config.scope);
    if (include.includes(entry)) return;
    writeInclude([...include, entry], "Project added.");
  };

  return (
    <>
      <IncludedProjects
        included={included}
        onRemove={(index) =>
          writeInclude(include.filter((_, at) => at !== index), "Project removed.")
        }
      />
      <Candidates candidates={candidates} hasRoot={config.projects?.root !== undefined} onAdd={add} />
      <DirectorySearch onAdd={add} />
      <ProjectRootField current={configuredRoot} saving={saving} onSave={save} onSaved={refresh} />
    </>
  );
}

/** The opted-in list, in configured order, with the stale ones marked rather than hidden. */
function IncludedProjects({
  included,
  onRemove,
}: {
  included: Project[];
  onRemove: (index: number) => void;
}) {
  return (
    <SettingsGroup
      title={`Projects · ${included.length}`}
      description={
        included.length === 0
          ? "Nothing yet. A Project is one you have opted into — add one below, and it becomes an option in the New Agent Session dialog."
          : "What the New Agent Session dialog offers, in this order."
      }
    >
      {included.length === 0 ? null : (
        <div className="flex flex-col">
          {included.map((project, index) => (
            <div
              key={project.path}
              className="flex items-baseline justify-between gap-3 border-b py-1.5 last:border-b-0"
            >
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="font-mono text-xs">
                  {project.group === undefined ? project.name : `${project.group}/${project.name}`}
                </span>
                {project.missing ? (
                  // Marked, not dropped: a curated entry that vanished should look different from
                  // one that never saved.
                  <span className="text-xs text-destructive">directory is gone</span>
                ) : null}
              </span>
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                  {project.path}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${project.name}`}
                  onClick={() => onRemove(index)}
                >
                  <X aria-hidden />
                </Button>
              </span>
            </div>
          ))}
        </div>
      )}
    </SettingsGroup>
  );
}

/** The repositories the Session Host found and you have not opted into. One click each. */
function Candidates({
  candidates,
  hasRoot,
  onAdd,
}: {
  candidates: Project[];
  hasRoot: boolean;
  onAdd: (path: string) => void;
}) {
  if (!hasRoot) return null;

  return (
    <SettingsGroup
      title={`Found beneath the Project Root · ${candidates.length}`}
      description="Repositories Flow can see but is not offering. Add the ones you work in."
    >
      {candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing left to add. Either everything found is already a Project, or the Project Root
          holds no git repositories within three levels.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {groupProjects(candidates).map((group) => (
            <div key={group.group ?? ""} className="flex flex-col gap-1">
              {group.group === undefined ? null : (
                <span className="text-xs font-medium text-muted-foreground">{group.group}</span>
              )}
              <div className="flex flex-wrap gap-1">
                {group.items.map((project) => (
                  <Button
                    key={project.path}
                    variant="outline"
                    size="sm"
                    className="font-mono text-xs font-normal"
                    onClick={() => onAdd(project.path)}
                  >
                    <Plus aria-hidden />
                    {project.name}
                  </Button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </SettingsGroup>
  );
}

/**
 * Adding a directory the Session Host would never suggest.
 *
 * A plain field with results beneath it rather than a Combobox, because the two are not the same
 * control: a Combobox picks from a list it was given, and this list arrives from the server per
 * keystroke and is never the whole set. It is also the escape hatch for a Project outside the
 * Project Root, which a list of candidates cannot be.
 *
 * Which of the two searches runs is decided by the first character — see `searchKind`. The label
 * says which, so "why is it not finding my repo" has an answer on screen.
 */
function DirectorySearch({ onAdd }: { onAdd: (path: string) => void }) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<DirectoryMatches | undefined>(undefined);
  // Which query the displayed answer belongs to, so a slow reply cannot overwrite a newer one.
  const latest = useRef("");

  useEffect(() => {
    latest.current = query;
    if (!worthSearching(query)) {
      setMatches(undefined);
      return;
    }
    const abort = new AbortController();
    // Debounced: this walks a filesystem, and a keystroke is not a reason to do it twice.
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/directories?q=${encodeURIComponent(query)}`, {
            credentials: "same-origin",
            signal: abort.signal,
          });
          if (!response.ok) return;
          const answer = (await response.json()) as DirectoryMatches;
          // The host echoes the query back precisely so this check can be exact rather than
          // a guess about ordering.
          if (answer.query === latest.current) setMatches(answer);
        } catch {
          // An aborted or failed search is not worth a toast. The field simply shows nothing.
        }
      })();
    }, 150);

    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [query]);

  const kind = searchKind(query);

  return (
    <SettingsGroup
      title="Add any directory"
      description={
        <>
          Type a name to search beneath the Project Root — repositories included, so{" "}
          <code className="font-mono text-xs">packages/api</code> inside a monorepo is reachable.
          Start with <code className="font-mono text-xs">/</code> or{" "}
          <code className="font-mono text-xs">~</code> to complete a path anywhere on this machine
          instead.
        </>
      }
    >
      <Input
        className="font-mono"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="api, or /home/you/elsewhere"
        spellCheck={false}
      />

      {matches === undefined ? null : matches.paths.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {kind === "completion" ? "No directory there." : "Nothing beneath the Project Root matches."}
        </p>
      ) : (
        <div className="flex flex-col">
          <span className="pb-1 text-xs text-muted-foreground">
            {kind === "completion" ? "Directories here" : "Found beneath the Project Root"}
            {matches.truncated ? " — showing the first few, keep typing" : null}
          </span>
          {matches.paths.map((path) => (
            <div
              key={path}
              className="flex items-center justify-between gap-3 border-b py-1 last:border-b-0"
            >
              <span className="min-w-0 truncate font-mono text-xs">{path}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  onAdd(path);
                  setQuery("");
                }}
              >
                <Plus aria-hidden />
                Add
              </Button>
            </div>
          ))}
        </div>
      )}
    </SettingsGroup>
  );
}

/**
 * The Project Root.
 *
 * Last on the page rather than first, which is deliberate: it is set once and then rarely touched,
 * whereas the list above it is the thing anyone came here to change. It governs what the candidates
 * and the name search can see, and nothing else — clearing it does not clear the Projects, because
 * an absolute entry does not need it.
 */
function ProjectRootField({
  current,
  saving,
  onSave,
  onSaved,
}: {
  current: string;
  saving: boolean;
  onSave: ReturnType<typeof useSaveSettings>["save"];
  onSaved: () => Promise<void>;
}) {
  const [root, setRoot] = useState(current);

  // A save elsewhere, or a reload, is the source of truth — not what is half-typed here.
  useEffect(() => setRoot(current), [current]);

  const commit = (): void => {
    void (async () => {
      const announced = root.trim() === "" ? "Project Root cleared." : "Project Root saved.";
      if (!(await onSave({ projects: { root: root.trim() } }, announced))) return;
      await onSaved();
    })();
  };

  return (
    <SettingsGroup
      title="Project Root"
      description={
        <>
          The directory Flow looks beneath for candidates, and the one it reports as its
          default Scope. Absolute, or starting with{" "}
          <code className="font-mono text-xs">~</code>. A Project outside it can still be added by
          path.
        </>
      }
    >
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Where your repositories live</span>
        <Input
          className="font-mono"
          value={root}
          onChange={(event) => setRoot(event.target.value)}
          placeholder="~/workspace"
          spellCheck={false}
        />
      </label>

      <SaveRow
        dirty={root.trim() !== current}
        saving={saving}
        onSave={commit}
        onReset={() => setRoot(current)}
      />
    </SettingsGroup>
  );
}
