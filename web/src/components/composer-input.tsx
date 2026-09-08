import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Compartment, EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap, placeholder as placeholderExtension, type DecorationSet } from "@codemirror/view";
import { useEffect, useRef } from "react";

import { leadingToken, triggeredBy, type Triggerable } from "@/presentation/composer-menu.ts";

/**
 * The Composer's text box.
 *
 * A CodeMirror editor rather than a `<textarea>`, and the reason is what comes next rather than
 * anything wrong with the textarea: a slash-command menu needs to anchor to the caret, and a command
 * or skill picked from it has to show as a pill the caret cannot be dragged into the middle of.
 * Neither is expressible in a textarea, which has one string and no way to decorate a range of it.
 *
 * This commit does none of that. It is the swap alone, and the whole of its job is that the box goes
 * on behaving exactly as the textarea did — Enter sends, Shift+Enter does not, a composing IME owns
 * Enter outright, the box grows to a cap, an image paste is caught, and an ended session cannot be
 * typed into. There is no component harness in this repo (see TODO.md), so every one of those was
 * verified by hand and is listed in the commit that introduces this file.
 *
 * The text stays React's. CodeMirror is uncontrolled by nature and `value` is pushed into it only
 * when the two have actually diverged, which is what stops the send-clears-the-box path from
 * fighting the editor's own state. Everything else the Composer needs — focus after a refused send —
 * comes back through `handle`.
 */
export type ComposerInputHandle = {
  focus: () => void;
  /**
   * Replace the whole message and put the caret somewhere specific.
   *
   * Imperative because the caret is the point. Pushing text in through `value` leaves the caret at
   * the end of the document, which is right for clearing the box after a send and wrong for
   * completing a name — `/code-review the diff` wants the caret after the name, not after "diff".
   */
  replace: (text: string, caret: number) => void;
};

/**
 * What the open menu wants from the keys the editor would otherwise take.
 *
 * Handed in rather than owned here, because which item is highlighted is the menu's business and
 * the menu is React's. `choose` returns whether it took the Enter, so an empty menu still sends.
 */
export type MenuKeys = {
  active: boolean;
  move: (delta: number) => void;
  choose: () => boolean;
  dismiss: () => void;
};

/** The catalogue the pill decoration resolves names against. Replaced, never mutated. */
const setCatalogue = StateEffect.define<Triggerable[]>();

const catalogueField = StateField.define<Triggerable[]>({
  create: () => [],
  update(current, transaction) {
    for (const effect of transaction.effects) if (effect.is(setCatalogue)) return effect.value;
    return current;
  },
});

/**
 * The pill under a leading `/name` that GoodHarness or the backend will actually act on.
 *
 * Derived from the text rather than remembered from a menu choice, and that is the point: someone
 * who types `/tdd` from memory gets the same pill as someone who picked it from the list, because
 * the backend will treat the two identically. A pill that appeared only for menu picks would be
 * telling one of those two people something false.
 *
 * Deriving is safe here in a way it would not be in the Session Host or a Backend Adapter. The pill
 * *is* the feedback — it appears under the name before Enter is pressed, and one backspace takes it
 * away again — so nothing is decided invisibly. What the host must never do is guess at meaning
 * nobody can see.
 *
 * A mark and not an atomic widget, so the text stays text: the caret still moves through it, and
 * backspace still edits it into something ordinary.
 */
const pillField = StateField.define<DecorationSet>({
  create: (state) => pillsFor(state),
  update: (current, transaction) =>
    transaction.docChanged || transaction.effects.some((effect) => effect.is(setCatalogue))
      ? pillsFor(transaction.state)
      : current.map(transaction.changes),
  provide: (field) => EditorView.decorations.from(field),
});

function pillsFor(state: EditorState): DecorationSet {
  const text = state.doc.toString();
  const found = triggeredBy(text, state.field(catalogueField));
  const token = leadingToken(text);
  if (!found || !token) return Decoration.none;
  return Decoration.set([
    Decoration.mark({ class: found.kind === "command" ? "gh-pill-command" : "gh-pill-skill" }).range(0, token.to),
  ]);
}

function stop(event: KeyboardEvent): void {
  event.preventDefault();
  // The global keyboard layer listens on `window`, and Escape while typing means "blur this". With
  // the menu open Escape means "close the menu", so the event must not reach it.
  event.stopPropagation();
}

export function ComposerInput({
  value,
  placeholder,
  disabled,
  catalogue,
  menu,
  handle,
  onChange,
  onSubmit,
  onPasteFiles,
}: {
  value: string;
  placeholder: string;
  disabled: boolean;
  /** What a leading `/name` may resolve to, for the pill. */
  catalogue: Triggerable[];
  menu: MenuKeys;
  /** Filled with the imperative surface the Composer needs. A ref object, not a callback ref. */
  handle: React.RefObject<ComposerInputHandle | null>;
  /** The caret comes with the text, because whether the menu is open depends on where it is. */
  onChange: (text: string, caret: number) => void;
  onSubmit: () => void;
  /** Returns true when it took the files, which is what decides whether the paste is prevented. */
  onPasteFiles: (files: File[]) => boolean;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  /*
   * Every callback reaches CodeMirror through this rather than being closed over.
   *
   * An EditorView is built once and lives for the pane's life, so an extension capturing `onSubmit`
   * would capture the first render's copy of it — and `send` depends on `text`, `attachments` and
   * `sending`, all of which change constantly. The alternative is reconfiguring the keymap on every
   * render, which throws away CodeMirror's state to install a function that differs only by
   * identity.
   */
  const latest = useRef({ onChange, onSubmit, onPasteFiles, menu });
  latest.current = { onChange, onSubmit, onPasteFiles, menu };

  const editable = useRef(new Compartment()).current;
  const hint = useRef(new Compartment()).current;

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;

    const editor = new EditorView({
      parent,
      state: EditorState.create({
        extensions: [
          history(),
          keymap.of([
            {
              key: "Enter",
              run: (target) => {
                /*
                 * A composing IME owns Enter outright. Without this, committing a CJK candidate also
                 * sends the message — a real bug and not a theoretical one, which is why the textarea
                 * this replaces checked `nativeEvent.isComposing` and why the check had to be earned
                 * again here rather than assumed.
                 */
                if (target.composing) return false;
                latest.current.onSubmit();
                return true;
              },
            },
          ]),
          // Below the Enter binding, so a newline is what Enter does only when the above declines.
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          catalogueField,
          pillField,
          EditorView.updateListener.of((update) => {
            // Selection too, not only the document: the menu closes when the caret leaves the name,
            // and an arrow key moves the caret without changing a character.
            if (!update.docChanged && !update.selectionSet) return;
            latest.current.onChange(update.state.doc.toString(), update.state.selection.main.head);
          }),
          EditorView.domEventHandlers({
            /*
             * Ahead of the keymap, and only while the menu is open. These are the editor's own keys
             * — Enter, the arrows, Escape — borrowed for as long as there is a list in front of the
             * person pressing them, and handed straight back when there is not.
             */
            keydown: (event, target) => {
              const open = latest.current.menu;
              if (!open.active) return false;
              if (event.key === "Escape") {
                open.dismiss();
                stop(event);
                return true;
              }
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                open.move(event.key === "ArrowDown" ? 1 : -1);
                stop(event);
                return true;
              }
              // Shift+Enter is a newline even here, and a composing IME still owns Enter outright.
              if (event.key === "Enter" && !event.shiftKey && !target.composing && open.choose()) {
                stop(event);
                return true;
              }
              return false;
            },
            paste: (event) => {
              const files = [...(event.clipboardData?.items ?? [])]
                .filter((item) => item.kind === "file")
                .map((item) => item.getAsFile())
                .filter((file): file is File => file !== null);
              // Nothing to attach means an ordinary text paste, which must keep CodeMirror's default.
              if (files.length === 0) return false;
              return latest.current.onPasteFiles(files);
            },
          }),
          // What `focusInPane` finds. The selector used to be `textarea`, which this element is not.
          EditorView.contentAttributes.of({ "data-composer-input": "" }),
          THEME,
          editable.of(editableFor(disabled)),
          // The placeholder lives in the compartment and nowhere else. It was also installed
          // directly here, which is not a duplicate that replaces itself: reconfiguring the
          // compartment added a second placeholder beside the first, and both rendered — one
          // sentence printed over the other.
          hint.of(placeholderExtension(placeholder)),
        ],
      }),
    });
    view.current = editor;
    handle.current = {
      focus: () => editor.focus(),
      replace: (text, caret) =>
        editor.dispatch({
          changes: { from: 0, to: editor.state.doc.length, insert: text },
          selection: { anchor: Math.min(caret, text.length) },
        }),
    };

    return () => {
      editor.destroy();
      view.current = null;
      handle.current = null;
    };
    // Built once. Everything that varies is a compartment or goes through `latest`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * Pushed in only when the two have diverged, which is the whole of the controlled-input problem
   * here: without the comparison every keystroke would dispatch its own value back into the editor,
   * resetting the selection to the end of the document mid-word.
   */
  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === value) return;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: editable.reconfigure(editableFor(disabled)) });
  }, [disabled, editable]);

  useEffect(() => {
    view.current?.dispatch({ effects: setCatalogue.of(catalogue) });
  }, [catalogue]);

  // The placeholder is `composerPlaceholder(chrome)` and says what the next Enter will *do* — Revive
  // a Dormant session, or queue behind a running turn. It changes with the status, so it cannot be
  // baked into the initial state.
  useEffect(() => {
    view.current?.dispatch({ effects: hint.reconfigure(placeholderExtension(placeholder)) });
  }, [placeholder, hint]);

  return <div ref={host} className="min-w-0 flex-1" />;
}

function editableFor(disabled: boolean): Extension {
  return [EditorView.editable.of(!disabled), EditorState.readOnly.of(disabled)];
}

/**
 * CodeMirror ships its own StyleModule, so these cannot be Tailwind classes on the wrapper — the
 * rules they have to beat are on `.cm-content` and `.cm-scroller` themselves.
 *
 * Sans, matching what the message becomes: a user Entry renders as markdown in the chrome font, and
 * composing against a monospace grid only to watch it reflow on send is a small lie about what you
 * wrote. CodeMirror's default is monospace, so this is a correction rather than a preference.
 *
 * The height rules are the textarea's `rows={2}` and its capped auto-grow, restated. A floor of two
 * rows so the box still looks like somewhere a paragraph goes, and a cap because a composer that can
 * swallow the transcript is not a composer. CodeMirror grows on its own between them, which is the
 * one piece of this that got simpler.
 */
const THEME = EditorView.theme({
  "&": {
    fontSize: "0.875rem",
    color: "var(--foreground)",
    backgroundColor: "transparent",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-content": {
    fontFamily: "inherit",
    padding: "0.5rem 0.75rem",
    minHeight: "3.25rem",
    caretColor: "var(--foreground)",
  },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.5", maxHeight: "200px" },
  ".cm-line": { padding: "0" },
  ".cm-placeholder": { color: "var(--muted-foreground)" },
  // The textarea showed this through `disabled:opacity-50`; `readOnly` has no such pseudo-class.
  "&:not(.cm-focused) .cm-content[contenteditable='false']": { opacity: "0.5", cursor: "not-allowed" },
  /*
   * Two colours because they are two different things, not for decoration. Blue is a Command:
   * GoodHarness performs it, and it never reaches a model. Purple is a Skill: the backend expands it,
   * and it goes as the message it already is. Someone about to press Enter can tell which of those
   * is about to happen without having learned the difference first.
   *
   * Set as backgrounds on an inline run, so the pill wraps with the text rather than being a box the
   * line has to make room for.
   */
  ".gh-pill-command, .gh-pill-skill": {
    borderRadius: "0.375rem",
    padding: "0.05rem 0.2rem",
    fontWeight: "500",
  },
  ".gh-pill-command": {
    backgroundColor: "color-mix(in oklab, var(--trigger-command) 18%, transparent)",
    color: "var(--trigger-command)",
  },
  ".gh-pill-skill": {
    backgroundColor: "color-mix(in oklab, var(--trigger-skill) 18%, transparent)",
    color: "var(--trigger-skill)",
  },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  "&.cm-editor .cm-selectionBackground, ::selection": { backgroundColor: "var(--accent)" },
});
