# Shells speak WebSocket, and a Scrollback is not a Presentation Transcript

An Agent Session can be given a Shell: a pty the Session Host owns, spawned in the Agent Session's
Scope and drawn in the browser by Ghostty compiled to WebAssembly. It is off by default and opened
on request. Its bytes cross a WebSocket at `/api/shells/:id/stream` — binary frames for output and
keystrokes, text frames for resize and exit — behind the same cookie and the same strict Origin
check as everything else.

That contradicts the reasoning `src/daemon/server.ts` gives for choosing SSE, so it is worth being
precise about why. Those reasons were about the Presentation Transcript: one-directional,
sequence-numbered, and reconnectable with `?since=N` because a replay is not a resynchronisation.
None of it holds for a Shell, which is bidirectional, carries raw bytes with no sequence to resume
from, and would otherwise have to base64 every byte of a build log through JSON to fit in an event
stream. It also spends a connection against the browser's six-per-origin limit that the transcript
already needs. The transcript stays on SSE; the Shell alone is upgraded, and `ws` is the third
runtime dependency this project has taken.

A Shell is addressed by its own id and not as `/api/sessions/:id/shell`. It is *associated* with an
Agent Session — that is how a client finds it, and Settling, Ending or Reaping the Agent Session
exits it — but it is not identified by one, because an Agent Session may own several. The singular
path would have had to be broken to admit the second. Its `cwd` is seeded from the Scope and then
never touched, so a reader may `cd` freely; a Shell that silently followed the Scope would undo
what they typed.

Several is what the client now shows. A Shell is one tab of a **Dock** — the tabbed, resizable,
minimisable region below the Presentation Transcript or beside it (`web/src/presentation/docks.ts`),
of which there are two per Agent Session. A Dock's tabs are client state rather than the host's:
they are reconciled against `GET /api/shells?sessionId=` on arrival at an Agent Session and not
trusted before that, because a stored Shell id is a corpse after a daemon restart, while deriving
the tabs from the host outright could not represent a tab whose content nobody has chosen yet. Dead
tabs are dropped and live Shells no tab claims are adopted, so a Shell opened in a second browser
window is not invisible in the first.

Closing a tab therefore kills its Shell: `DELETE /api/shells/:id`, at once, with no confirmation.
This decision used to be the opposite one — closing the pane detached, on the grounds that a stray
click should be survivable while `npm run dev` is running in it — and tabs are what retired that
reasoning. A tab is a Shell's only handle, so a tab that merely hid one would leave a pty running
with nothing on screen pointing at it, and the Shells a reader could not see would soon outnumber
the ones they could. What survives is minimising the Dock, which closes every socket in it and
leaves every pty alive: the detach is still there, on the control whose job is hiding rather than
ending.

Detaching then reattaching to a live pty means the client arrives mid-stream with an empty screen,
so the host keeps a bounded ring of each Shell's most recent output and replays it on attach. That
ring is a **Scrollback** and it is emphatically not a Presentation Transcript (ADR 0001): it is
capped at 256 KiB, it is trimmed from the front, a full-screen program overwrites it rather than
appending to it, and it is never written to disk. Conflating the two would put a lossy screen buffer
behind the guarantee that the record of what a human saw is never rewritten.

Two costs are taken deliberately. The pty is a native addon and a SEA blob cannot contain one, so
`scripts/build-binary.mjs` externalises `node-pty` beside `koffi` and the binary must find it on
disk instead. The `import()` it keeps resolves against the path baked in at build time, which means
the binary loads a pty on the machine that built it and finds nothing on the machine it is shipped
to — so this is a degradation to be handled, not a configuration to rely on. The import in
`src/daemon/shell.ts` is lazy and its failure surfaces as `shell: false` on `/api/config`, and the
web client hides the control rather than offering one that breaks — the rule Capabilities already
sets for backends. `test/shell.test.ts` exercises that path through an injected loader, because the
alternative way to assert it is to uninstall a dependency. And the embedded asset manifest roughly quadruples, from 526 kB to 2.1 MB, since it
now carries a 423 kB WASM terminal emulator and the JavaScript around it; ADR 0007 already noted
that file was the largest tracked one in the repository, and this makes it decisively so.

No separate flag gates the Shell, on loopback or off it. ADR 0004 already establishes that reaching
this host means running commands as the user who started it — tools are pre-approved, so anyone
holding the token can simply ask the agent to run Bash. A Shell is a convenience on top of an
existing capability rather than a new one, and a flag implying otherwise would advertise a boundary
that is not there.

The TUI gets no equivalent, and that is a deliberate asymmetry in a project whose premise is that
its two front-ends do not drift. The TUI is already running inside a terminal; the shell it would
give you is the one you launched it from.
