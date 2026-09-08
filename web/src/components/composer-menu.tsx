import { useRef } from "react";

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
  open,
  items,
  loading,
  highlighted,
  onChoose,
  onHighlight,
}: {
  /**
   * Whether `/` was typed — not whether there is anything to show.
   *
   * These came apart because tying the menu's visibility to its contents made it invisible exactly
   * when something had gone wrong: a slow catalogue, an empty one, a daemon that could not answer.
   * A menu that says nothing is indistinguishable from a menu that was never built.
   */
  open: boolean;
  items: Triggerable[];
  /** The catalogue has not answered yet. Distinct from having answered with nothing. */
  loading: boolean;
  highlighted: number;
  onChoose: (item: Triggerable) => void;
  onHighlight: (index: number) => void;
}) {
  /*
   * The list that was last worth showing, kept so the close has something to animate away.
   * Dropping to `items` immediately would collapse an empty box — the height would animate but the
   * contents would vanish on the first frame, which reads as a glitch rather than a close.
   *
   * Written during render on purpose, and safe to be: it is a cache of the argument, so running it
   * twice does what running it once does.
   */
  const remembered = useRef<Triggerable[]>([]);
  if (open) remembered.current = items;
  const shown = open ? items : remembered.current;
  const empty = shown.length === 0;

  return (
    /*
     * `grid-rows-[0fr]` to `[1fr]` rather than a height, because the height is whatever the list
     * happens to be and CSS cannot transition to `auto`. The panel is anchored to the bottom of the
     * pane, so growing this pushes the panel up into the transcript — the menu appears to come out
     * of the composer rather than the composer jumping to make room.
     *
     * The ResizeObserver on the panel is measuring throughout, so `--composer-inset` follows the
     * animation frame by frame and the transcript above stays clear of it the whole way.
     */
    <div
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
      )}
      aria-hidden={!open}
    >
      <div className="overflow-hidden">
        <div className="max-h-64 overflow-y-auto border-b p-1" role="listbox" aria-label="Commands and Skills">
          {/*
            * A row rather than nothing, in both cases. "Still looking" and "nothing here" are
            * different answers and both are better than an empty box, which is the one thing that
            * cannot be told apart from a broken feature.
            */}
          {empty ? (
            <div className="px-2 py-1 text-sm text-muted-foreground">
              {loading ? "Looking for Skills…" : "No Commands or Skills for this Agent Session"}
            </div>
          ) : null}
          {shown.map((item, index) => (
            <div
              key={`${item.kind}:${item.name}`}
              role="option"
              aria-selected={index === highlighted}
              // Chosen on mousedown rather than click, because click lands after the editor has
              // already lost focus and the selection with it — and the completion needs to know
              // where the caret was. preventDefault keeps the focus where it is.
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
      </div>
    </div>
  );
}
