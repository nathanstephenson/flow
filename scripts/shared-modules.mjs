/**
 * The modules the web app must be built from rather than reimplement. Asserting this at build time
 * is stronger than a test because it cannot be skipped: build:binary -> prebuild:binary ->
 * build:web -> here. You cannot produce a binary whose bundle was not built from the shared reducer.
 *
 * The list is the modules the web app is *currently* built from, not every module in src/client/. It
 * can only name what the bundle actually imports, so a shared module the web app does not use yet
 * cannot be asserted here. As of the redesign that is all of them: the reducer and the transport, the
 * diff and the relative time both front-ends print, and the presentation rules they must agree on —
 * which status permits which action, which models and Effort levels a backend offers, how the
 * Conversation Context is labelled, what to call an Agent Session with no title, what a search looks
 * at, and how a tool call's arguments are précised.
 *
 * It lives here rather than in the manifest so that a test can exercise assertSharedModules() itself
 * without a bundle to hand. The check is the guarantee; the list was only ever its input.
 */
export const SHARED_MODULES = [
  "src/client/connection.ts",
  "src/client/context-usage.ts",
  "src/client/diff.ts",
  "src/client/markdown.ts",
  "src/client/model-choices.ts",
  "src/client/reduce.ts",
  "src/client/relative-time.ts",
  "src/client/search.ts",
  "src/client/session-label.ts",
  "src/client/status.ts",
  "src/client/tool-summary.ts",
];

/** Throws unless every shared module is in the built bundle's module graph. */
export function assertSharedModules(graph) {
  for (const module of SHARED_MODULES) {
    if (!graph.has(module)) {
      throw new Error(`the web bundle does not contain ${module}; the two front-ends would drift`);
    }
  }
}
