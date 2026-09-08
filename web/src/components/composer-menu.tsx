import { cn } from "@/lib/utils.ts";
import type { Triggerable } from "@/presentation/composer-menu.ts";

/**
 * What `/` offers, above the box it was typed into.
 *
 * Not anchored to the caret, and it does not need to be: a trigger only ever lives at the very start
 * of the message (see `leadingToken`), so the name being filtered is always in the same place. That
 * removes the whole apparatus a caret-following menu needs — measuring coordinates, a virtual anchor,
 * a popup fighting the editor for focus — in exchange for nothing anybody would notice.
 *
 * Focus stays in the editor throughout. This is a list that is looked at, not one that is tabbed
 * into: the keys that drive it are borrowed by `ComposerInput` for exactly as long as it is open, so
 * typing never stops working. Which is why the items are `<div>`s with a click handler rather than
 * buttons — a button here would be a tab stop on the way to the send button, for a control that
 * cannot be reached by tabbing anyway.
 */
export function ComposerMenu({
  items,
  highlighted,
  onChoose,
  onHighlight,
}: {
  items: Triggerable[];
  highlighted: number;
  onChoose: (item: Triggerable) => void;
  onHighlight: (index: number) => void;
}) {
  if (items.length === 0) return null;

  return (
    <div className="max-h-64 overflow-y-auto border-b p-1" role="listbox" aria-label="Commands and Skills">
      {items.map((item, index) => (
        <div
          key={`${item.kind}:${item.name}`}
          role="option"
          aria-selected={index === highlighted}
          // Chosen on mousedown rather than click, because click lands after the editor has already
          // lost focus and the selection with it — and the completion needs to know where the caret
          // was. preventDefault keeps the focus where it is.
          onMouseDown={(event) => {
            event.preventDefault();
            onChoose(item);
          }}
          onMouseEnter={() => onHighlight(index)}
          className={cn(
            "flex cursor-default items-baseline gap-2 rounded-md px-2 py-1 text-sm",
            index === highlighted && "bg-accent",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 self-center rounded-full",
              item.kind === "command" ? "bg-trigger-command" : "bg-trigger-skill",
            )}
          />
          <span className="shrink-0 font-medium">/{item.name}</span>
          {item.argumentHint ? (
            <span className="shrink-0 font-mono text-xs text-muted-foreground">{item.argumentHint}</span>
          ) : null}
          <span className="min-w-0 truncate text-xs text-muted-foreground">{item.description}</span>
        </div>
      ))}
    </div>
  );
}
