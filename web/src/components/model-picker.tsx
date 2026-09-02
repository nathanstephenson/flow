import type { Capabilities, EffortLevel, ModelInfo } from "../../../src/protocol/events.ts";
import { effortChoices, modelChoices, type ModelChoice } from "@client/model-choices.ts";
import { initialState } from "@client/reduce.ts";
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
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.tsx";

/**
 * Which model is in force, and how to change it.
 *
 * Two controls behind one threshold, because the two backends are genuinely different: Claude
 * reports a handful of models and the pi backend "can offer hundreds". Under thirty choices a Select
 * is the better control — it type-to-filters for free and it is the accessible path we did not have
 * to build — and above it a Combobox with a filter input is the only usable one. Six lines of hedge
 * beats picking one and being wrong for half the users.
 */
const COMBOBOX_THRESHOLD = 30;

/** Above this many *filtered* matches the list stops mounting rows and says so. */
const RENDER_LIMIT = 100;

export type ModelPickerProps = {
  capabilities: Capabilities | undefined;
  model: ModelInfo | undefined;
  disabled?: boolean | undefined;
  onSelect: (modelId: string) => void;
};

export function ModelPicker(props: ModelPickerProps) {
  const choices = modelChoices(props.capabilities);
  // A backend that reports no models has no picker, the same rule Effort follows.
  if (choices.length === 0) return null;
  return choices.length <= COMBOBOX_THRESHOLD ? <ModelSelect {...props} choices={choices} /> : <ModelCombobox {...props} choices={choices} />;
}

type WithChoices = ModelPickerProps & { choices: ModelChoice[] };

function ModelSelect({ choices, model, disabled, onSelect }: WithChoices) {
  return (
    <Select
      value={model?.id ?? null}
      disabled={disabled}
      onValueChange={(value) => {
        if (typeof value === "string") onSelect(value);
      }}
    >
      <SelectTrigger aria-label="Model">
        <SelectValue placeholder="model">{() => modelLabel(model)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {groupByProvider(choices).map((group) => (
          <SelectGroup key={group.provider}>
            <SelectLabel>{group.provider}</SelectLabel>
            {group.items.map((choice) => (
              <SelectItem key={choice.model.id} value={choice.model.id}>
                {modelLabel(choice.model)}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Base UI's Combobox, fed the provider groups `modelChoices()` already produces.
 *
 * `Group`/`GroupLabel`/`Collection` map one-to-one onto that output, which is why there is no `cmdk`
 * here and no Popover+Command scaffolding: the grouping, the filtering and the empty state are all
 * parts of the component.
 */
function ModelCombobox({ choices, model, disabled, onSelect }: WithChoices) {
  const groups = groupByProvider(choices);
  // The value is the choice object rather than the id, because the items *are* choice objects — and
  // the model in force arrives from the stream as a fresh ModelInfo, so identity comparison would
  // never match. Comparing on the id is what puts the check mark on the right row.
  const selected = choices.find((choice) => choice.model.id === model?.id) ?? null;

  return (
    <Combobox
      items={groups}
      limit={RENDER_LIMIT}
      disabled={disabled}
      value={selected}
      isItemEqualToValue={(left: ModelChoice, right: ModelChoice) => left.model.id === right.model.id}
      itemToStringLabel={(choice: ModelChoice) => modelLabel(choice.model)}
      itemToStringValue={(choice: ModelChoice) => choice.model.id}
      onValueChange={(value) => {
        const choice = value as ModelChoice | null;
        if (choice) onSelect(choice.model.id);
      }}
    >
      {/*
       * Upstream's ComboboxTrigger carries no chrome of its own — it is styled for the icon-button
       * slot inside ComboboxInput's InputGroup — so a standalone closed trigger has to be given a
       * Button to render as, or the two halves of this one control (Select under thirty choices,
       * Combobox over) would not look like the same control.
       */}
      <ComboboxTrigger aria-label="Model" render={<Button variant="outline" />}>
        <ComboboxValue>{(choice: ModelChoice | null) => modelLabel(choice?.model ?? model)}</ComboboxValue>
      </ComboboxTrigger>
      <ComboboxContent>
        {/*
         * `showTrigger={false}` matters: left at its default, ComboboxInput renders a second
         * ComboboxTrigger inside the popup, which mounts later than the real one above and so
         * becomes what Base UI anchors to. The popup then measures a 28px icon button inside itself,
         * `--anchor-width` collapses, and it lands in the corner of the viewport at that width.
         */}
        <ComboboxInput showTrigger={false} placeholder={`Filter ${choices.length} models`} />
        <ComboboxList>
          {(group: ProviderGroup) => (
            <ComboboxGroup key={group.provider} items={group.items}>
              <ComboboxLabel>{group.provider}</ComboboxLabel>
              <ComboboxCollection>
                {(choice: ModelChoice) => (
                  <ComboboxItem key={choice.model.id} value={choice}>
                    {modelLabel(choice.model)}
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
        <ComboboxEmpty>No model matches.</ComboboxEmpty>
        {choices.length > RENDER_LIMIT ? (
          <p className="border-t px-2 py-1.5 text-xs text-muted-foreground">
            Showing at most {RENDER_LIMIT} matches — keep typing.
          </p>
        ) : null}
      </ComboboxContent>
    </Combobox>
  );
}

/**
 * The Effort control, which is absent rather than disabled when the model in force has no Effort
 * levels — Claude's haiku reports none, and a permanently greyed control that cannot ever be used
 * teaches nothing except that the UI knows about a setting you cannot have.
 */
export function EffortPicker({
  capabilities,
  model,
  effort,
  disabled,
  onSelect,
}: {
  capabilities: Capabilities | undefined;
  model: ModelInfo | undefined;
  effort: EffortLevel | undefined;
  disabled?: boolean | undefined;
  onSelect: (effort: EffortLevel) => void;
}) {
  // effortChoices reads exactly two fields of ViewState, and Chrome is the projection that carries
  // them. Rebuilding the shape it wants beats reimplementing the "levels belong to the model in
  // force, not to the Agent Session" rule that both front-ends have to agree on.
  const levels = effortChoices({ ...initialState(), capabilities, model });
  if (levels.length === 0) return null;

  return (
    <Select
      value={effort ?? null}
      disabled={disabled}
      onValueChange={(value) => {
        if (typeof value === "string") onSelect(value as EffortLevel);
      }}
    >
      <SelectTrigger aria-label="Effort">
        <SelectValue placeholder="effort">{() => effort ?? "effort"}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {levels.map((level) => (
          <SelectItem key={level} value={level}>
            {level}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

type ProviderGroup = { provider: string; items: ModelChoice[] };

/**
 * `modelChoices()` returns a flat list already sorted by provider, so the grouping is a fold rather
 * than a sort. Keeping the flat shape shared and the grouping local is deliberate: the TUI renders
 * the same data as a scrolling list with provider headings.
 */
function groupByProvider(choices: ModelChoice[]): ProviderGroup[] {
  const groups: ProviderGroup[] = [];
  for (const choice of choices) {
    const last = groups[groups.length - 1];
    if (last && last.provider === choice.provider) last.items.push(choice);
    else groups.push({ provider: choice.provider, items: [choice] });
  }
  return groups;
}

function modelLabel(model: ModelInfo | undefined): string {
  return model?.label ?? model?.id ?? "model";
}
