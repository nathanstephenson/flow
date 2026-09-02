# Projects are opted into, and discovery only suggests

`projects.include` in config.json is the Projects list, and nothing else produces a Project a client
will offer. This revises ADR 0010, which had the Project Root walk *be* the list: that walk still
runs, but what it produces is now a Candidate — something the Settings page offers to opt into — and
a Candidate is not offered as a Scope until it appears in `include`. The reason is the one thing the
earlier design got wrong about how a workspace actually looks: a root full of repositories is mostly
repositories nobody is working on today, so a list that grows by itself grows into noise, and the
dropdown that was meant to save you from typing a path becomes something you scroll. Curation is
what keeps it short, and the file is where curation has to live because it has to survive a restart.

The alternative was to keep discovery as the list and add an exclude list. It was rejected because
the two are not symmetrical in effort: excluding is work proportional to what you do *not* care
about, which is unbounded and grows every time you clone something, whereas including is work
proportional to what you do care about, which is small and stops. It also fails quietly in the wrong
direction — a newly cloned repository appears in the dropdown until someone remembers to exclude it,
so the default is always noise.

**Opting in also removes the reason a Project had to be a repository.** ADR 0010 used `.git` as the
marker because a walk has to guess, and a repository is the best available guess at "somewhere work
happens". An entry in `include` is not a guess, so nothing checks it: `notes` is a Project if you
say it is. The `.git` rule survives only where guessing is still required, which is the Candidate
walk. This is why the glossary now carries **Candidate** as its own term — the distinction between
"found" and "chosen" is the whole of this decision, and one word covering both would collapse it
within a week.

Discovery being only a suggestion is also what makes the walk's cost stop mattering, and that in
turn licenses the search that follows. `searchDirectories` deliberately does *not* stop at
repositories, because the directory most worth opting into is often the one the Candidate walk
refuses to offer — `mono/packages/api`, which ADR 0010 named as a cost it was accepting and which is
now simply reachable. Not stopping at repositories means the name blacklist that ADR 0010 was proud
of avoiding is unavoidable after all, so `NEVER_OFFERED` exists and is kept to directories that are
machine output in every ecosystem. That is a real regression in tidiness, taken deliberately: a list
of eight names is a smaller cost than a monorepo being unreachable.

There are two searches behind one endpoint, and the query's first character chooses. A query
starting with `/` or `~` is a path, and the answer is completion — the children of the deepest
directory that exists, one `readdirSync`, anywhere on the machine. Anything else is a name, and the
answer is a bounded fuzzy walk beneath the Project Root. The rule is the first character rather than
"does it contain a slash", so that `work/api` still reads as a name and still narrows; and a name is
matched against the directory's own name while a slashed query is matched against the whole relative
path, because matching a bare name against the path drags in every descendant of a hit, which is
noise dressed as thoroughness. Two behaviours in one field is a cost, and the field labels which one
is running rather than leaving it to be inferred.

`GET /api/directories` is the first endpoint whose whole job is to read outside the state root, and
it enumerates the filesystem to whoever holds the token. That is not a new privilege — ADR 0004
already has it that anything able to reach this daemon can run commands as this user, so a directory
listing is strictly less than what a Shell already grants — but it is worth saying out loud rather
than discovering later: it returns directory names only, never file contents, and never follows a
symlink. It is a query rather than state, which is why it is not part of /api/config: it changes on
every keystroke, and none of its answers are worth folding into the document every other client
polls.

`include` **replaces** on a PUT where every other Setting merges, because merging a list has no
meaning anyone would predict — a removal would be indistinguishable from an omission — so a client
sends the whole list it means to end up with. An entry may be relative to the Project Root or
absolute, and both resolve to the same thing; the Settings page writes relative where it can purely
so that config.json stays legible to whoever opens it next, and because a relative entry survives
the root being moved, which is most of what having a root is for. A Project whose directory has
since gone is reported with `missing` rather than dropped, because a curated list going stale is
worth being told about: silently omitting a repository you deleted looks exactly like the Setting
having failed to save, and only one of those is worth acting on.

The consequence worth stating plainly is that **every existing installation with a Project Root
loses its dropdown until it curates one.** That was chosen over the gentler reading — an empty
`include` meaning "offer everything" — because that reading makes empty and all-of-them the same
state, so there would be no way to say "offer nothing" and no honest way for the Settings page to
describe what the list means. The cliff is softened where it is actually met: with candidates found
but nothing opted in, the New Agent Session dialog says how many are waiting and where to opt in,
because otherwise the way to turn the picker on would be discoverable only by reading a settings
page on a hunch.
