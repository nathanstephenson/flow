import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { readOrCreateToken } from "../src/daemon/auth.ts";
import { ConfigStore } from "../src/daemon/config-store.ts";
import {
  DEFAULT_CHROME_FONT,
  DEFAULT_MONOSPACE_FONT,
  DEFAULT_SETTLED_RETENTION,
  formatDuration,
  parseDuration,
} from "../src/daemon/config.ts";
import { FakeBackend } from "../src/backend/fake/index.ts";
import { SessionHost } from "../src/daemon/host.ts";
import { serve, type RunningServer } from "../src/daemon/server.ts";
import type { DirectoryMatches, Project } from "../src/protocol/projects.ts";
import type { Settings } from "../src/protocol/settings.ts";

/**
 * The Settings, from the file up to the wire.
 *
 * Two rules carry most of this: reading is lenient and writing is strict, and there is exactly one
 * copy of a Setting in the process. The second is why the reaper is handed `ConfigStore.retention`
 * rather than a number — the test at the bottom is the one that would catch a regression to a
 * snapshot, which would present as "my change only applies after a restart".
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("the Settings on disk", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "flow-settings-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const file = (): Record<string, unknown> =>
    JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as Record<string, unknown>;

  it("reports the defaults when there is no file, in the units a person typed", () => {
    const store = new ConfigStore(root);
    assert.deepEqual(store.view(), {
      retention: { settled: "1d" },
      fonts: { chrome: DEFAULT_CHROME_FONT, monospace: DEFAULT_MONOSPACE_FONT },
      // No `projects` key, deliberately: unlike a retention window and a typeface, a Project Root
      // has no right answer for a machine nobody has configured, so it is absent rather than
      // defaulted. This deepEqual is what holds that decision in place.
    });
    assert.equal(store.warning, undefined, "an absent file is normal, not a warning");
  });

  it("writes a patch through and reports the merged result", () => {
    const store = new ConfigStore(root);
    const updated = store.update({ fonts: { monospace: "'Hack Nerd Font', monospace" } });

    assert.equal(updated.fonts.monospace, "'Hack Nerd Font', monospace");
    assert.equal(updated.fonts.chrome, DEFAULT_CHROME_FONT, "an untouched field keeps its value");
    assert.equal(updated.retention.settled, "1d");
    // And on disk, so the next daemon agrees with this one.
    assert.deepEqual(new ConfigStore(root).view(), updated);
  });

  it("merges section by section, so saving one does not revert the other", () => {
    const store = new ConfigStore(root);
    store.update({ retention: { settled: "36h" } });
    store.update({ fonts: { chrome: "Berkeley Mono" } });

    const view = store.view();
    assert.equal(view.retention.settled, "36h", "the earlier save survived the later one");
    assert.equal(view.fonts.chrome, "Berkeley Mono");
  });

  /**
   * Someone hand-writes a key this daemon has never heard of. Editing a font in a browser must not
   * be what deletes it — a read-modify-write against the file is the only way that holds.
   */
  it("preserves a key it does not know about", () => {
    writeFileSync(join(root, "config.json"), JSON.stringify({ experiment: { widgets: 3 } }));
    new ConfigStore(root).update({ fonts: { chrome: "Berkeley Mono" } });

    assert.deepEqual(file().experiment, { widgets: 3 });
  });

  it("refuses a value rather than warning and keeping the old one", () => {
    const store = new ConfigStore(root);
    assert.throws(
      () => store.update({ fonts: { chrome: "red; background: url(http://evil)" } }),
      /fonts\.chrome/,
    );
    // Nothing changed, and nothing was written: a refused patch is not a partial one.
    assert.equal(store.view().fonts.chrome, DEFAULT_CHROME_FONT);
    assert.throws(() => file(), "a refused patch must not create the file");
  });

  it("refuses a duration it cannot read, and a zero one", () => {
    const store = new ConfigStore(root);
    assert.throws(() => store.update({ retention: { settled: "1 fortnight" } }), /duration/);
    // Zero parses, and would reap every Settled Agent Session on the next sweep. "never" is how you
    // say "do not reap"; zero is how you say it by accident.
    assert.throws(() => store.update({ retention: { settled: "0s" } }), /longer than zero/);
    assert.equal(store.current().retention.settled, DEFAULT_SETTLED_RETENTION);
  });

  it("refuses a field it does not recognise, rather than silently ignoring it", () => {
    // A setting that reports success and does not stick is the failure this prevents.
    const store = new ConfigStore(root);
    assert.throws(() => store.update({ fonts: { serif: "Georgia" } } as never), /serif/);
    assert.throws(() => store.update({ theme: "dark" } as never), /theme/);
  });

  it("accepts 'never', which is how reaping is switched off", () => {
    const store = new ConfigStore(root);
    assert.equal(store.update({ retention: { settled: "never" } }).retention.settled, "never");
    assert.equal(store.current().retention.settled, "never");
  });

  it("keeps the Project Root as typed, and expands it only for the walk", () => {
    const store = new ConfigStore(root);
    assert.deepEqual(store.update({ projects: { root: "~/workspace" } }).projects, {
      root: "~/workspace",
    });
    // Read back as written, so the Settings page shows the reader their own tilde...
    assert.equal(new ConfigStore(root).view().projects?.root, "~/workspace");
    // ...while the thing that has to open directories is given a path the filesystem understands.
    assert.equal(store.projectRoot(), join(homedir(), "workspace"));
  });

  it("has no Project Root until one is set, and can be given one back", () => {
    const store = new ConfigStore(root);
    assert.equal(store.view().projects, undefined);
    assert.equal(store.projectRoot(), undefined);

    store.update({ projects: { root: "/srv/repos" } });
    store.update({ fonts: { chrome: "Berkeley Mono" } });
    assert.equal(store.view().projects?.root, "/srv/repos", "saving fonts did not drop it");

    // An empty string is how a form says "clear this field". It has to actually leave the file, or
    // the next start would read the old root back and the setting would appear not to stick.
    store.update({ projects: { root: "" } });
    assert.equal(store.view().projects, undefined);
    assert.equal(file()["projects"], undefined, "a cleared section must leave the file");
    assert.equal(new ConfigStore(root).view().projects, undefined);
  });

  it("refuses a Project Root it cannot use, naming the field", () => {
    const store = new ConfigStore(root);
    assert.throws(() => store.update({ projects: { root: 7 } } as never), /projects\.root/);
    // Relative would resolve against the daemon's working directory, which its reader cannot see,
    // so the same config.json would mean a different directory depending on where it was started.
    assert.throws(() => store.update({ projects: { root: "repos" } }), /must be absolute/);
    assert.throws(() => store.update({ projects: { depth: 2 } } as never), /depth/);
    assert.throws(() => file(), "a refused patch must not create the file");
  });

  it("warns and offers no Projects when the file's Project Root is unusable", () => {
    // The file's manner, opposite to the PUT above: a typo costs only the Projects, and says so.
    writeFileSync(join(root, "config.json"), JSON.stringify({ projects: { root: "repos" } }));
    const store = new ConfigStore(root);
    assert.match(store.warning ?? "", /projects\.root/);
    assert.equal(store.projectRoot(), undefined);
    assert.equal(store.view().retention.settled, "1d", "the other sections were unaffected");
  });

  it("still starts, and still says why, when the file is malformed", () => {
    writeFileSync(join(root, "config.json"), "{ not json");
    const store = new ConfigStore(root);
    assert.match(store.warning ?? "", /valid JSON/);
    assert.equal(store.view().retention.settled, "1d", "the defaults stand");
  });
});

describe("a duration round-trips", () => {
  it("comes back in the largest unit that divides evenly", () => {
    assert.equal(formatDuration(DAY), "1d");
    assert.equal(formatDuration(36 * HOUR), "36h");
    assert.equal(formatDuration(90 * 60 * 1000), "90m");
    assert.equal(formatDuration(30_000), "30s");
  });

  it("survives the trip through parseDuration, which is what the settings page depends on", () => {
    for (const ms of [1000, 30_000, 90 * 60 * 1000, HOUR, 36 * HOUR, DAY, 7 * DAY]) {
      assert.equal(parseDuration(formatDuration(ms)), ms, `${ms} did not round-trip`);
    }
  });

  it("does not pretend a sub-second value is a whole unit", () => {
    assert.equal(formatDuration(0), "0s");
    assert.equal(formatDuration(500), "0.5s");
  });
});

describe("the Settings over the wire", () => {
  let root: string;
  let running: RunningServer;
  let token: string;
  let config: ConfigStore;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "flow-settings-http-"));
    token = readOrCreateToken(root);
    config = new ConfigStore(root);
    running = await serve({ host: new SessionHost(), token, config, assets: {} });
  });

  afterEach(async () => {
    await running.close();
    rmSync(root, { recursive: true, force: true });
  });

  const put = (body: unknown): Promise<Response> =>
    fetch(`${running.url}/api/config`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const get = async (): Promise<Settings> => {
    const response = await fetch(`${running.url}/api/config`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return (await response.json()) as Settings;
  };

  const directories = async (q: string): Promise<DirectoryMatches> => {
    const response = await fetch(`${running.url}/api/directories?q=${encodeURIComponent(q)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return (await response.json()) as DirectoryMatches;
  };

  /** The whole /api/config body, which carries more than the Settings. */
  type ConfigBody = Settings & {
    scope: string;
    projectList: Project[];
    projectCandidates: Project[];
  };

  const raw = async (): Promise<ConfigBody> => {
    const response = await fetch(`${running.url}/api/config`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return (await response.json()) as ConfigBody;
  };

  it("reports the Settings alongside the rest of the config", async () => {
    const body = await get();
    assert.deepEqual(body.retention, { settled: "1d" });
    assert.equal(body.fonts.monospace, DEFAULT_MONOSPACE_FONT);
  });

  /**
   * The Project Root is a Setting; the Projects beneath it are not.
   *
   * `projectList` is derived — cloning a repository changes it without changing config.json — so it
   * sits beside the Settings rather than inside them, and is walked fresh on each request. Folding
   * it in would let a GET report something the file does not hold (ADR 0009).
   */
  it("keeps the opted-in Projects and the candidates apart", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "flow-settings-tree-"));
    mkdirSync(join(workspace, "work/repo-a/.git"), { recursive: true });
    mkdirSync(join(workspace, "work/repo-b/.git"), { recursive: true });
    try {
      assert.equal((await put({ projects: { root: workspace } })).status, 200);

      const before = await raw();
      assert.deepEqual(before.projectList, [], "nothing is a Project until it is opted into");
      assert.deepEqual(
        before.projectCandidates.map((project) => project.name),
        ["repo-a", "repo-b"],
        "both are candidates",
      );
      // The window still says it is open on the Project Root, resolved per request.
      assert.equal(before.scope, workspace);

      assert.equal((await put({ projects: { include: ["work/repo-a"] } })).status, 200);

      const after = await raw();
      assert.deepEqual(after.projectList, [
        { path: join(workspace, "work/repo-a"), name: "repo-a", group: "work" },
      ]);
      // Disjoint: an opted-in Project is no longer offered as something to opt into, compared on
      // the resolved path so that "work/repo-a" and its absolute form are the same directory.
      assert.deepEqual(
        after.projectCandidates.map((project) => project.name),
        ["repo-b"],
      );
      assert.deepEqual(after.projects?.include, ["work/repo-a"]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("searches for a directory to opt in, and says which search it ran", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "flow-settings-search-"));
    mkdirSync(join(workspace, "mono/.git"), { recursive: true });
    mkdirSync(join(workspace, "mono/packages/api"), { recursive: true });
    try {
      await put({ projects: { root: workspace } });

      // A name: fuzzy, beneath the root, and reaching inside a repository — which is the whole
      // reason this exists, since discovery will not offer `mono/packages/api`.
      const found = await directories("api");
      assert.equal(found.kind, "search");
      assert.deepEqual(found.paths, [join(workspace, "mono/packages/api")]);

      // A path: completion, anywhere on disk, root irrelevant.
      const completed = await directories("/tm");
      assert.equal(completed.kind, "completion");
      assert.ok(completed.paths.includes("/tmp"));

      assert.equal((await directories("api")).query, "api", "the query is echoed back");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("takes a patch and reports the result back", async () => {
    const response = await put({ fonts: { chrome: "Berkeley Mono" } });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as Settings).fonts.chrome, "Berkeley Mono");

    // The next GET agrees, which is only true because serve() reads through the store rather than
    // holding the copy it was handed at startup.
    assert.equal((await get()).fonts.chrome, "Berkeley Mono");
  });

  it("answers 400 with the offending field, not 500 and not a silent 200", async () => {
    const response = await put({ retention: { settled: "1 fortnight" } });
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { error: string }).error, /retention\.settled/);
    assert.equal((await get()).retention.settled, "1d", "nothing changed");
  });

  it("is behind the same gate as everything else", async () => {
    const response = await fetch(`${running.url}/api/config`, {
      method: "PUT",
      body: JSON.stringify({ fonts: { chrome: "Berkeley Mono" } }),
    });
    assert.equal(response.status, 401);
  });
});

/**
 * The reason `retention` is a function and not a number.
 *
 * The reaper is handed `ConfigStore.retention` so it asks at each sweep. Copy the value in at
 * construction instead and this test fails — which is exactly the bug a reader would report as
 * "changing retention did nothing until I restarted the daemon".
 */
describe("a retention change reaches a running host", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "flow-settings-reap-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("applies at the next sweep, without a restart", async () => {
    const config = new ConfigStore(root);
    config.update({ retention: { settled: "never" } });

    const host = new SessionHost({ retention: config.retention });
    const { FakeBackend } = await import("../src/backend/fake/index.ts");
    host.registerBackend(new FakeBackend());
    const sessionId = await host.create({ scope: root, backend: "fake" });
    await host.settle(sessionId);

    const wellPast = Date.now() + 10 * DAY;
    assert.deepEqual(await host.reap(wellPast), [], "'never' means never");

    config.update({ retention: { settled: "1h" } });
    assert.deepEqual(await host.reap(wellPast), [sessionId], "the sweep read the new window");
  });
});

describe("the Standing Authorisations", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "flow-permissions-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const file = (): Record<string, unknown> =>
    JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as Record<string, unknown>;

  it("is absent on a machine that has granted nothing", () => {
    const store = new ConfigStore(root);

    // A real state, not a defaulted value — every installation starts here, and it is what makes
    // "no Standing Authorisations" distinguishable from "an empty list somebody saved".
    assert.equal(store.view().permissions, undefined);
    assert.deepEqual(store.standingAuthorisations(), []);
  });

  it("reads a list off the file", () => {
    writeFileSync(
      join(root, "config.json"),
      JSON.stringify({ permissions: { allow: ["mcp__github__list_issues", " Bash "] } }),
    );
    const store = new ConfigStore(root);

    // Trimmed but never otherwise normalised: a tool name is an identifier the backend chose, and
    // lower-casing `mcp__gdrive__trash_file` would silently stop matching it.
    assert.deepEqual(store.standingAuthorisations(), ["mcp__github__list_issues", "Bash"]);
  });

  it("authorises nothing when the section is unreadable, and says why", () => {
    writeFileSync(join(root, "config.json"), JSON.stringify({ permissions: { allow: "Bash" } }));
    const store = new ConfigStore(root);

    /*
     * The file's lenient manner, and here it matters more than anywhere else: a malformed section
     * must cost *nothing but itself*. Falling back to anything would either authorise a tool nobody
     * granted or be read as having done so.
     */
    assert.deepEqual(store.standingAuthorisations(), []);
    assert.match(store.warning ?? "", /permissions\.allow/);
  });

  it("drops an entry that is not a tool name, and keeps the rest", () => {
    writeFileSync(join(root, "config.json"), JSON.stringify({ permissions: { allow: ["Bash", 7, ""] } }));
    const store = new ConfigStore(root);

    assert.deepEqual(store.standingAuthorisations(), ["Bash"]);
    assert.match(store.warning ?? "", /not a tool name/);
  });

  it("adds one grant at a time without erasing another", () => {
    const store = new ConfigStore(root);

    // Additive, unlike every other write on this store: `update` replaces the list wholesale, which
    // is right for a client sending the list it wants and wrong for a single click, where two
    // sessions granting different tools would each erase the other's.
    store.allowTool("Bash");
    store.allowTool("WebFetch");

    assert.deepEqual(store.standingAuthorisations(), ["Bash", "WebFetch"]);
    assert.deepEqual(file()["permissions"], { allow: ["Bash", "WebFetch"] });
  });

  it("writes nothing for a tool already granted", () => {
    const store = new ConfigStore(root);
    store.allowTool("Bash");
    store.allowTool("Bash");

    assert.deepEqual(store.standingAuthorisations(), ["Bash"]);
  });

  it("replaces the list on a patch rather than merging it", () => {
    const store = new ConfigStore(root);
    store.allowTool("Bash");
    store.allowTool("WebFetch");

    // A merged list would make a revocation indistinguishable from an omission — and here the thing
    // left un-revoked is a tool the machine goes on running unasked.
    store.update({ permissions: { allow: ["Bash"] } });

    assert.deepEqual(store.standingAuthorisations(), ["Bash"]);
  });

  it("clears the section, and the key, when the last grant is revoked", () => {
    const store = new ConfigStore(root);
    store.allowTool("Bash");

    store.update({ permissions: { allow: [] } });

    // The key has to be *deleted*, not merely left unwritten: the read-modify-write preserves
    // whatever the file already holds, so a section left behind would keep a grant the human had
    // just taken back.
    assert.deepEqual(store.standingAuthorisations(), []);
    assert.equal("permissions" in file(), false);
    assert.equal(store.view().permissions, undefined);
  });

  it("refuses an unusable patch outright, having changed nothing", () => {
    const store = new ConfigStore(root);
    store.allowTool("Bash");

    // The opposite manner to the file: there is a person on the other end who can fix it, and
    // silently keeping the old value while reporting success is what a settings page must never do.
    assert.throws(() => store.update({ permissions: { allow: [""] } } as never), /tool name/);
    assert.throws(() => store.update({ permissions: { allow: "Bash" } } as never), /list of tool names/);
    assert.deepEqual(store.standingAuthorisations(), ["Bash"]);
  });
});

describe("the Default Models and the Summary Model", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "flow-providers-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const file = (): Record<string, unknown> =>
    JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as Record<string, unknown>;

  it("is absent on a machine that has chosen neither", () => {
    const store = new ConfigStore(root);

    // A real state, as `projects` and `permissions` are: no machine starts with an opinion about
    // which model to use, and "unset" is not the same as "somebody chose the empty string".
    assert.equal(store.view().providers, undefined);
    assert.equal(store.defaultModel("claude"), undefined);
    assert.equal(store.summaryModel(), undefined);
  });

  it("reads both halves off the file", () => {
    writeFileSync(
      join(root, "config.json"),
      JSON.stringify({
        providers: {
          defaults: { claude: " opus ", pi: "anthropic/claude-sonnet-4" },
          summary: { backend: "claude", modelId: "haiku" },
        },
      }),
    );
    const store = new ConfigStore(root);

    assert.equal(store.defaultModel("claude"), "opus");
    assert.equal(store.defaultModel("pi"), "anthropic/claude-sonnet-4");
    assert.deepEqual(store.summaryModel(), { backend: "claude", modelId: "haiku" });
  });

  it("keeps an entry for a backend this build does not have", () => {
    writeFileSync(join(root, "config.json"), JSON.stringify({ providers: { defaults: { zeta: "z-1" } } }));
    const store = new ConfigStore(root);

    // The same courtesy `update` extends to a key no version of this daemon has parsed: a
    // config.json written on a machine with another backend installed must survive being read here.
    assert.equal(store.defaultModel("zeta"), "z-1");
    assert.equal(store.warning, undefined);
  });

  it("costs a bad half only itself", () => {
    writeFileSync(
      join(root, "config.json"),
      JSON.stringify({
        providers: { defaults: { claude: "opus", pi: 7 }, summary: { backend: "claude" } },
      }),
    );
    const store = new ConfigStore(root);

    // Parsed independently, so an unreadable Summary Model still leaves the Default Models in force
    // and one bad entry does not cost the others.
    assert.equal(store.defaultModel("claude"), "opus");
    assert.equal(store.defaultModel("pi"), undefined);
    assert.equal(store.summaryModel(), undefined);
    assert.match(store.warning ?? "", /providers\.defaults\.pi/);
    assert.match(store.warning ?? "", /providers\.summary\.modelId/);
  });

  it("merges the Default Models per backend, and clears one with an empty string", () => {
    const store = new ConfigStore(root);
    store.update({ providers: { defaults: { claude: "opus" } } });

    // The one place this file departs from "a list is replaced wholesale". That rule exists because
    // a merged list cannot express a removal; a keyed map can, and `""` is how — the same way
    // `projects.root: ""` clears the root.
    store.update({ providers: { defaults: { pi: "gpt-5" } } });
    assert.deepEqual(store.view().providers?.defaults, { claude: "opus", pi: "gpt-5" });

    store.update({ providers: { defaults: { claude: "" } } });
    assert.deepEqual(store.view().providers?.defaults, { pi: "gpt-5" });
  });

  it("clears the Summary Model with null, and the section with it", () => {
    const store = new ConfigStore(root);
    store.update({ providers: { summary: { backend: "claude", modelId: "haiku" } } });

    store.update({ providers: { summary: null } });

    // The key has to be deleted rather than left unwritten, for the reason `permissions` is: the
    // read-modify-write preserves whatever the file already holds.
    assert.equal(store.summaryModel(), undefined);
    assert.equal("providers" in file(), false);
  });

  it("refuses a half-specified Summary Model rather than merging one", () => {
    const store = new ConfigStore(root);
    store.update({ providers: { summary: { backend: "claude", modelId: "haiku" } } });

    // A merge would let a client change the Backend Adapter and leave behind a model id that
    // adapter cannot serve — a state nothing meant to ask for.
    assert.throws(() => store.update({ providers: { summary: { backend: "pi" } } } as never), /modelId/);
    assert.deepEqual(store.summaryModel(), { backend: "claude", modelId: "haiku" });
  });

  it("refuses an id that is not one, and a field it does not know", () => {
    const store = new ConfigStore(root);

    assert.throws(() => store.update({ providers: { defaults: { claude: "two words" } } }), /not a model id/);
    assert.throws(() => store.update({ providers: { defaults: { claude: 7 } } } as never), /must be a model id/);
    assert.throws(() => store.update({ providers: { summarise: {} } } as never), /unknown field summarise/);
  });

  it("reaches a running host without a restart", async () => {
    const store = new ConfigStore(root);
    const host = new SessionHost({ defaultModel: store.defaultModel });
    const backend = new FakeBackend();
    host.registerBackend(backend);

    // ADR 0009: the host reads *through* the store rather than being handed a copy at startup. A
    // snapshot here would present as "my Default Model only applies after a restart".
    store.update({ providers: { defaults: { fake: "fake-2" } } });
    await host.create({ scope: root, backend: "fake" });

    assert.equal(backend.latest.modelId, "fake-2");
  });
});
