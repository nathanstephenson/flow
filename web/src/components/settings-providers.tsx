import { useEffect, useState } from "react";

import type { BackendModels } from "../../../src/protocol/events.ts";
import { useHost } from "@/host.tsx";
import { SaveRow, SettingsGroup, useSaveSettings } from "@/components/settings-parts.tsx";
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

/**
 * The value the "None" row carries, because a Select item cannot hold the empty string — Base UI
 * reads that as "nothing selected" and the row would silently never register as chosen.
 */
const NO_SUMMARY_MODEL = "__none__";

/**
 * Providers: which model to use when nobody has said, and which one names an Agent Session.
 *
 * Named for the Provider whose models these are, and laid out per **Backend Adapter**, because that
 * is the only way a model id can be reached — `opus[1m]` means something to Claude and nothing to
 * anything else. CONTEXT.md's Provider entry says the same.
 *
 * The lists come from `GET /api/models`, which opens a throwaway Backend Session per backend to ask
 * — the only way to learn a model id without an Agent Session, and the reason this section fetches
 * on mount rather than reading the config document every other page already holds. A backend that
 * could not answer gets a text field and its reason, rather than an empty list nobody can explain.
 */
export function ProvidersSettings() {
  const { config } = useHost();
  const { save, saving } = useSaveSettings();
  const { catalogue, loading, refresh } = useModelCatalogue();

  const currentDefaults = config.providers?.defaults ?? {};
  const currentSummary = config.providers?.summary;

  const [defaults, setDefaults] = useState<Record<string, string>>(currentDefaults);
  const [summaryBackend, setSummaryBackend] = useState(currentSummary?.backend ?? "");
  const [summaryModel, setSummaryModel] = useState(currentSummary?.modelId ?? "");
  const [automatic, setAutomatic] = useState(currentSummary?.automatic ?? true);

  // A reload, or a save from elsewhere, wins over what is half-chosen here.
  useEffect(() => {
    setDefaults(currentDefaults);
    setSummaryBackend(currentSummary?.backend ?? "");
    setSummaryModel(currentSummary?.modelId ?? "");
    setAutomatic(currentSummary?.automatic ?? true);
    // The config object is replaced wholesale on every save and refresh, so its identity is the
    // signal; comparing the fields would mean deep-comparing a map.
  }, [config]);

  const backends = config.backends ?? [];
  const dirtyDefaults = backends.some((backend) => (defaults[backend] ?? "") !== (currentDefaults[backend] ?? ""));
  const dirtySummary =
    summaryBackend !== (currentSummary?.backend ?? "") ||
    summaryModel !== (currentSummary?.modelId ?? "") ||
    automatic !== (currentSummary?.automatic ?? true);

  return (
    <>
      <SettingsGroup
        title="Default Model"
        description="The model a new Agent Session starts on, per backend. It is read when the session is created and never again, so choosing a different one here never moves a session already running. An id the backend cannot serve fails on that session's first turn — nothing checks it here, because only a running backend knows the list."
      >
        {backends.map((backend) => (
          <ModelField
            key={backend}
            label={backend}
            listing={catalogue?.find((entry) => entry.backend === backend)}
            loading={loading}
            value={defaults[backend] ?? ""}
            placeholder="Let the backend choose"
            onChange={(value) => setDefaults({ ...defaults, [backend]: value })}
          />
        ))}

        <SaveRow
          dirty={dirtyDefaults}
          saving={saving}
          onSave={() => void save({ providers: { defaults } }, "Default Models saved.")}
          onReset={() => setDefaults(currentDefaults)}
        />
      </SettingsGroup>

      <SettingsGroup
        title="Summary Model"
        description="Names an Agent Session in three to seven words, once when its first message is sent and again whenever you ask from the pane's overflow menu. It runs in its own Backend Session with no tools, sees only the transcript, and never touches the session it is naming. Leave it unset and a session keeps the first line of what you typed."
      >
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">Backend</span>
          <Select
            value={summaryBackend === "" ? null : summaryBackend}
            onValueChange={(value) => {
              if (typeof value !== "string") return;
              setSummaryBackend(value === NO_SUMMARY_MODEL ? "" : value);
              // A model id from the previous backend is meaningless to this one, and leaving it
              // would save a pair that can never be reached.
              setSummaryModel("");
            }}
          >
            <SelectTrigger size="sm" aria-label="Summary Model backend">
              <SelectValue placeholder="None — keep the first line" />
            </SelectTrigger>
            <SelectContent>
              {/*
                * The way back out, and the reason this list is not just the backends: without it
                * the placeholder promises a state nobody could return to, and choosing a Summary
                * Model once would be permanent.
                *
                * One word, because the popup is anchored to the trigger's width and the trigger is
                * sized to "claude". What None *means* is on the group's description above.
                */}
              <SelectItem value={NO_SUMMARY_MODEL}>None</SelectItem>
              {backends.map((backend) => (
                <SelectItem key={backend} value={backend}>
                  {backend}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        {summaryBackend === "" ? null : (
          <>
            <ModelField
              label="Model"
              listing={catalogue?.find((entry) => entry.backend === summaryBackend)}
              loading={loading}
              value={summaryModel}
              placeholder="Choose a model"
              onChange={setSummaryModel}
            />

            {/*
              * Hidden until a Summary Model is chosen, because until then it governs nothing —
              * the house rule the overflow menu follows too. It is *when*, not whether: turning
              * it off leaves the rename in the pane's menu working, which is the reason it is a
              * switch here rather than another way to say "None" above.
              */}
            <label className="flex items-center justify-between gap-4 pt-1">
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">Name new Agent Sessions automatically</span>
                <span className="text-xs text-muted-foreground">
                  Off keeps the first line of what you typed. You can still name one at any time
                  from the pane&rsquo;s overflow menu.
                </span>
              </span>
              <Switch checked={automatic} onCheckedChange={setAutomatic} />
            </label>
          </>
        )}

        <SaveRow
          // Both halves or neither: a backend without a model id is unreachable, so there is
          // nothing to save until the pair is complete. Clearing both is a save, and clears it.
          dirty={dirtySummary && (summaryBackend === "") === (summaryModel === "")}
          saving={saving}
          onSave={() =>
            void save(
              {
                providers: {
                  summary:
                    summaryBackend === ""
                      ? null
                      : { backend: summaryBackend, modelId: summaryModel, automatic },
                },
              },
              summaryBackend === "" ? "Summary Model cleared." : "Summary Model saved.",
            )
          }
          onReset={() => {
            setSummaryBackend(currentSummary?.backend ?? "");
            setSummaryModel(currentSummary?.modelId ?? "");
          }}
        />
      </SettingsGroup>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Button size="sm" variant="ghost" disabled={loading} onClick={() => void refresh()}>
          {loading ? "Asking the backends…" : "Check again"}
        </Button>
        <span>
          The lists are asked for once per Session Host, because asking starts a process for each
          backend.
        </span>
      </div>
    </>
  );
}

/**
 * One model choice: a list where the backend answered, a text field where it did not.
 *
 * The text field is not a lesser fallback but the honest one — a Claude that is not logged in and a
 * pi this build does not carry both leave a real person with a real id they know and no way to type
 * it, which is worse than a list they cannot use.
 */
function ModelField({
  label,
  listing,
  loading,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  listing: BackendModels | undefined;
  loading: boolean;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const models = listing?.models ?? [];

  return (
    <div className="flex flex-col gap-1">
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">{label}</span>
        {models.length === 0 ? (
          <Input
            className="font-mono text-xs"
            value={value}
            placeholder={loading ? "Asking the backend…" : placeholder}
            onChange={(event) => onChange(event.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
        ) : (
          <Select
            value={value === "" ? null : value}
            onValueChange={(next) => {
              if (typeof next === "string") onChange(next);
            }}
          >
            <SelectTrigger size="sm" aria-label={label}>
              <SelectValue placeholder={placeholder} />
            </SelectTrigger>
            <SelectContent>
              {models.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {model.label ?? model.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </label>
      {listing?.problem === undefined ? null : (
        <p className="text-xs text-muted-foreground">{listing.problem} — type an id instead.</p>
      )}
    </div>
  );
}

function useModelCatalogue(): {
  catalogue: BackendModels[] | undefined;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [catalogue, setCatalogue] = useState<BackendModels[] | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const load = async (refresh: boolean): Promise<void> => {
    setLoading(true);
    try {
      const response = await fetch(`/api/models${refresh ? "?refresh=1" : ""}`, {
        credentials: "same-origin",
      });
      setCatalogue((await response.json()) as BackendModels[]);
    } catch {
      // Every field falls back to a text input, which is a usable page. A toast here would be one
      // more thing to dismiss on the way to typing the id you already knew.
      setCatalogue([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(false);
    // On mount only: the host caches the answer, so re-asking on every render would be a request
    // per keystroke for a list that cannot have moved. "Check again" is the way to re-ask.
  }, []);

  return { catalogue, loading, refresh: () => load(true) };
}
