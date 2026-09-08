import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";

import {
  composerExtensions,
  editableFor,
  hintFor,
  setCatalogue,
  type MenuKeys,
} from "@/components/composer-extensions.ts";
import type { Triggerable } from "@/presentation/composer-menu.ts";

export type { MenuKeys };

/**
 * The Composer's text box.
 *
 * A CodeMirror editor rather than a `<textarea>`, for the two things a textarea cannot do: it has
 * one string and no way to decorate a range of it, so neither the pill under a `/name` nor the
 * markdown a message is being written in could be shown at all.
 *
 * Everything the textarea did, it still does, and each of those had to be re-earned rather than
 * ported — Enter sends, Shift+Enter does not, a composing IME owns Enter outright, the box floors at
 * two rows and caps at 200px, an image paste is caught rather than inserted, an ended session cannot
 * be typed into. There is no component harness in this repo (see TODO.md), so all of it is verified
 * by someone typing into the box, which is how the duplicated placeholder got as far as it did.
 *
 * The text stays React's. CodeMirror is uncontrolled by nature and `value` is pushed into it only
 * when the two have actually diverged, which is what stops the send-clears-the-box path from
 * fighting the editor's own state. Everything else the Composer needs — focus after a refused send,
 * a caret placed after a completed name — comes back through `handle`.
 *
 * **Every reconfigurable extension lives in a compartment and nowhere else.** A compartment does not
 * replace an extension sitting beside it, it adds one, so a placeholder in both places drew twice.
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
        extensions: composerExtensions({
          placeholder,
          disabled,
          editable,
          hint,
          menu: () => latest.current.menu,
          onSubmit: () => latest.current.onSubmit(),
          onChange: (text, caret) => latest.current.onChange(text, caret),
          onPasteFiles: (files) => latest.current.onPasteFiles(files),
        }),
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
    view.current?.dispatch({ effects: hint.reconfigure(hintFor(placeholder)) });
  }, [placeholder, hint]);

  return <div ref={host} className="min-w-0 flex-1" />;
}
