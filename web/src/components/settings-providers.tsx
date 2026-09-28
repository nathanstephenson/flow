import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";

import type {
  BackendModels,
  EffortLevel,
} from "../../../src/protocol/events.ts";
import {
  resolveDefaultBackend,
  type Settings,
  type AutoCompaction,
} from "../../../src/protocol/settings.ts";
import { useHost } from "@/host.tsx";
import { useModelCatalogue } from "@/models.ts";
import {
  SaveRow,
  SettingsGroup,
  useSaveSettings,
} from "@/components/settings-parts.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { ConfiguredEffortSelect } from "@/components/effort-select.tsx";

const UNSET = "__unset__";

export function ProvidersSettings() {
  const { config } = useHost();
  const { catalogue, loading, problem, refresh } = useModelCatalogue();
  return (
    <>
      <DefaultBackendSettings
        backends={config.backends}
        current={config.providers?.defaultBackend ?? ""}
      />
      <div className="flex flex-col gap-3">
        {(config.backends ?? []).map((backend) => (
          <BackendSettings
            key={backend}
            backend={backend}
            providers={config.providers}
            isDefault={
              backend ===
              resolveDefaultBackend(
                config.backends,
                config.providers?.defaultBackend,
              )
            }
            listing={catalogue?.find((entry) => entry.backend === backend)}
            loading={loading}
            discoveryProblem={problem}
          />
        ))}
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Button
          size="sm"
          variant="ghost"
          disabled={loading}
          onClick={() => void refresh()}
        >
          {loading ? "Checking models…" : "Check again"}
        </Button>
        <span role={problem ? "alert" : undefined}>
          {problem ?? "Refresh after connecting a Provider. Pi lists only models with authentication configured."}
        </span>
      </div>
    </>
  );
}

function backendLabel(backend: string): string {
  return backend === "pi" ? "Pi" : backend === "claude" ? "Claude" : backend;
}

function DefaultBackendSettings({
  backends,
  current,
}: {
  backends: string[];
  current: string;
}) {
  const { save, saving } = useSaveSettings();
  const [value, setValue] = useState(current);
  useEffect(() => setValue(current), [current]);
  const automatic = resolveDefaultBackend(backends);
  return (
    <SettingsGroup
      title="Default Backend"
      description="Used by web and terminal for new Agent Sessions. An explicit backend choice takes precedence."
    >
      <Select
        value={value || UNSET}
        onValueChange={(next) => {
          if (typeof next === "string") setValue(next === UNSET ? "" : next);
        }}
      >
        <SelectTrigger
          className="w-full sm:max-w-sm"
          aria-label="Default Backend"
        >
          <SelectValue>
            {value
              ? backendLabel(value)
              : `Automatic${automatic ? ` — ${backendLabel(automatic)}` : ""}`}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNSET}>
            Automatic{automatic ? ` — ${backendLabel(automatic)}` : ""}
          </SelectItem>
          {current && !backends.includes(current) ? (
            <SelectItem value={current} disabled>
              {current} (unavailable)
            </SelectItem>
          ) : null}
          {backends.map((backend) => (
            <SelectItem key={backend} value={backend}>
              {backendLabel(backend)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <SaveRow
        dirty={value !== current}
        saving={saving}
        onReset={() => setValue(current)}
        onSave={() =>
          void save(
            { providers: { defaultBackend: value } },
            "Default Backend saved.",
          )
        }
      />
    </SettingsGroup>
  );
}

function BackendSettings({
  backend,
  providers,
  listing,
  loading,
  isDefault,
  discoveryProblem,
}: {
  backend: string;
  providers: Settings["providers"];
  listing: BackendModels | undefined;
  loading: boolean;
  isDefault: boolean;
  discoveryProblem: string | undefined;
}) {
  const { save, saving } = useSaveSettings();
  const legacy = providers?.summary;
  const summary =
    providers?.summaries?.[backend] ??
    (legacy?.backend === backend ? legacy : undefined);
  const currentModel = providers?.defaults?.[backend] ?? "";
  const currentEffort = providers?.efforts?.[backend] ?? "";
  const currentSummary = summary?.modelId ?? "";
  const currentAutomatic = summary?.automatic ?? true;
  const [model, setModel] = useState(currentModel);
  const [effort, setEffort] = useState<EffortLevel | "">(currentEffort);
  const [summaryModel, setSummaryModel] = useState(currentSummary);
  const [automatic, setAutomatic] = useState(currentAutomatic);
  function reset() {
    setModel(currentModel);
    setEffort(currentEffort);
    setSummaryModel(currentSummary);
    setAutomatic(currentAutomatic);
  }
  useEffect(reset, [
    currentModel,
    currentEffort,
    currentSummary,
    currentAutomatic,
  ]);
  const selected = listing?.models.find((entry) => entry.id === model);
  const levels = selected?.effortLevels ?? [];
  const effortProblem = loading
    ? "Checking model Effort support…"
    : discoveryProblem ?? listing?.problem
      ?? (!model ? "Choose a model to confirm its Effort levels." : !selected ? "This model is unavailable; Effort support cannot be confirmed." : undefined);
  const noEffortControl = !!selected && levels.length === 0;
  const invalidEffort = !!effort && (!selected || !levels.includes(effort));
  const dirty =
    model !== currentModel ||
    effort !== currentEffort ||
    summaryModel !== currentSummary ||
    automatic !== currentAutomatic;

  return (
    <details
      name="provider-backends"
      className="group rounded-lg border bg-card"
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 rounded-lg p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">{backendLabel(backend)}</h2>
            {isDefault ? (
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                Default
              </span>
            ) : null}
            {dirty ? (
              <span className="text-xs text-muted-foreground">Unsaved</span>
            ) : null}
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {selected?.label ?? (model || "Backend model default")}
            {effort ? ` · ${effort} effort` : ""}
            {summaryModel ? " · Summary enabled" : " · No summary model"}
          </p>
        </div>
        <ChevronDown
          className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
          aria-hidden
        />
      </summary>
      <div className="flex flex-col gap-4 border-t p-4">
        <p className="text-xs text-muted-foreground">
          Model and effort defaults apply to new Agent Sessions only.
        </p>
        <div className="grid gap-6 md:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-3">
            <ModelField
              label="Default Model"
              backend={backend}
              listing={listing}
              loading={loading}
              value={model}
              placeholder="Use backend default"
              onChange={setModel}
            />
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">Default Effort</span>
              {noEffortControl ? (
                invalidEffort ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm" aria-invalid="true">{effort} (saved — unsupported)</span>
                    <Button size="sm" variant="outline" onClick={() => setEffort("")}>Use backend default</Button>
                  </div>
                ) : null
              ) : (
                <ConfiguredEffortSelect
                  value={effort}
                  levels={levels}
                  ariaLabel={`${backend} Default Effort`}
                  allowUnset
                  disabled={!!effortProblem}
                  onChange={setEffort}
                />
              )}
              <span className={invalidEffort ? "text-xs text-destructive" : "text-xs text-muted-foreground"} role={invalidEffort || effortProblem ? "status" : undefined}>
                {invalidEffort
                  ? noEffortControl
                    ? `Saved Effort “${effort}” is invalid because this model has no Effort control. Use the backend default.`
                    : `Saved Effort “${effort}” is not confirmed for this model. Choose a supported level or use the backend default.`
                  : effortProblem
                    ? effortProblem
                    : noEffortControl
                      ? "This model has no Effort control."
                      : "For the main model only. Explicit session effort takes precedence."}
              </span>
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            <ModelField
              label="Summary Model"
              backend={backend}
              listing={listing}
              loading={loading}
              value={summaryModel}
              placeholder="None — keep the first line"
              onChange={setSummaryModel}
            />
            <p className="text-xs text-muted-foreground">
              Names this backend’s Agent Sessions. Does not inherit Default
              Effort.
            </p>
            {summaryModel ? (
              <label className="flex items-center justify-between gap-4">
                <span className="text-sm">
                  Name new Agent Sessions automatically
                </span>
                <Switch checked={automatic} onCheckedChange={setAutomatic} />
              </label>
            ) : null}
          </div>
        </div>
        <SaveRow
          dirty={dirty}
          saving={saving}
          saveDisabled={invalidEffort}
          onReset={reset}
          onSave={() =>
            void save(
              {
                providers: {
                  defaults: { [backend]: model },
                  efforts: { [backend]: effort },
                  summaries: {
                    [backend]: summaryModel
                      ? { modelId: summaryModel, automatic }
                      : null,
                  },
                },
              },
              `${backend} models saved.`,
            )
          }
        />
        {listing?.autoCompaction ? (
          <AutoCompactionSettings backend={backend} listing={listing} current={providers?.autoCompaction?.[backend]} currentModel={providers?.compactionModels?.[backend] ?? ""} />
        ) : null}
      </div>
    </details>
  );
}

function AutoCompactionSettings({ backend, listing, current, currentModel }: {
  backend: string;
  listing: BackendModels;
  current: AutoCompaction | undefined;
  currentModel: string;
}) {
  const { save, saving } = useSaveSettings();
  const [compactionModel, setCompactionModel] = useState(currentModel);
  const [mode, setMode] = useState<"default" | AutoCompaction["mode"]>(current?.mode ?? "default");
  const [percent, setPercent] = useState(current?.mode === "enabled" ? String(current.targetPercent) : "80");
  const savedMode = current?.mode ?? "default";
  const savedPercent = current?.mode === "enabled" ? String(current.targetPercent) : "80";
  function reset() {
    setMode(savedMode);
    setPercent(savedPercent);
    setCompactionModel(currentModel);
  }
  useEffect(reset, [savedMode, savedPercent, currentModel]);
  const targetPercent = Number(percent);
  const valid = mode !== "enabled" || (percent.trim() !== "" && Number.isInteger(targetPercent) && targetPercent >= 1 && targetPercent <= 99);
  const dirty = mode !== savedMode || (mode === "enabled" && percent !== savedPercent) || (backend === "pi" && compactionModel !== currentModel);
  return (
    <div className="flex flex-col gap-3 border-t pt-4">
      <h3 className="text-sm font-semibold">Compaction</h3>
      <p className="text-xs text-muted-foreground">
        These settings apply to new and Revived Backend Sessions. Saving does not change running Backend Sessions. Manual compaction stays available even when auto-compaction is disabled.
      </p>
      {backend === "pi" ? (
        <>
          <ModelField label="Compaction Model" backend={backend} listing={listing} loading={false}
            value={compactionModel} placeholder="Use current model" onChange={setCompactionModel} />
          <p className="text-xs text-muted-foreground">Used to summarize manual and automatic compactions. Does not change the model for normal turns. Applies to new and Revived Backend Sessions.</p>
        </>
      ) : null}
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Auto-compaction mode</span>
        <Select value={mode} onValueChange={(value) => {
          if (value === "default" || value === "disabled" || value === "enabled") setMode(value);
        }}>
          <SelectTrigger aria-label={`${backend} Auto-compaction mode`}>
            <SelectValue>{mode === "default" ? "Use backend default" : mode === "disabled" ? "Disabled" : "Enabled with target"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">Use backend default</SelectItem>
            <SelectItem value="disabled">Disabled</SelectItem>
            <SelectItem value="enabled">Enabled with target</SelectItem>
          </SelectContent>
        </Select>
      </label>
      {mode === "enabled" ? (
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">Target percentage</span>
          <Input aria-label={`${backend} Auto-compaction target percentage`} type="number" min={1} max={99} step={1} value={percent} onChange={(event) => setPercent(event.target.value)} />
          {!valid ? <span className="text-xs text-destructive">Enter an integer from 1 to 99.</span> : null}
        </label>
      ) : null}
      <p className="text-xs text-muted-foreground">
        The percentage is a target, not a guarantee. {listing.autoCompaction === "startup"
          ? "Claude may compact earlier. Backend restrictions still apply. Model changes in a running Backend Session do not change its startup threshold."
          : "Pi uses each model’s context window to set reserved tokens. This also changes the summary token budget. If the context window is unknown, Pi keeps its SDK defaults. Model changes use the Settings snapshot from when the Backend Session opened."}
      </p>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!dirty || !valid || saving} onClick={() => {
          if (!valid) return;
          const value: AutoCompaction | null = mode === "default" ? null : mode === "disabled" ? { mode } : { mode, targetPercent };
          void save({ providers: { autoCompaction: { [backend]: value }, ...(backend === "pi" ? { compactionModels: { [backend]: compactionModel } } : {}) } }, "Compaction settings saved.");
        }}>{saving ? "Saving…" : "Save"}</Button>
        <Button size="sm" variant="ghost" disabled={!dirty || saving} onClick={reset}>Discard</Button>
      </div>
    </div>
  );
}

function ModelField({
  label,
  backend,
  listing,
  loading,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  backend: string;
  listing: BackendModels | undefined;
  loading: boolean;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const [search, setSearch] = useState("");
  const models = listing?.models ?? [];
  const filtered = models.filter((model) =>
    `${model.provider ?? ""} ${model.label ?? ""} ${model.id}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const selectedModel = models.find((model) => model.id === value);
  const savedMissing = value !== "" && selectedModel === undefined;
  const displayValue = selectedModel
    ? `${selectedModel.provider ? `${selectedModel.provider} / ` : ""}${selectedModel.label ?? selectedModel.id}`
    : value
      ? `${value} (unavailable)`
      : placeholder;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium">{label}</span>
      {backend !== "pi" && !loading && models.length === 0 ? (
        <Input
          aria-label={`${backend} ${label}`}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
      ) : (
        <>
          {models.length > 10 ? (
            <Input
              aria-label={`Search ${backend} ${label}`}
              placeholder="Filter models…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          ) : null}
          <Select
            value={value || UNSET}
            onValueChange={(next) => {
              if (typeof next === "string")
                onChange(next === UNSET ? "" : next);
            }}
          >
            <SelectTrigger
              className="w-full"
              size="sm"
              aria-label={`${backend} ${label}`}
            >
              <SelectValue>{displayValue}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNSET}>{placeholder}</SelectItem>
              {savedMissing ? (
                <SelectItem value={value} disabled>
                  {value} (unavailable)
                </SelectItem>
              ) : null}
              {filtered.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {model.provider ? `${model.provider} / ` : ""}
                  {model.label ?? model.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      )}
      {loading ? (
        <p className="text-xs text-muted-foreground">Checking models…</p>
      ) : null}
      {listing?.problem ? (
        <p className="text-xs text-muted-foreground">{listing.problem}</p>
      ) : null}
      {backend === "pi" && !loading && models.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No authenticated models available. Connect a Provider in pi, then
          check again.
        </p>
      ) : null}
    </div>
  );
}
