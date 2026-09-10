import { useRef } from "react";

import { PERMISSION_CHOICES } from "../../../src/client/permission.ts";
import type { OpenPermission } from "../../../src/client/reduce.ts";
import { cn } from "@/lib/utils.ts";

/**
 * What wants to run, above the box that cannot send a message until it is decided.
 *
 * The same object as `ComposerEnquiry` and `ComposerMenu` — the same grid-rows transition, the same
 * remembered-rows close, the same divs-not-buttons, the same focus staying in the editor. Three
 * surfaces sliding out of one composer with three behaviours would be three features; this is one
 * gesture used a third time.
 *
 * Like an Enquiry and unlike the `/` menu, it **cannot be dismissed** — it is holding a turn open.
 * Unlike an Enquiry, Escape does something rather than nothing: it refuses, which is a real answer
 * the model carries on from.
 *
 * `summary` is the one thing here that is not on `authorising`. What is being authorised has to be on
 * screen — "Allow Bash?" is not a question anybody can answer — and the précis of the call's
 * arguments already exists, on the `tool` Entry sharing this id. The caller reads it from the
 * transcript surface and passes it down, rather than the protocol carrying the input a second time.
 */
export function ComposerPermission({
  authorising,
  summary,
  cursor,
  listboxId,
  rowId,
  onChoose,
  onHighlight,
}: {
  /** Absent when nothing is waiting, which is how this animates closed rather than vanishing. */
  authorising: OpenPermission | undefined;
  /** The call's arguments, précised — or undefined where there was nothing worth saying. */
  summary: string | undefined;
  cursor: number;
  listboxId: string;
  rowId: (index: number) => string;
  onChoose: (index: number) => void;
  onHighlight: (index: number) => void;
}) {
  const open = authorising !== undefined;

  // The last prompt worth showing, kept so the close has something to animate away — the trick
  // `ComposerMenu` documents and `ComposerEnquiry` reuses.
  const remembered = useRef<{ authorising: OpenPermission; summary: string | undefined } | undefined>(
    undefined,
  );
  if (authorising) remembered.current = { authorising, summary };
  const shown = open ? { authorising, summary } : remembered.current;

  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
      )}
      aria-hidden={!open}
    >
      <div className="overflow-hidden">
        <div className="border-b">
          {shown ? (
            <>
              {/*
                * `aria-live` on this row alone, as in `ComposerEnquiry`: a new prompt arriving is
                * worth announcing, and a live region over the cursor would narrate every arrow key.
                */}
              <div
                aria-live="polite"
                className="flex items-baseline gap-2 px-3 pt-2 pb-1 text-xs text-muted-foreground"
              >
                <span className="font-medium text-foreground">Authorise {shown.authorising.tool}?</span>
                <span>this session has not been allowed to run it</span>
              </div>

              {/*
                * The arguments, monospaced and truncated to one line. A command or a path is not
                * prose, and wrapping one over three lines pushes the message that motivated it off
                * the screen — which is the same argument `ComposerEnquiry` makes for one Question at
                * a time. The whole of it is on the tool row above, in the transcript.
                */}
              {shown.summary ? (
                <div className="truncate px-3 pb-1 font-mono text-sm">{shown.summary}</div>
              ) : null}

              <div
                id={listboxId}
                role="listbox"
                aria-label={`Authorise ${shown.authorising.tool}?`}
                className="p-1"
              >
                {PERMISSION_CHOICES.map((choice, index) => (
                  <div
                    key={choice.decision}
                    id={rowId(index)}
                    role="option"
                    // Single-select, so the cursor and the selection are one fact — the conflation
                    // `ComposerEnquiry` cannot make under multiSelect.
                    aria-selected={index === cursor}
                    // mousedown, not click, for the reason `ComposerEnquiry` gives: click lands after
                    // the editor has lost focus.
                    onMouseDown={(event) => {
                      event.preventDefault();
                      onChoose(index);
                    }}
                    onMouseEnter={() => onHighlight(index)}
                    className={cn(
                      "cursor-default rounded-md px-2 py-1 text-sm",
                      index === cursor && "bg-accent",
                    )}
                  >
                    <div className="flex items-baseline gap-2">
                      <span aria-hidden className="w-3 shrink-0 font-mono text-xs text-muted-foreground">
                        {index + 1}
                      </span>
                      <span className="shrink-0 font-medium">{choice.label}</span>
                      {index !== cursor ? (
                        <span className="min-w-0 truncate text-xs text-muted-foreground">
                          {choice.description}
                        </span>
                      ) : null}
                    </div>
                    {/*
                      * The whole description under the cursor, as `ComposerEnquiry` does — and here
                      * there is one row it exists for. "Always allow on this machine" is a sentence
                      * whose consequence is in its second half, and truncating it to the width of a
                      * composer cuts off exactly the part that should give someone pause.
                      */}
                    {index === cursor ? (
                      <div className="pt-0.5 pl-5 text-xs text-muted-foreground">{choice.description}</div>
                    ) : null}
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
