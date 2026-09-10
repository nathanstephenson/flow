import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { defineLanguageFacet, HighlightStyle, Language, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { parser as markdownParser } from "@lezer/markdown";
import { Compartment, EditorState, Prec, StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  placeholder as placeholderExtension,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

// Relative, not the `@/` alias the rest of this directory uses: `node --test` resolves neither
// Vite aliases nor tsconfig paths, and a module nothing can import is a module nothing can test.
import { menuAction, type MenuAction } from "../presentation/composer-keys.ts";
import { enquiryAction, type EnquiryContext } from "../presentation/enquiry-keys.ts";
import { permissionAction, type PermissionContext } from "../presentation/permission-keys.ts";
import { leadingToken, triggeredBy, type Triggerable } from "../presentation/composer-menu.ts";

/**
 * The Composer's editor, as data rather than as a component.
 *
 * Split out of `composer-input.tsx` so it can be tested: `EditorState.create` needs no document, no
 * element and no browser, but `node --experimental-strip-types` will not load a `.tsx` — so a
 * builder that lives beside JSX is a builder nothing can look at. Everything here is the editor's
 * behaviour; the component next door is the twenty lines of React that mount it.
 */


/**
 * What the open menu wants from the keys the editor would otherwise take.
 *
 * Handed in rather than owned here, because which item is highlighted is the menu's business and
 * the menu is React's. Both pickers return whether they took the key, so an empty menu still sends.
 *
 * Two of them, because completing and sending are different intentions. `complete` is Tab: it puts
 * the name in the box and leaves the caret after it, for a Skill whose arguments are the point.
 * `submit` is Enter: the name is the whole message, so it goes.
 */
export type MenuKeys = {
  active: boolean;
  move: (delta: number) => void;
  complete: () => boolean;
  submit: () => boolean;
  dismiss: () => void;
};

/**
 * What the open Enquiry's picker can be asked to do, read at keystroke time like `MenuKeys`.
 *
 * `context` is handed the editor's own `composing` flag rather than reading one: whether an IME is
 * mid-candidate is a fact about the view, and everything else here is a fact about the picker.
 */
export type EnquiryKeys = {
  context: (composing: boolean) => EnquiryContext;
  move: (delta: number) => void;
  toggle: () => void;
  pick: (row: number) => void;
  commit: () => void;
  back: () => void;
};

/**
 * What the open Permission Prompt's picker can be asked to do, read at keystroke time like the two
 * above.
 *
 * Shorter than `EnquiryKeys` by exactly what a prompt does not have: no `toggle`, because a call is
 * allowed or it is not, and no `back`, because there is no earlier part to go back to. `deny` is the
 * one it gains, and it is Escape's meaning here.
 */
export type PermissionKeys = {
  context: (composing: boolean) => PermissionContext;
  move: (delta: number) => void;
  pick: (row: number) => void;
  commit: () => void;
  deny: () => void;
};

/**
 * The two keymaps a composer outside an Agent Session cannot use.
 *
 * The New Agent Session view has an editor and no session, so nothing can ask it a Question or hold
 * a tool call on its authorisation — both of those live inside a turn, and there is no turn. Passing
 * these beats making the props optional all the way down: `open: false` is the first thing both
 * `enquiryAction` and `permissionAction` check, so every key falls straight through to the editor,
 * and the plumbing keeps one shape for both callers.
 */
export const INERT_ENQUIRY_KEYS: EnquiryKeys = {
  context: (composing: boolean) => ({
    open: false,
    composing,
    multiSelect: false,
    typing: false,
    multiline: false,
    hasPrevious: false,
    rows: 0,
  }),
  move: () => {},
  toggle: () => {},
  pick: () => {},
  commit: () => {},
  back: () => {},
};

export const INERT_PERMISSION_KEYS: PermissionKeys = {
  context: (composing: boolean) => ({ open: false, composing, rows: 0 }),
  move: () => {},
  pick: () => {},
  commit: () => {},
  deny: () => {},
};

/** The catalogue the pill decoration resolves names against. Replaced, never mutated. */
export const setCatalogue = StateEffect.define<Triggerable[]>();

const catalogueField = StateField.define<Triggerable[]>({
  create: () => [],
  update(current, transaction) {
    for (const effect of transaction.effects) if (effect.is(setCatalogue)) return effect.value;
    return current;
  },
});

/**
 * The pill under a leading `/name` that Flow or the backend will actually act on.
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

/**
 * Markdown as it will look once sent, rather than as its own source.
 *
 * The first attempt styled the source and left every marker visible, on the argument that a composer
 * showing something other than what it will send is lying. That was the wrong reading of ADR 0012.
 * What that decision refuses is *withholding structure while it forms* — it renders a streamed
 * message live, asterisks and all, precisely so the shape appears as it arrives. A composer that
 * shows `` `ok` `` as backticks when the transcript will show a monospace chip is failing the same
 * test from the other side: two renderings of one string, disagreeing.
 *
 * So the markers are hidden and the content is styled to match `web/src/components/markdown.tsx`
 * exactly, with one rule keeping it honest: **the markers come back whenever the caret is inside the
 * construct.** Nothing is ever hidden from someone editing it, and nothing has to be guessed at to
 * put it back — move into the word and the backticks are there.
 *
 * Inline constructs only for now. Headings, quotes, lists and fences are still styled as source,
 * because hiding a `#` means committing to a heading's size in a box that must not reflow while
 * someone types in it, and that is a separate decision from this one.
 *
 * This is a second markdown implementation in the repo, and worth being explicit about. `marked`
 * lexes what a *model wrote* into the token tree both front-ends render; Lezer parses what a *human
 * is typing*. They answer different questions and never meet: nothing here produces a token tree,
 * and nothing in the transcript consults this. Sharing one would have meant reconstructing character
 * offsets marked does not carry — its blockquote and list children are lexed against de-quoted and
 * de-indented text, and its table cells carry no position at all.
 */
const MARKDOWN_STYLE = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "600" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through", color: "var(--muted-foreground)" },
  { tag: tags.link, color: "var(--trigger-command)" },
  { tag: tags.url, color: "var(--trigger-command)" },
  // Block markers stay visible, so they stay dimmed: the words lead, the syntax recedes.
  { tag: tags.processingInstruction, color: "var(--muted-foreground)" },
  { tag: tags.meta, color: "var(--muted-foreground)" },
  { tag: tags.quote, color: "var(--muted-foreground)" },
  { tag: tags.list, color: "var(--muted-foreground)" },
]);

/**
 * The marker nodes that stop being shown once the caret leaves the construct they belong to.
 *
 * Only ever the punctuation — a `CodeMark` is a backtick, an `EmphasisMark` an asterisk. The text
 * between them is never touched, so nothing can hide a character somebody wrote.
 */
const HIDEABLE_MARKS = new Set(["CodeMark", "EmphasisMark", "StrikethroughMark"]);

/** The constructs whose content is styled to match what the transcript will render. */
const STYLED_CONTENT: Record<string, string> = { InlineCode: "gh-md-code" };

/**
 * Hide the markers, style the content, and put the markers back under the caret.
 *
 * A ViewPlugin rather than a StateField because it has to react to the *selection* as well as the
 * document: moving the caret into a code span changes what is shown without changing a character.
 */
const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = previewFor(view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = previewFor(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

function previewFor(view: EditorView): DecorationSet {
  const found: Range<Decoration>[] = [];
  const caret = view.state.selection.main;

  syntaxTree(view.state).iterate({
    enter: (node) => {
      const style = STYLED_CONTENT[node.name];
      if (style) found.push(Decoration.mark({ class: style }).range(node.from, node.to));
      if (!HIDEABLE_MARKS.has(node.name)) return;

      /*
       * Measured against the *construct*, not the marker: a caret anywhere in `` `ok` `` reveals both
       * backticks, so they appear and disappear as a pair. Revealing only the one being touched
       * would shift the text sideways twice on the way through a word.
       */
      const construct = node.node.parent;
      if (!construct) return;
      const editing = caret.from <= construct.to && caret.to >= construct.from;
      if (!editing) found.push(Decoration.replace({}).range(node.from, node.to));
    },
  });

  return Decoration.set(found, true);
}

/**
 * The markdown grammar, wired up from `@lezer/markdown` rather than through
 * `@codemirror/lang-markdown`.
 *
 * The wrapper package statically imports `@codemirror/lang-html`, to parse HTML embedded in
 * markdown, and it costs 60kB gzipped that this box has no use for — nobody writes an HTML block
 * into a chat message, and if they do it is text either way. Going through `Language` directly skips
 * it: `MarkdownParser` is a `@lezer/common` `Parser` like any other, so nothing here is a
 * workaround. It also means no fenced code block opens the door to a nested grammar, which is the
 * other half of what that package is for.
 */
const MARKDOWN = new Language(defineLanguageFacet(), markdownParser, [], "markdown");

function stop(event: KeyboardEvent): void {
  event.preventDefault();
  // The global keyboard layer listens on `window`, and Escape while typing means "blur this". With
  // the menu open Escape means "close the menu", so the event must not reach it.
  event.stopPropagation();
}

/**
 * Everything the editor is made of, as data.
 *
 * Exported and DOM-free so `composer-extensions.test.ts` can build an `EditorState` from exactly
 * what the component builds one from and assert on its shape. `EditorState.create` needs no
 * document, no element and no browser, which is the whole reason this is a function rather than an
 * array literal inside a `useEffect` where nothing could ever look at it.
 *
 * **The order matters and is the bug this shape exists to stop.** CodeMirror resolves handlers by
 * precedence, and within one precedence by position here. The menu's keys used to sit below both
 * keymaps, so Enter sent the message instead of picking, `defaultKeymap` moved the caret on the
 * arrows, and Escape simplified the selection — the menu opened and ignored every key pressed at
 * it. `Prec.highest` is what fixes that, and the test is what keeps it fixed.
 */
export type ComposerExtensionOptions = {
  placeholder: string;
  disabled: boolean;
  /** Compartments, so the two things that change do so without rebuilding the editor. */
  editable: Compartment;
  hint: Compartment;
  /** Read at keystroke time, never captured: which item is highlighted changes every keypress. */
  menu: () => MenuKeys;
  /** The same, and for the same reason — the cursor and the typed answer both move per keypress. */
  enquiry: () => EnquiryKeys;
  /** The same again: the cursor moves per keypress, and which prompt is in hand changes per turn. */
  permission: () => PermissionKeys;
  onSubmit: () => void;
  onChange: (text: string, caret: number) => void;
  onPasteFiles: (files: File[]) => boolean;
};

export function composerExtensions(options: ComposerExtensionOptions): Extension[] {
  return [
    /*
     * Above both keymaps below, which is the whole point. A keymap rather than a raw keydown
     * handler for two reasons: CodeMirror puts keymaps in precedence order in a facet anyone can
     * read, so "the menu outranks the editor" is a thing a test can assert rather than a thing a
     * comment can claim; and returning true makes CodeMirror call `preventDefault`, which the global
     * keyboard layer now takes as "already handled" instead of blurring the box on Escape.
     */
    /*
     * Ahead of the menu's group, in the same precedence bucket — two groups rather than one array
     * with duplicate keys, so which is consulted first is a fact about facet order that
     * `composer-extensions.test.ts` reads back, rather than a claim about how CodeMirror chains
     * same-key bindings within one group.
     *
     * The two can never both be open: an Enquiry locks the composer, and a locked composer does not
     * open the `/` menu. So the order is unobservable at runtime and is argued from meaning — but a
     * lockout that depended on that being true would be a lockout with a race in it.
     */
    /*
     * Ahead of the Enquiry's group, on the same terms and with the same caveat: the two can never
     * both be open, because the CLI is blocked on one callback at a time — so the order is
     * unobservable at runtime and is argued from meaning. A lockout that *depended* on that being
     * true would be a lockout with a race in it, which is why this is a group of its own rather
     * than more keys in the one below.
     *
     * Only three digits, unlike the Enquiry's five: a prompt has exactly three choices, and binding
     * a fourth would take a character out of the editor to reach a row that is not there.
     */
    Prec.highest(
      keymap.of([
        { key: "Escape", run: permissionKey("Escape", options.permission) },
        { key: "ArrowUp", run: permissionKey("ArrowUp", options.permission) },
        { key: "ArrowDown", run: permissionKey("ArrowDown", options.permission) },
        { key: "Enter", run: permissionKey("Enter", options.permission) },
        ...["1", "2", "3"].map((digit) => ({
          key: digit,
          run: permissionKey(digit, options.permission),
        })),
      ]),
    ),
    Prec.highest(
      keymap.of([
        { key: "Escape", run: enquiryKey("Escape", options.enquiry) },
        { key: "ArrowUp", run: enquiryKey("ArrowUp", options.enquiry) },
        { key: "ArrowDown", run: enquiryKey("ArrowDown", options.enquiry) },
        { key: "Enter", run: enquiryKey("Enter", options.enquiry) },
        { key: "Space", run: enquiryKey(" ", options.enquiry) },
        ...["1", "2", "3", "4", "5"].map((digit) => ({
          key: digit,
          run: enquiryKey(digit, options.enquiry),
        })),
      ]),
    ),
    Prec.highest(
      keymap.of([
        { key: "Escape", run: menuKey("dismiss", options.menu) },
        { key: "ArrowUp", run: menuKey("previous", options.menu) },
        { key: "ArrowDown", run: menuKey("next", options.menu) },
        { key: "Tab", run: menuKey("complete", options.menu) },
        { key: "Enter", run: menuKey("submit", options.menu) },
      ]),
    ),
    history(),
    keymap.of([
      {
        key: "Enter",
        run: (target) => {
          /*
           * A composing IME owns Enter outright. Without this, committing a CJK candidate also
           * sends the message — a real bug and not a theoretical one, which is why the textarea this
           * replaces checked `nativeEvent.isComposing` and why the check had to be earned again here
           * rather than assumed.
           */
          if (target.composing) return false;
          options.onSubmit();
          return true;
        },
      },
    ]),
    // Below the Enter binding, so a newline is what Enter does only when the above declines.
    keymap.of([...defaultKeymap, ...historyKeymap]),
    EditorView.lineWrapping,
    MARKDOWN,
    syntaxHighlighting(MARKDOWN_STYLE),
    livePreview,
    catalogueField,
    pillField,
    EditorView.updateListener.of((update) => {
      // Selection too, not only the document: the menu closes when the caret leaves the name, and an
      // arrow key moves the caret without changing a character.
      if (!update.docChanged && !update.selectionSet) return;
      options.onChange(update.state.doc.toString(), update.state.selection.main.head);
    }),
    EditorView.domEventHandlers({
      paste: (event) => {
        const files = [...(event.clipboardData?.items ?? [])]
          .filter((item) => item.kind === "file")
          .map((item) => item.getAsFile())
          .filter((file): file is File => file !== null);
        // Nothing to attach means an ordinary text paste, which must keep CodeMirror's default.
        if (files.length === 0) return false;
        return options.onPasteFiles(files);
      },
    }),
    // What `focusInPane` finds. The selector used to be `textarea`, which this element is not.
    EditorView.contentAttributes.of({ "data-composer-input": "" }),
    THEME,
    options.editable.of(editableFor(options.disabled)),
    // The placeholder lives in the compartment and nowhere else. It was also installed directly
    // here once, which is not a duplicate that replaces itself: reconfiguring the compartment added
    // a second placeholder beside the first, and both rendered — one sentence over the other.
    options.hint.of(placeholderExtension(options.placeholder)),
  ];
}

/**
 * One menu key, as a CodeMirror binding.
 *
 * Declines whenever `menuAction` says the key is not the menu's — a closed menu, a composing IME, a
 * Shift that means something else — and declining is what lets the binding below it run. So Enter
 * still sends when nothing is highlighted, with no special case anywhere for it.
 */
/**
 * One key, handed to the pure rule and then to the picker.
 *
 * Keyed on the literal key rather than on an action, unlike `menuKey`, because the digits all map to
 * the same action with a different row — so the action is the *answer* here rather than the question.
 *
 * `commit` returns true unconditionally, and that is load-bearing: a refused commit — an empty
 * multiSelect — must not fall through to the editor's own Enter binding and reach `send()`. The
 * picker shows what is missing instead. The guard in `send()` is defence, not the mechanism.
 */
/**
 * One key, handed to the pure rule and then to the picker. Shaped exactly as `enquiryKey`.
 *
 * Every arm returns true, `commit` included, and here that is stronger than it is next door: an
 * Enter that fell through to the editor's own binding would reach `send()` over a turn blocked on a
 * callback, and an Escape that fell through would blur the composer — leaving the panel on screen
 * with nothing focused to drive it.
 */
function permissionKey(key: string, permission: () => PermissionKeys) {
  return (target: EditorView): boolean => {
    const open = permission();
    const decided = permissionAction({ key, shiftKey: false }, open.context(target.composing));
    if (decided === undefined) return false;

    switch (decided.action) {
      case "deny":
        open.deny();
        return true;
      case "previous":
        open.move(-1);
        return true;
      case "next":
        open.move(1);
        return true;
      case "pick":
        open.pick(decided.row ?? 0);
        return true;
      case "commit":
        open.commit();
        return true;
    }
  };
}

function enquiryKey(key: string, enquiry: () => EnquiryKeys) {
  return (target: EditorView): boolean => {
    const open = enquiry();
    const decided = enquiryAction({ key, shiftKey: false }, open.context(target.composing));
    if (decided === undefined) return false;

    switch (decided.action) {
      case "back":
        open.back();
        return true;
      case "previous":
        open.move(-1);
        return true;
      case "next":
        open.move(1);
        return true;
      case "toggle":
        open.toggle();
        return true;
      case "pick":
        open.pick(decided.row ?? 0);
        return true;
      case "commit":
        open.commit();
        return true;
    }
  };
}

function menuKey(wanted: MenuAction, menu: () => MenuKeys) {
  return (target: EditorView): boolean => {
    const open = menu();
    const action = menuAction(
      { key: KEY_OF[wanted], shiftKey: false },
      { open: open.active, composing: target.composing },
    );
    if (action !== wanted) return false;

    switch (wanted) {
      case "dismiss":
        open.dismiss();
        return true;
      case "previous":
        open.move(-1);
        return true;
      case "next":
        open.move(1);
        return true;
      case "complete":
        return open.complete();
      case "submit":
        return open.submit();
    }
  };
}

/** The key each action is bound to, so `menuAction` decides rather than being told twice. */
const KEY_OF: Record<MenuAction, string> = {
  dismiss: "Escape",
  previous: "ArrowUp",
  next: "ArrowDown",
  complete: "Tab",
  submit: "Enter",
};

export function editableFor(disabled: boolean): Extension {
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
   * Flow performs it, and it never reaches a model. Purple is a Skill: the backend expands it,
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
  /*
   * The transcript's code span, copied rather than approximated — `markdown.tsx` renders
   * `rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]`, and anything close-but-different here
   * would be the same disagreement in a smaller font. These two want to move together; if that one
   * changes, this one has to.
   */
  ".gh-md-code": {
    // `rounded` is 0.25rem, not the `--radius` scale; `--font-mono` is a real token here and is
    // rewritten at runtime from the font settings, so this follows those without being told.
    borderRadius: "0.25rem",
    backgroundColor: "var(--muted)",
    padding: "0.125rem 0.25rem",
    fontFamily: "var(--font-mono)",
    fontSize: "0.9em",
  },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  "&.cm-editor .cm-selectionBackground, ::selection": { backgroundColor: "var(--accent)" },
});

/**
 * The placeholder, for the compartment that owns it.
 *
 * Exported so the component reconfigures through the same call the builder installed, rather than
 * reaching for `placeholder()` itself — which is how one ended up installed twice.
 */
export function hintFor(placeholder: string): Extension {
  return placeholderExtension(placeholder);
}
