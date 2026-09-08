import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExtension } from "@codemirror/view";
import { useEffect, useRef } from "react";

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
export type ComposerInputHandle = { focus: () => void };

export function ComposerInput({
  value,
  placeholder,
  disabled,
  handle,
  onChange,
  onSubmit,
  onPasteFiles,
}: {
  value: string;
  placeholder: string;
  disabled: boolean;
  /** Filled with the imperative surface the Composer needs. A ref object, not a callback ref. */
  handle: React.RefObject<ComposerInputHandle | null>;
  onChange: (text: string) => void;
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
  const latest = useRef({ onChange, onSubmit, onPasteFiles });
  latest.current = { onChange, onSubmit, onPasteFiles };

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
          placeholderExtension(placeholder),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current.onChange(update.state.doc.toString());
          }),
          EditorView.domEventHandlers({
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
          hint.of([]),
        ],
      }),
    });
    view.current = editor;
    handle.current = { focus: () => editor.focus() };

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
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  "&.cm-editor .cm-selectionBackground, ::selection": { backgroundColor: "var(--accent)" },
});
