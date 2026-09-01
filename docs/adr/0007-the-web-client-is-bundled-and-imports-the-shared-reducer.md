# The web client is bundled and imports the shared reducer directly

The browser client is a Vite and React application in `web/`, and it imports `src/client/reduce.ts`
as TypeScript rather than being served that file with its types stripped. The build output is
embedded in `src/web/assets.generated.ts` as a manifest the Session Host serves from memory, with an
SPA fallback for deep-linked Agent Sessions, behind the same token gate as the API. `src/client/`
correspondingly stops being only the shared reducer and becomes the shared front-end core, holding
the transport and the presentation logic both clients need. Everything there stays free of DOM
types, because the terminal client compiles it under a configuration that has none — which is what
keeps the boundary honest about what is genuinely shared rather than merely colocated.

The arrangement this replaces worked because the shared modules imported only types, so erasing them
left standalone ESM the browser could run unbundled. That property was load-bearing and it was also
a ceiling: it capped the web UI at hand-written DOM calls and forbade any shared module from
importing a value, which is why `src/client/diff.ts` compares lines naively. Serving React from a
CDN over an import map was rejected because the single-executable build must embed everything it
serves. Leaving `src/web/assets.generated.ts` untracked was rejected because `src/daemon/server.ts`
imports it statically, so a fresh clone would not typecheck until someone had run a bundler.

The cost is that drift changes shape rather than disappearing. Two reducers diverging is now
impossible for the compiler's reasons rather than a test's, and presentation logic that had already
drifted unnoticed — the context-usage label was worded differently in each client, and only one
defended against an empty title — is shared for the first time. What is new is staleness: the
manifest is a committed build output, so nothing at runtime proves it came from today's reducer.
Three things stand in for the test that used to execute the served bytes. The build refuses to emit
a bundle whose module graph lacks `src/client/reduce.ts`; the generated module carries a hash of
every input, `src/client/` included, that a test recomputes; and CI rebuilds and refuses a dirty
diff, the only one of the three that does not depend on remembering a command. A browser-driven test
of the shipped bundle is the remaining gap, and it is deferred rather than solved.

Two consequences contradict things written elsewhere. The embedded module grows about sevenfold,
from 28 kB to 198 kB with React alone and further as the component set lands — a rounding error
against the binary, which is dominated by the copy of `node` it is injected into, but enough to make
it the largest tracked file in the repository. And the lockfile gains per-platform native bindings,
which is what `scripts/build-binary.mjs` chose `esbuild-wasm` to avoid; it already carried them for
both agent SDKs, so that comment was defending a property the tree had lost.
