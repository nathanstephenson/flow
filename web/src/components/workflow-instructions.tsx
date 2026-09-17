import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ScopeSkills, Skill } from "../../../src/protocol/events.ts";
import { leadingSkillInvocation } from "../../../src/protocol/skills.ts";
import {
  completed,
  matching,
  menuQuery,
  triggerables,
  type Triggerable,
} from "../presentation/composer-menu.ts";
import { highlightAfter } from "../presentation/composer-keys.ts";
import {
  ComposerInput,
  type ComposerInputHandle,
} from "./composer-input.tsx";
import {
  INERT_ENQUIRY_KEYS,
  INERT_PERMISSION_KEYS,
} from "./composer-extensions.ts";
import { ComposerMenu } from "./composer-menu.tsx";

type Discovery =
  | { key: string; state: "idle" }
  | { key: string; state: "loading" }
  | { key: string; state: "ready"; skills: Skill[] }
  | { key: string; state: "failed"; problem: string };

export function WorkflowInstructions({
  value,
  project,
  backend,
  onChange,
}: {
  value: string;
  project: string | undefined;
  backend: string;
  onChange: (value: string) => void;
}) {
  const key = `${backend}\0${project ?? ""}`;
  const [discovery, setDiscovery] = useState<Discovery>({ key, state: "idle" });
  const [query, setQuery] = useState<string | undefined>(undefined);
  const [highlighted, setHighlighted] = useState(0);
  const input = useRef<ComposerInputHandle | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setHighlighted(0);
    if (!project || !backend) {
      setDiscovery({ key, state: "idle" });
      return () => controller.abort();
    }
    setDiscovery({ key, state: "loading" });
    void (async () => {
      try {
        const response = await fetch(
          `/api/skills?scope=${encodeURIComponent(project)}&backend=${encodeURIComponent(backend)}`,
          { credentials: "same-origin", signal: controller.signal },
        );
        if (!response.ok) throw new Error(`Skill discovery failed (${response.status})`);
        const answer = (await response.json()) as ScopeSkills;
        if (answer.scope !== project || answer.backend !== backend) {
          throw new Error("Skill discovery returned a different Project or Backend Adapter");
        }
        if (answer.problem) throw new Error(answer.problem);
        if (!controller.signal.aborted) setDiscovery({ key, state: "ready", skills: answer.skills });
      } catch (error) {
        if (!controller.signal.aborted) {
          setDiscovery({
            key,
            state: "failed",
            problem: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
    return () => controller.abort();
  }, [backend, key, project]);

  const current = discovery.key === key ? discovery : ({ key, state: "loading" } as const);
  const catalogue = useMemo<Triggerable[]>(
    () =>
      current.state === "ready"
        ? triggerables(false, current.skills)
        : [],
    [current],
  );
  const items = useMemo(
    () => (query === undefined ? [] : matching(catalogue, query)),
    [catalogue, query],
  );
  const choose = useCallback(
    (item: Triggerable): void => {
      const filled = completed(value, item.name);
      onChange(filled.text);
      setQuery(undefined);
      input.current?.replace(filled.text, filled.caret);
      input.current?.focus();
    },
    [onChange, value],
  );
  const menuKeys = useMemo(() => {
    const pick = (): boolean => {
      const selected = items[highlighted];
      if (!selected) return false;
      choose(selected);
      return true;
    };
    return {
      active: query !== undefined,
      move: (delta: number) =>
        setHighlighted((at) => highlightAfter(at, delta, items.length)),
      complete: pick,
      submit: pick,
      dismiss: () => setQuery(undefined),
    };
  }, [choose, highlighted, items, query]);
  const invocation = leadingSkillInvocation(value);
  const missing =
    invocation &&
    query === undefined &&
    current.state === "ready" &&
    !current.skills.some((skill) => skill.name === invocation.name)
      ? `Skill /${invocation.name} is not available in this Project checkout. Execution will fail unless it exists in the execution Scope.`
      : "";
  const emptyLabel =
    !project
      ? "Choose a Project to use Skills"
      : current.state === "failed"
        ? `Could not load Skills: ${current.problem}`
        : query && catalogue.length > 0
          ? `No Skills match “${query}”`
          : "No Skills for this Project and Backend Adapter";

  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium">Instructions</span>
      <div className="workflow-instructions overflow-hidden rounded-lg border bg-card focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30">
        <ComposerMenu
          open={query !== undefined}
          items={items}
          loading={current.state === "loading"}
          highlighted={highlighted}
          onChoose={choose}
          onHighlight={setHighlighted}
          label="Skills"
          emptyLabel={emptyLabel}
        />
        <div className="flex min-h-44 items-stretch">
          <ComposerInput
            value={value}
            ariaLabel="Instructions"
            placeholder="Describe the step, or type / to invoke a Skill…"
            disabled={false}
            catalogue={catalogue}
            menu={menuKeys}
            enquiry={INERT_ENQUIRY_KEYS}
            permission={INERT_PERMISSION_KEYS}
            handle={input}
            onChange={(text, caret) => {
              onChange(text);
              setQuery(menuQuery(text, caret));
              setHighlighted(0);
            }}
            onPasteFiles={() => false}
            className="w-full"
          />
        </div>
      </div>
      <p
        className={`text-xs ${missing ? "text-destructive" : "text-muted-foreground"}`}
        role={missing ? "alert" : "status"}
      >
        {missing ||
          (current.state === "failed"
            ? `Skill discovery failed: ${current.problem}`
            : project
              ? "Skills are previewed from this Project and resolved fresh in the execution Scope on every attempt."
              : "Bind this Workflow to a Project before adding a leading Skill invocation.")}
      </p>
    </div>
  );
}
