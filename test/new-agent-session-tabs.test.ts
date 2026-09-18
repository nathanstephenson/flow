import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { describe, it } from "node:test";
import { transformSync } from "esbuild";

type Element = { type: unknown; props: Record<string, any> };

const require = createRequire(import.meta.url);

function compile(file: URL, replacements: (name: string) => unknown): Record<string, any> {
  const exports: Record<string, any> = {};
  const module = { exports };
  const code = transformSync(readFileSync(file, "utf8"), {
    loader: "tsx",
    format: "cjs",
    jsx: "automatic",
  }).code;
  runInNewContext(code, {
    module,
    exports,
    require: (name: string) => name === "react/jsx-runtime" ? require(name) : replacements(name),
  });
  return module.exports;
}

function find(element: any, type: unknown, matches: (candidate: Element) => boolean = () => true): Element {
  if (element?.type === type && matches(element)) return element;
  for (const child of [element?.props?.children].flat(Infinity)) {
    if (!child || typeof child !== "object") continue;
    try {
      return find(child, type, matches);
    } catch {}
  }
  throw new Error(`Missing ${String(type)}`);
}

describe("the reusable Tabs", () => {
  const primitives = { Root: "TabsRoot", List: "TabsList", Tab: "TabsTab", Panel: "TabsPanel" };
  const tabs = compile(
    new URL("../web/src/components/ui/tabs.tsx", import.meta.url),
    (name) => {
      if (name === "@base-ui/react/tabs") return { Tabs: primitives };
      if (name === "@/lib/utils") {
        return { cn: (...values: Array<string | undefined>) => values.filter(Boolean).join(" ") };
      }
      throw new Error(`Unexpected import ${name}`);
    },
  );

  it("delegates roving focus and arrow-key selection to Base UI's automatic activation", () => {
    assert.equal(tabs.Tabs, primitives.Root);
    const list = tabs.TabsList({ "aria-label": "Modes" });
    assert.equal(list.type, primitives.List);
    assert.equal(list.props.activateOnFocus, true);
    assert.equal(list.props["aria-label"], "Modes");
  });

  it("keeps selection, hover, and keyboard focus visually distinct", () => {
    const trigger = tabs.TabsTrigger({ value: "chat", children: "Chat" });
    assert.equal(trigger.type, primitives.Tab);
    assert.match(trigger.props.className, /data-active:bg-background/);
    assert.match(trigger.props.className, /data-active:ring-1/);
    assert.match(trigger.props.className, /hover:bg-background\/60/);
    assert.match(trigger.props.className, /data-active:hover:bg-background/);
    assert.match(trigger.props.className, /focus-visible:ring-3/);

    const panel = tabs.TabsContent({ value: "chat", children: "Content" });
    assert.equal(panel.type, primitives.Panel);
    assert.match(panel.props.className, /\[\[hidden\]\]:hidden/);
  });
});

describe("New Agent Session tabs integration", () => {
  const states: any[] = [];
  let hook = 0;
  const effects: Array<() => void> = [];
  const react = {
    useState(initial: any) {
      const slot = hook++;
      if (!(slot in states)) states[slot] = typeof initial === "function" ? initial() : initial;
      return [states[slot], (value: any) => {
        states[slot] = typeof value === "function" ? value(states[slot]) : value;
      }];
    },
    useEffect(effect: () => void) { effects.push(effect); },
    useMemo(factory: () => any) { return factory(); },
    useCallback(callback: (...args: any[]) => any) { return callback; },
    useRef(value: any) { return { current: value }; },
  };
  const ui = new Proxy({}, { get: (_target, key) => String(key) });
  const project = { path: "/project", name: "Project" };
  const config = {
    backends: ["claude"],
    git: false,
    mcp: [],
    projectCandidates: [],
    projectList: [project],
  };
  const page = compile(
    new URL("../web/src/components/new-agent-session-page.tsx", import.meta.url),
    (name) => {
      if (name === "react") return react;
      if (name.endsWith("/protocol/settings.ts")) {
        return { resolveDefaultBackend: (backends: string[]) => backends[0] };
      }
      if (name === "@/agent-sessions.tsx") return { useCommand: () => async () => undefined };
      if (name === "@/branches.ts") return { useBranches: () => ({ load() {}, list: { repository: false } }) };
      if (name === "@/drafts.ts") return { NEW_AGENT_SESSION_DRAFT: "new", DraftStash: undefined };
      if (name === "@/host.tsx") return { useHost: () => ({ config, refresh: () => Promise.resolve() }) };
      if (name === "@/models.ts") return { useModelCatalogue: () => ({ catalogue: undefined }) };
      if (name === "@/skills.ts") return { useScopeSkills: () => async () => [] };
      if (name === "@/presentation/default-model.ts") return { preselectedModel: () => undefined };
      if (name === "@/presentation/new-agent-session.ts") {
        return {
          createCommandFor: () => ({ type: "create" }),
          eligibleWorkflows: () => [],
          validatedWorkflowInput: () => ({}),
          validatedWorkflowInputSchema: () => ({}),
        };
      }
      if (name === "@/presentation/projects.ts") return { groupProjects: () => [] };
      if (name === "@/presentation/workflows.ts") return { workflowIssue: String };
      if (name === "@/workflow-launch.ts") return { retainWorkflowLaunch() {} };
      if (name === "@/components/workflow-api.ts") {
        return {
          workflowApi: async () => ({}),
          useWorkflowResource: () => ({ data: { workflows: [] } }),
        };
      }
      if (name === "@/components/workflow-editors.tsx") return { initialValue: () => ({}), ValueEditor: "ValueEditor" };
      if (name === "@/lib/quiet-trigger.ts") return { QUIET_TRIGGER: "quiet" };
      if (name === "@/lib/utils.ts") return { cn: (...values: string[]) => values.filter(Boolean).join(" ") };
      if (name.startsWith("@/components/")) return ui;
      return {};
    },
  );
  const drafts = { scope: () => project.path, setScope() {}, write() {} };
  const render = () => {
    hook = 0;
    return page.NewAgentSessionPage({ drafts, onCreated() {} });
  };

  it("defaults to Chat and keeps the controlled mode synchronized with both panels", () => {
    const initial = render();
    const initialRoot = find(initial, "Tabs");
    assert.equal(initialRoot.props.value, "chat");
    assert.equal(find(initial, "TabsTrigger", (tab) => tab.props.value === "chat").props.children, "chat");
    assert.ok(find(initial, "TabsContent", (panel) => panel.props.value === "chat"));
    assert.ok(find(initial, "TabsContent", (panel) => panel.props.value === "workflow"));
    assert.ok(find(initial, "Composer"));

    initialRoot.props.onValueChange("workflow");
    const workflow = render();
    assert.equal(find(workflow, "Tabs").props.value, "workflow");
    assert.equal(find(workflow, "TabsContent", (panel) => panel.props.value === "workflow").props.keepMounted, true);
    assert.ok(find(workflow, "h2", (heading) => heading.props.children === "Start with a workflow"));

    find(workflow, "Tabs").props.onValueChange("invalid");
    assert.equal(find(render(), "Tabs").props.value, "workflow");
  });
});
