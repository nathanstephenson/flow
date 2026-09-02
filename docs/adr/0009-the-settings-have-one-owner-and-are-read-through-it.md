# The Settings have one owner and are read through it

`<stateRoot>/config.json` holds the Settings — the retention window and the two typefaces — and one
object owns it: `ConfigStore` in `src/daemon/config-store.ts`. Nothing is handed a copy at startup.
The reaper asks for the retention window at each sweep, `GET /api/config` asks for the Settings on
each request, and `PUT /api/config` writes through the same object. This is what makes the web UI's
Settings page work on a daemon that has been up for a week: previously `main.ts` read the file once
and passed `config.retention.settled` into the `SessionHost` constructor and `config.fonts` into
`serve()`, so an edit could only reach the *next* daemon.

`SessionHost` still knows nothing about config.json. Its `retention` option accepts a function as
well as a value, and the daemon passes `ConfigStore.retention`; the tests pass a literal. The
alternative — giving the host the store — would have made the object that owns Agent Sessions the
owner of a typeface, which its glossary definition does not cover. The alternative in the other
direction, an `onChange` observer calling `host.setRetention()` in the shape the Shell work
introduced, was rejected because it puts the current window in two places at once, and the failure
that produces is silent.

**Reading is lenient; writing is strict.** A value in the file that cannot be used costs only its own
default and warns on startup, because a typo must not stop the daemon that owns your Presentation
Transcripts from starting, and because each section is parsed independently a bad one cannot cost the
others. A value arriving on `PUT` is refused with a 400 naming the field, and nothing is written.
That asymmetry is the whole design: there is a person waiting on the other end of a PUT who can fix
it, and a settings page that reports success while quietly keeping the old value is worse than one
with no save button. It is also why `PUT` refuses a field it does not recognise rather than ignoring
it — a Setting that reports success and does not stick is indistinguishable from a broken daemon.

Writes are read-modify-write against the file, not against the in-memory Config, and land via a
temporary file renamed over the target. Merging with the file preserves a key no version of this
daemon has heard of, so someone who hand-wrote a field we do not parse yet does not lose it by
changing a font in a browser — a different question from refusing an unknown field over the wire,
where keeping a stranger's key is courtesy and accepting a client's is a bug. The rename matters
because `loadConfig` treats an unreadable file as "use the defaults", so a crash mid-write would
otherwise silently reset every Setting on the next start.

Durations cross the wire as the strings they were written as — `"1d"`, not `86400000` — because a
duration is something a person typed and has to read back. `parseDuration` and `formatDuration` live
in `src/protocol/settings.ts` rather than beside the parser that uses them, because the browser needs
them too and cannot import a module that reads a file: the Settings page uses `parseDuration` to work
out what a window the reader has typed would reap, before they commit to it.

That count is computed client-side, which is the one place this design accepts a duplicated rule. A
`SessionSummary` already carries `status` and `updatedAt`, which is the whole of what `SessionHost.reap`
compares, so `web/src/presentation/reapable.ts` can answer "how many Agent Sessions does this window
newly reach" without a second endpoint whose only job is to count. Its tests restate the reaper's two
rules — only Settled Agent Sessions, and an unreadable timestamp is left alone — so the copy cannot
drift unnoticed. Saving a shorter window still deletes nothing on its own: the hourly sweep does it
(ADR 0006), and the page says so rather than implying the Save button is the destructive act.
