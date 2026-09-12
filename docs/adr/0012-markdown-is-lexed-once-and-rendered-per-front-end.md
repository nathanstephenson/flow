# Markdown is lexed once and rendered per front-end

Model output is markdown, and both clients printed it as its own source — asterisks, backticks and
all. `src/client/markdown.ts` now lexes it into a token tree, and each front-end renders that tree
with its own elements. The dependency is `marked`, but only `marked.lexer()` is ever called; nothing
in the tree ever becomes an HTML string.

That is the decision, and it is the surprising part. The parser half of a markdown library exists to
produce HTML, and HTML is the one representation a Presentation Transcript cannot be built from. Two
existing properties forbid it. Search highlighting wraps matches in `<mark>` at the leaf text nodes,
which a string has none of, so the transcript's find would have had to become a string operation over
generated markup. And the transcript deliberately contains no `dangerouslySetInnerHTML` anywhere, so
adopting HTML output would have meant introducing one and then defending a sanitiser forever. Owning
the render instead makes the safe behaviour structural rather than filtered: raw HTML a model emits
arrives as a text token and is displayed as the characters it is, so there is no path by which
`<script>` becomes a script. Link hrefs are checked against an allowlist of `http`, `https` and
`mailto` for the same reason, and a rejected link falls back to showing its own source rather than a
label that hides where it pointed. Images from a Presentation Transcript are not fetched — a remote image in a transcript is
a tracking pixel with extra steps.

The pull request view opts into images for descriptions and discussion. It uses the same token tree,
with repository-relative links and image paths resolved against the source branch. Markdown images
and standalone GitHub `<img>` tags supply only a checked HTTP(S) source and alt text; arbitrary HTML
and attributes remain inert. The browser loads images without a referrer. This does not enable images
in a Presentation Transcript.

`react-markdown` was the obvious alternative and was rejected on the highlighting. Its `components`
map is keyed by HTML element name and does not expose text nodes, so marking search hits would have
required a bespoke rehype plugin walking the tree and splitting text nodes anyway — the work this
approach does explicitly, but buried under a pipeline that reruns in full on every streamed tick, and
paid for with the rest of the unified stack. Hand-writing a parser was rejected in the other
direction: it is genuinely small until nested lists and GFM tables, which models emit routinely.

The tree lives in `src/client/` rather than in `web/` because ADR 0007 puts the presentation rules
both clients must agree on there, and what markdown means is one of those. The cost is that `marked`
is a runtime dependency of the daemon and the CLI, not a bundler-only one, since `src/client/` is
imported by a process that runs unbundled. It carries no transitive dependencies and no native
bindings, which is what makes that acceptable — ADR 0007 already records the lockfile's per-platform
bindings as a regret, and this does not add to them.

Rendering is live while a message streams, so a half-written `**bold` shows its asterisks until the
closing pair arrives and then snaps. The alternative — plain text until `final`, then a rendered
swap — was rejected because it withholds the structure during the only period anyone is watching it
form, and reflows the whole message in one jump at the end. Suppressing unclosed markers to hide the
snap was rejected as displaying something other than what the model sent, which is what ADR 0001
exists to prevent.

One inconsistency is accepted rather than solved. `entryMatches` filters entries on the raw markdown
while `<Highlighted>` marks within rendered text, so a query spanning a syntax boundary keeps an
entry visible without visibly marking anything in it. Reconciling them means matching over a
flattened rendered string and mapping offsets back into the tree, which is disproportionate for a
filter box.

The TUI still prints raw markdown. It has the tree available and the reason it does not yet consume
it is that a terminal renderer is a separate problem — wrapping inside inline runs, ANSI weights,
framing a code block in a character grid — not an oversight in this decision.
