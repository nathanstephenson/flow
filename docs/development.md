# Development

## Setup and checks

```bash
npm install
npm run typecheck   # four programs: host, web presentation logic, web app, its Vite config
npm test
npm run spike:auth   # verify subscription auth again
npm run test:oidc-issuer -- http://127.0.0.1:5173  # local standards test Provider
```

Do not install with `npm ci --omit=optional`. Rolldown, lightningcss and esbuild get their native
bindings through optional dependencies. If you omit them, the install succeeds, but the build fails
with an unclear "cannot find native binding" error.

To run Flow from source:

```bash
npm start -- --backend claude "Use Glob to list *.json here, then say DONE"
```

## Tests

| Command | Adds |
| --- | --- |
| `FLOW_ASSETS=1 npm test` | A Vite build, to prove the embedder handles everything that it emits. |
| `FLOW_E2E=1 npm test` | The live Claude contract. This spends tokens. |
| `FLOW_E2E_PI=1 npm test` | The live pi contract. This needs pi credentials. |
| `FLOW_MCP_STRESS=1 node --test --experimental-strip-types test/mcp-buffered-exit.test.ts` | Four rounds of 32 concurrent MCP clients. |

These optional checks stay out of the default loop. The normal MCP reply tests force exit-before-read
ordering and check actual pipes with two clients. Large stress runs are not a required validation check.

`npm test` must need no credentials, no network and no bundler. So a fresh clone with no `web/dist`, and an `--omit=dev` install with no Vite, still
pass. This is true by construction: no test reads a build output. Tests about serving a web client
get a fixture (`test/assets-fixture.ts`).

`test/backend/pi-mapping.test.ts` covers the pi translation without credentials. It includes a
regression test: Flow always sends `streamingBehavior: "steer"` and never touches pi's native
follow-up queue.

## CI

CI (`.github/workflows/ci.yml`) runs the typecheck, the tests and the binary build. There is no
rebuild-and-diff step, because nothing generated is committed. The binary build proves that the web
client can still be built and embedded.

## TypeScript rules

Node runs sources under `src/`, `test/` and `web/src/presentation/` with
`--experimental-strip-types`.

- Use only erasable syntax: no parameter properties, enums or namespaces.
- Relative imports carry the `.ts` extension. The build rewrites them.
- The rest of `web/` is built by Vite and does not have this limit.
- `src/client/**` keeps this limit, even when it is browser-facing, because the TUI runs it
  stripped.
- Code in `src/client/` must not use DOM types, because the TUI compiles it in a program that has
  none.

## Web client development

The web client needs a Session Host. Start the host first:

```bash
npm start -- serve --port 4318   # terminal one: the Session Host
npm run dev                      # terminal two: Vite on 127.0.0.1:5173
```

- The dev server finds the host through `daemon.json`, or through `FLOW_URL` if you set it.
- It reads that target once, at startup. So give the host a fixed `--port`, not the default
  ephemeral port.
- It proxies `/api`, `/auth` and `/oauth`, so the browser stays on one origin. Because of this, the
  Session Host can check `Origin` strictly, with no CORS.

**Do the cookie handoff on the URL that the dev server prints**, not the URL that the host prints.

- `localhost`, `127.0.0.1` and `[::1]` are three different cookie hosts on one machine. A cookie
  from the host's URL is not sent to the dev origin, which then answers 401.
- `/auth` redirects to a relative `/`, which makes it work through a proxy. So the host's own URL
  takes you to the built client, not to the dev server with your unbuilt changes.

[CLAUDE.md](../CLAUDE.md) describes how to run an isolated host for screenshots.

### How the web client is served

The Session Host serves assets from a manifest in memory. So a single executable does not need
files on disk at runtime.

- Nothing generated is committed. `src/web/embedded.ts` exports an empty manifest. `npm run
  build:binary` replaces it at bundle time.
- A source run builds `web/dist` (`prestart`) and reads it through the same `manifestOf()` that the
  binary build uses (ADR 0017).
- If there is no build, the host refuses to start. It does not silently serve nothing.
- Content-hashed assets are served `public, max-age=31536000, immutable`.
- The Entry Document is served `no-store`. An immutably cached Entry Document would pin a browser to
  a deleted asset hash.
- An unknown path gets the Entry Document, so a deep-linked Agent Session survives a reload. `/api`
  and `/assets` are excluded, because a missing hashed chunk answered with HTML is hard to diagnose.

### The rail: implementation notes

- The drag does not go through React. It writes `--sidebar-width` on the provider wrapper, and
  commits to state once, on release. Through state, the rail and the transcript rendered again on
  each frame. Also, shadcn's `transition-[width] duration-200`, which the open and close slide
  needs, made the rail follow the pointer two frames late. `data-resizing` on the wrapper stops
  that transition during the gesture only.
- The width is remembered in `localStorage`. The open state is not. A reload into an app with no
  visible navigation is a bad first frame. Hiding the rail is a temporary request for width, not a
  preference. So both are browser state, never a Setting. A Setting would make a laptop and a
  desktop fight over one number.
- ⌘B matches shadcn's Sidebar binding. But `web/src/presentation/bindings.ts` resolves it, like
  every other key. The component's own `window` listener is removed. See the FLOW note in
  `web/src/components/ui/sidebar.tsx`.

## Single executable

```bash
npm run build:binary
```

This makes `build/flow`: an esbuild bundle injected into a copy of the `node` binary through Node
SEA. `prebuild:binary` builds `web/dist`, and the binary build turns it into the manifest that it
injects.

- **Claude Code is a prerequisite, not part of the binary.** The Agent SDK starts the Claude Code
  CLI as a child process. A child needs a real file on disk, which a SEA blob cannot supply. Install
  it separately:

  ```bash
  npm i -g @anthropic-ai/claude-code
  ```

  The binary finds `claude` on `PATH`, or at `FLOW_CLAUDE_PATH`. Source runs do not need this: the
  SDK finds its own copy.
- **pi is not in the binary.** The binary is Claude-only unless pi is installed next to it. If you
  ask for a pi session without pi, you get a clear error.
- **Shells need `node-pty` on disk.** See [operating-the-host.md](operating-the-host.md#shells).
- **macOS needs the Xcode command line tools.** Injection makes the `node` code signature
  invalid. So the build removes the signature, injects into a `NODE_SEA` Mach-O segment, then signs
  again ad hoc. Without this, the kernel stops the binary with SIGKILL at launch and prints only
  `killed`.

[milestones.md](milestones.md#m5-single-executable) records the build problems that were solved.

## Package and releases

### Check a release from source

```bash
npm ci
npm run test:package
```

This builds, packs and installs the archive into a temporary prefix. It then checks the install
from an unrelated directory. Build outputs are not tracked in Git.

### First release

Publish the first version manually, from a clean and tested `main` checkout. Choose a license first.

```bash
npm ci
npm run test:package
npm login
npm publish --access public
```

Then configure npm Trusted Publishing:

- owner `nathanstephenson`,
- repository `flow`,
- workflow filename `publish.yml` (GitHub Actions),
- direct `npm publish` allowed.

No npm token secret is used.

### Later releases

1. Through a PR, update the version in `package.json` and both version fields in the lockfile.
2. Merge the PR.
3. Push a matching stable tag, for example `v0.1.1`, on that `main` commit.

The publish workflow:

- rejects tags outside `main`, prerelease tags and mismatched versions,
- builds and tests one archive without publishing credentials,
- publishes that exact archive with OIDC and provenance.

Protect `main` and release-tag creation in GitHub. Tag creation is the release approval. Do not tag a
version until its license and release contents are approved.
