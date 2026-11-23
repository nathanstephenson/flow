import { useState } from "react";
import { compactTokens, money } from "@client/context-usage.ts";
import type { SpendSource, SpendSummary, SpendTotal, SpendWindowName } from "../../../src/protocol/spend.ts";
import { SPEND_WINDOWS } from "../../../src/protocol/spend.ts";
import { SettingsGroup } from "./settings-parts.tsx";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs.tsx";
import { useWorkflowResource } from "./workflow-api.ts";

const WINDOW_LABELS: Record<SpendWindowName, string> = {
  day: "24 hours", week: "7 days", month: "30 days", lifetime: "Lifetime",
};

const SOURCE_LABELS: Record<SpendSource, string> = {
  session: "Agent Sessions", workflow: "Workflow Executions", naming: "Naming",
  publish: "Commit and Pull Request text", builder: "Workflow Builder",
};

export function SpendPage() {
  const { data, error } = useWorkflowResource<SpendSummary>("/api/spend", 30_000);
  const [name, setName] = useState<SpendWindowName>("day");
  const selected = data?.[name];
  return (
    <main className="min-h-0 overflow-y-auto p-4 pt-12 sm:p-8" aria-label="Spend">
      <div className="mx-auto grid max-w-3xl gap-6">
        <h1 className="text-2xl font-semibold">Spend</h1>
        <Tabs value={name} onValueChange={(value) => setName(value as SpendWindowName)}>
          <TabsList aria-label="Time window" className="flex w-full">
            {SPEND_WINDOWS.map((item) => (
              <TabsTrigger key={item} value={item} className="h-8 min-w-0 flex-1">{WINDOW_LABELS[item]}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {error && <p role="alert" className="text-destructive">{error}</p>}
        {selected && (
          <>
            <Rows rows={[{ label: "Total", total: selected }]} />
            <SettingsGroup title="By model">
              <Rows rows={selected.models.map((model) => ({ label: model.id, total: model, mono: true }))} />
            </SettingsGroup>
            <SettingsGroup title="By source">
              <Rows rows={selected.sources.map((source) => ({ label: SOURCE_LABELS[source.source], total: source }))} />
            </SettingsGroup>
          </>
        )}
      </div>
    </main>
  );
}

function Rows({ rows }: { rows: { label: string; total: SpendTotal; mono?: boolean }[] }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">Nothing was spent in this window.</p>;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_5rem_6rem_5rem] gap-x-4 gap-y-1 text-sm">
      <span className="text-muted-foreground">Name</span>
      <span className="text-right text-muted-foreground">Tokens</span>
      <span className="text-right text-muted-foreground">Cache reads</span>
      <span className="text-right text-muted-foreground">Cost</span>
      {rows.map(({ label, total, mono }) => (
        <span key={label} className="contents">
          <span className={mono ? "truncate font-mono text-xs leading-5" : "truncate"}>{label}</span>
          <span className="text-right tabular-nums">{compactTokens(total.tokens)}</span>
          <span className="text-right tabular-nums">{compactTokens(total.cached)}</span>
          <span className="text-right tabular-nums">{total.costUSD === 0 && total.tokens > 0 ? "—" : money(total.costUSD)}</span>
        </span>
      ))}
    </div>
  );
}
