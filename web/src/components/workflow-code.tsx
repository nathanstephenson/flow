import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { tags } from "@lezer/highlight";

const highlighting = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--status-awaiting)" },
  { tag: [tags.string, tags.regexp], color: "var(--diff-added)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--status-active)" },
  { tag: tags.comment, color: "var(--muted-foreground)" },
  { tag: tags.invalid, color: "var(--destructive)" },
]);
export function WorkflowCode({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | undefined>(undefined);
  const change = useRef(onChange);
  change.current = onChange;
  useEffect(() => {
    if (!root.current) return;
    const editor = new EditorView({
      parent: root.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          javascript({ typescript: true }),
          lineNumbers(),
          EditorView.lineWrapping,
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          syntaxHighlighting(highlighting),
          EditorView.contentAttributes.of({
            "aria-label": "TypeScript function body",
          }),
          EditorView.theme({
            "&": {
              minHeight: "240px",
              fontSize: "12px",
              backgroundColor: "var(--background)",
              color: "var(--foreground)",
            },
            "&.cm-focused": { outline: "2px solid var(--ring)" },
            ".cm-content": {
              fontFamily: "var(--font-mono)",
              caretColor: "var(--foreground)",
            },
            ".cm-scroller": {
              overflow: "auto",
              fontFamily: "var(--font-mono)",
            },
            ".cm-gutters": {
              backgroundColor: "var(--muted)",
              color: "var(--muted-foreground)",
              borderColor: "var(--border)",
            },
            ".cm-cursor": { borderLeftColor: "var(--foreground)" },
            ".cm-content ::selection, .cm-content::selection": {
              backgroundColor:
                "color-mix(in oklch, var(--status-active) 30%, transparent)",
            },
            "&.cm-focused .cm-matchingBracket": {
              backgroundColor: "var(--muted)",
            },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) change.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = undefined;
    };
  }, []);
  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value)
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: value },
      });
  }, [value]);
  return <div className="overflow-hidden rounded-lg border" ref={root} />;
}
