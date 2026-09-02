# Projects are discovered beneath a configured Project Root

_Revised by ADR 0011: the walk described here still runs, but what it finds is now a
Candidate to be opted into rather than a Project in its own right._

`config.json` gains one leaf, `projects.root`, and everything else about Projects is derived from
walking it: a directory holding a `.git` is a Project, a directory that merely holds Projects
becomes a heading, and `src/daemon/projects.ts` owns the walk. Previously the only way to say where
an Agent Session should run was to type an absolute path into the New Agent Session dialog,
prefilled with whatever directory the daemon happened to be launched from — so the Scope was either
recited from memory or accidental. The alternative, a declared `projects: [{ name, path }]` array,
was rejected because it makes cloning a repository a two-step operation and because nesting would
then have to be spelled out by hand; discovery is what makes `<root>/work/repo-a` group under "work"
with nothing configured. Its cost is that a Project cannot live outside the root, which is what
keeps the Scope field editable rather than replacing it with a dropdown.

**A repository is a leaf: recorded, never looked inside.** That single rule is the whole pruning
strategy, and it is why there is no list of directory names to ignore — `node_modules`, `dist`,
`.venv` and `target` are all inside a repository by construction, so nothing has to know their
names, and no such list would ever be finished. It also decides the monorepo question against
convenience: `<root>/monorepo/packages/api` is not offered, and the Scope field is how you get
there. Descending past a repository was the alternative, and it was rejected because it cannot be
done without exactly the blacklist this rule exists to avoid. `.git` is tested as a path that
*exists* rather than as a directory, because in a linked worktree or a submodule it is a file
holding a `gitdir:` pointer, and treating those as ordinary directories would walk into them.

The walk is bounded three ways — three levels below the root, no hidden directories, no symlinks —
and then bounded a fourth time by a budget of directories visited. The first three are about what a
Project *is*; the fourth is about what happens when someone sets the root to `/`, where three levels
is tens of thousands of directories. That budget is what makes the synchronous `fs` here defensible
rather than merely conventional, because this runs inside a request handler: without it, async would
be the only honest choice. Symlinks are refused rather than deduplicated because a loop is the one
input that would otherwise not terminate.

**The Project Root is a Setting; the Projects beneath it are not.** `/api/config` reports
`projects.root` inside the Settings and the discovered list beside them as `projectList`, walked
fresh on every request. Folding the list into `Settings` was the obvious tidier shape and was
rejected: `settingsOf()` is deliberately one function serving both the file and the wire so that a
GET cannot report something config.json does not hold (ADR 0009), and derived state inside it would
end that guarantee. Caching the walk was rejected for a plainer reason — cloning a repository
changes the answer without changing the file, so a cache would need a filesystem watcher to
invalidate it, which is real complexity bought in order to be more often wrong. Uncached is also
what lets the dialog re-ask on open, so a repository cloned five minutes ago is in the list without
a reload.

The root crosses the wire as the string it was typed as, `~/workspace` and not the expanded path,
and is expanded only at the point of use by `expandHome`. This is the same round trip a duration
makes and for the same reason: it is a value a person wrote and has to be able to read back, so
`ConfigStore` offers `view().projects.root` for the Settings page and `projectRoot()` for the walk.
**Existence is deliberately not validated.** A root that is not there is accepted, and the Settings
page reports "no Projects found beneath …" — which distinguishes nothing from a typo better than a
400 would, and keeps `applyPatch` a pure merge with no filesystem I/O in it. An empty string is the
one value that clears the Setting, which means `ConfigStore.update` has to *delete* the section
rather than merely not write it: the read-modify-write that preserves a stranger's hand-written key
would otherwise preserve a Project Root that was just cleared.

Two front-end consequences are worth naming because both change existing behaviour. The web client's
default Scope becomes the Project Root, resolved in the request handler rather than in `main.ts`,
since computing it at startup is precisely the bug ADR 0009 exists to prevent. And the New Agent
Session dialog now prefills *nothing* when Projects are on offer, moving initial focus from the
Start button to the Project picker: `n` then Enter used to start an Agent Session in the daemon's
launch directory, and `n`, a few letters, Enter, Enter now starts one somewhere chosen. Where a host
offers no Projects the old dialog is kept exactly, prefill and focus included, because an empty
field with nothing to choose from would be strictly worse than what it replaced.

`goodharness tui` reads the Project Root too when `--scope` is absent, which required removing
`parseArgs`' `default: process.cwd()` — with it, an absent flag and a typed one were
indistinguishable and the root had nowhere to sit between them. It reads the file directly rather
than asking the daemon, because the TUI may be attached to one it did not start and that daemon's
`/api/config` falls back to *its* working directory, which is not this reader's. A one-shot
`goodharness "<prompt>"` keeps `process.cwd()`: it is run in a directory, and binding it to the
Project Root instead would silently move a common workflow up a level. So the asymmetry here is not
the usual one — the TUI is not left behind, it simply has a cwd of its own that the browser does
not, and the Projects list itself stays a web-only affordance because a picker in the TUI would mean
a fourth `Overlay` kind for a client already running in the directory you want.
