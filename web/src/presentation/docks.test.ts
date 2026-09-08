import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addTab,
  clampDockSize,
  closeTab,
  defaultLayout,
  fillWithShell,
  fillWithSubagents,
  emptyDock,
  parseLayouts,
  pruneLayouts,
  reconcileLayout,
  rememberShell,
  selectSubagent,
  setActive,
  setSize,
  subagentsSide,
  tabLabel,
  toggleMinimised,
  type Dock,
  type DockTabContent,
} from "./docks.ts";

/** The Shell a tab holds, or undefined for a tab holding anything else. */
const shellOf = (tab: { content?: DockTabContent | undefined } | undefined): string | undefined =>
  tab?.content?.kind === "shell" ? tab.content.shellId : undefined;

/** A Dock with `count` Shells in it, each with an id, the first active. */
function withShells(count: number): Dock {
  let dock = emptyDock("bottom");
  for (let index = 1; index <= count; index += 1) {
    dock = rememberShell(fillWithShell(dock, `t${index}`), `t${index}`, `sh${index}`);
  }
  return setActive({ ...dock, minimised: false }, "t1");
}

describe("clamping a Dock's size", () => {
  it("floors at the minimum, which differs per side", () => {
    assert.equal(clampDockSize("bottom", 0, 1000), 120);
    assert.equal(clampDockSize("right", 0, 1000), 240);
  });

  /**
   * The ceiling is a share of the pane rather than a constant: the same 600px Dock is reasonable on
   * a desktop and swallows the transcript whole on a laptop.
   */
  it("reserves room for the conversation whatever the drag asks for", () => {
    assert.equal(clampDockSize("bottom", 9000, 800), 600);
    assert.equal(clampDockSize("right", 9000, 1000), 680);
  });

  it("keeps the minimum even when the reserve would eat it", () => {
    assert.equal(clampDockSize("bottom", 9000, 150), 120);
  });

  /** One frame before the pane has been measured. Clamping against 0 would pin every Dock shut. */
  it("only floors when the container has not been measured", () => {
    assert.equal(clampDockSize("bottom", 9000), 9000);
    assert.equal(clampDockSize("bottom", 9000, 0), 9000);
  });

  it("refuses a number that is not one", () => {
    assert.equal(clampDockSize("bottom", Number.NaN, 800), 300);
    assert.equal(clampDockSize("right", Number.POSITIVE_INFINITY, 800), 380);
  });
});

describe("tabs", () => {
  it("adds an unchosen tab and makes it active, which is what draws the picker", () => {
    const dock = addTab(emptyDock("bottom"), "t1");
    assert.equal(dock.activeId, "t1");
    assert.equal(dock.tabs[0]?.content, undefined);
    assert.equal(tabLabel(dock, "t1"), "New tab");
  });

  it("numbers Shells by position, so closing one leaves no gap", () => {
    const dock = withShells(3);
    assert.equal(tabLabel(dock, "t2"), "Shell 2");
    const { dock: after } = closeTab(dock, "t1");
    assert.equal(tabLabel(after, "t2"), "Shell 1");
  });

  it("hands back the Shell that closed, for the caller to kill", () => {
    const { killed } = closeTab(withShells(2), "t2");
    assert.equal(killed, "sh2");
  });

  it("says nothing was killed when the tab held no Shell yet", () => {
    const { killed } = closeTab(addTab(emptyDock("bottom"), "t1"), "t1");
    assert.equal(killed, undefined);
  });

  it("moves the active tab left, and right only from the first", () => {
    const three = withShells(3);
    assert.equal(closeTab(setActive(three, "t2"), "t2").dock.activeId, "t1");
    assert.equal(closeTab(setActive(three, "t1"), "t1").dock.activeId, "t2");
  });

  it("leaves the active tab alone when another one closes", () => {
    assert.equal(closeTab(setActive(withShells(3), "t3"), "t1").dock.activeId, "t3");
  });

  /** Closing the last tab drops back to the picker rather than collapsing the Dock. */
  it("stays open with nothing in it", () => {
    const { dock } = closeTab(withShells(1), "t1");
    assert.equal(dock.minimised, false);
    assert.deepEqual(dock.tabs, []);
    assert.equal(dock.activeId, undefined);
  });

  it("ignores a tab it does not have", () => {
    const dock = withShells(1);
    assert.equal(closeTab(dock, "nope").dock, dock);
    assert.equal(setActive(dock, "nope"), dock);
  });
});

describe("minimising", () => {
  it("remembers the tabs and the size", () => {
    const open = setSize("bottom", withShells(2), 420, 1000);
    const minimised = toggleMinimised(open);
    assert.equal(minimised.minimised, true);
    assert.equal(minimised.size, 420);
    assert.equal(minimised.tabs.length, 2);
    assert.equal(toggleMinimised(minimised).minimised, false);
  });

  /** Open with nothing in it is the picker's job, not this one's. */
  it("opens an empty Dock without inventing a tab", () => {
    const dock = toggleMinimised(emptyDock("bottom"));
    assert.equal(dock.minimised, false);
    assert.deepEqual(dock.tabs, []);
  });
});

describe("choosing a Shell from the picker", () => {
  it("fills the unchosen tab it was shown for", () => {
    const dock = fillWithShell(addTab(emptyDock("bottom"), "t1"), "t1");
    assert.equal(dock.tabs.length, 1);
    assert.equal(dock.tabs[0]?.content?.kind, "shell");
    assert.equal(dock.tabs[0]?.content?.shellId, undefined);
  });

  it("adds a tab when the Dock was showing the picker with none", () => {
    const dock = fillWithShell(emptyDock("bottom"), "t1");
    assert.equal(dock.activeId, "t1");
    assert.equal(dock.tabs[0]?.content?.kind, "shell");
  });

  it("takes the Shell id once the pty is open", () => {
    const dock = rememberShell(fillWithShell(emptyDock("bottom"), "t1"), "t1", "sh1");
    assert.equal(shellOf(dock.tabs[0]), "sh1");
  });

  it("drops the id of a tab that closed while its Shell was opening", () => {
    const dock = rememberShell(emptyDock("bottom"), "gone", "sh1");
    assert.deepEqual(dock.tabs, []);
  });
});

describe("reconciling against the Session Host", () => {
  const layout = (bottom: Dock, right = emptyDock("right")) => ({ bottom, right });

  it("drops tabs whose Shell is gone", () => {
    const { bottom } = reconcileLayout(layout(withShells(2)), ["sh2"]);
    assert.deepEqual(
      bottom.tabs.map(shellOf),
      ["sh2"],
    );
    assert.equal(bottom.activeId, "t2");
  });

  it("keeps an unchosen tab, which claims no Shell", () => {
    const { bottom } = reconcileLayout(layout(addTab(withShells(1), "t9")), []);
    assert.deepEqual(
      bottom.tabs.map((tab) => tab.id),
      ["t9"],
    );
  });

  /** A Shell opened in another browser window is not invisible in this one. */
  it("adopts a live Shell nothing claims", () => {
    const { bottom } = reconcileLayout(layout(withShells(1)), ["sh1", "sh7"]);
    assert.deepEqual(
      bottom.tabs.map(shellOf),
      ["sh1", "sh7"],
    );
  });

  /**
   * Both Docks at once, or each unclaimed Shell is adopted twice — and two tabs onto one pty means
   * closing either one kills the Shell the other is showing.
   */
  it("adopts an orphan into one Dock only", () => {
    const { bottom, right } = reconcileLayout(layout(emptyDock("bottom")), ["sh1"]);
    assert.equal(bottom.tabs.length, 1);
    assert.deepEqual(right.tabs, []);
  });

  it("does not adopt a Shell the other Dock is already showing", () => {
    const right = rememberShell(fillWithShell(emptyDock("right"), "r1"), "r1", "sh1");
    const reconciled = reconcileLayout({ bottom: emptyDock("bottom"), right }, ["sh1"]);
    assert.deepEqual(reconciled.bottom.tabs, []);
    assert.equal(reconciled.right.tabs.length, 1);
  });

  it("leaves a layout with nothing to reconcile alone", () => {
    const { bottom } = reconcileLayout(layout(emptyDock("bottom")), []);
    assert.deepEqual(bottom.tabs, []);
    assert.equal(bottom.activeId, undefined);
  });
});

describe("layouts read back from storage", () => {
  it("answers nothing, or nonsense, with nothing", () => {
    assert.deepEqual(parseLayouts(null), {});
    assert.deepEqual(parseLayouts(""), {});
    assert.deepEqual(parseLayouts("{"), {});
    assert.deepEqual(parseLayouts("[1,2]"), {});
  });

  it("answers a half-written layout with a usable one", () => {
    const layouts = parseLayouts(JSON.stringify({ a: { bottom: { tabs: "no" } } }));
    assert.deepEqual(layouts.a, defaultLayout());
  });

  it("keeps a layout it can read", () => {
    const stored = JSON.stringify({
      a: {
        bottom: { tabs: [{ id: "t1", content: { kind: "shell", shellId: "sh1" } }], activeId: "t1", size: 420, minimised: false },
        right: { tabs: [], activeId: undefined, size: 400, minimised: true },
      },
    });
    const dock = parseLayouts(stored).a?.bottom;
    assert.equal(dock?.size, 420);
    assert.equal(dock?.minimised, false);
    assert.equal(shellOf(dock?.tabs[0]), "sh1");
  });

  it("drops a tab with no usable id, and forgets an unknown kind", () => {
    const stored = JSON.stringify({
      a: { bottom: { tabs: [{ id: 4 }, { id: "t1", content: { kind: "sonnet" } }] } },
    });
    const tabs = parseLayouts(stored).a?.bottom.tabs ?? [];
    assert.equal(tabs.length, 1);
    assert.equal(tabs[0]?.content, undefined);
  });

  it("points activeId at something that exists", () => {
    const stored = JSON.stringify({ a: { bottom: { tabs: [{ id: "t1" }], activeId: "gone" } } });
    assert.equal(parseLayouts(stored).a?.bottom.activeId, "t1");
  });

  /** Only an explicit `false` opens a Dock: a value nobody wrote should not open one. */
  it("treats anything but false as minimised", () => {
    const stored = JSON.stringify({ a: { bottom: { minimised: "no" } }, b: { bottom: { minimised: false } } });
    const layouts = parseLayouts(stored);
    assert.equal(layouts.a?.bottom.minimised, true);
    assert.equal(layouts.b?.bottom.minimised, false);
  });
});

describe("pruning", () => {
  it("forgets Agent Sessions that are gone", () => {
    const layouts = { a: defaultLayout(), b: defaultLayout() };
    assert.deepEqual(Object.keys(pruneLayouts(layouts, ["b"])), ["b"]);
  });

  /** Identity is the signal the hook writes on, so an unchanged blob must not be rewritten. */
  it("returns the same object when it has nothing to forget", () => {
    const layouts = { a: defaultLayout() };
    assert.equal(pruneLayouts(layouts, ["a", "b"]), layouts);
  });
});

/**
 * A tab showing the Subagents.
 *
 * Unlike a Shell, this holds no resource of its own — the Subagents are already in the Presentation
 * Transcript — so there is no late id to remember and nothing to kill when the tab closes. What it
 * does hold is the reader's place: which Subagent they drilled into, kept in the tab content so it
 * survives a reload, the same way `shellId` does.
 */
describe("an Agents tab", () => {
  const withSubagents = () => fillWithSubagents(addTab(defaultLayout().right, "t1"), "t1");

  it("fills the tab the picker was shown for, and activates it", () => {
    const dock = withSubagents();
    assert.deepEqual(dock.tabs, [{ id: "t1", content: { kind: "subagents" } }]);
    assert.equal(dock.activeId, "t1");
  });

  it("adds a tab when there was no unchosen one to fill", () => {
    const dock = fillWithSubagents(defaultLayout().right, "fresh");
    assert.deepEqual(dock.tabs.map((tab) => tab.id), ["fresh"]);
  });

  it("calls itself Agents, without an ordinal", () => {
    // Two Agents tabs would show the same Subagents, so numbering them implies a distinction that
    // is not there. Shells are numbered because each one is its own process.
    const dock = fillWithSubagents(withSubagents(), "t2");
    assert.equal(tabLabel(dock, "t1"), "Agents");
    assert.equal(tabLabel(dock, "t2"), "Agents");
  });

  it("numbers Shells around it, ignoring it in the count", () => {
    const dock = fillWithShell(fillWithSubagents(fillWithShell(defaultLayout().right, "s1"), "a1"), "s2");
    assert.equal(tabLabel(dock, "s1"), "Shell 1");
    assert.equal(tabLabel(dock, "a1"), "Agents");
    assert.equal(tabLabel(dock, "s2"), "Shell 2");
  });

  it("remembers which Subagent was drilled into, and forgets it on the way back", () => {
    const selected = selectSubagent(withSubagents(), "t1", "subagent:abc");
    assert.deepEqual(selected.tabs[0]?.content, { kind: "subagents", subagentId: "subagent:abc" });

    const back = selectSubagent(selected, "t1");
    assert.deepEqual(back.tabs[0]?.content, { kind: "subagents" }, "back must clear it, not keep a stale id");
  });

  it("leaves a Shell tab alone when asked to select a Subagent in it", () => {
    const dock = fillWithShell(defaultLayout().right, "s1");
    assert.deepEqual(selectSubagent(dock, "s1", "subagent:abc").tabs, dock.tabs);
  });

  it("kills nothing when closed", () => {
    // A Shell tab's close ends a pty (ADR 0008). This one owns no process.
    const { killed } = closeTab(withSubagents(), "t1");
    assert.equal(killed, undefined);
  });

  it("survives reconciling against the Session Host's live Shells", () => {
    // The reconcile drops tabs whose Shell has gone. An Agents tab claims no Shell, so a reconcile
    // that found none must not take it with them — it survived only by accident before the kinds
    // were told apart.
    const layout = { ...defaultLayout(), right: withSubagents() };
    const reconciled = reconcileLayout(layout, []);
    assert.deepEqual(reconciled.right.tabs.map((tab) => tab.content?.kind), ["subagents"]);
  });

  it("does not claim a Shell that another tab could have adopted", () => {
    const layout = { ...defaultLayout(), right: withSubagents() };
    const reconciled = reconcileLayout(layout, ["live-shell"]);
    // The unclaimed live Shell is adopted into the bottom Dock, not attached to the Agents tab.
    assert.deepEqual(reconciled.right.tabs.map((tab) => tab.content?.kind), ["subagents"]);
    assert.ok(reconciled.bottom.tabs.some((tab) => tab.content?.kind === "shell"));
  });

  it("comes back from storage with its kind and its selection", () => {
    // parseTab whitelists kinds one by one, so a kind added without a line there reopens as a blank
    // picker — which looks like the tab forgetting itself.
    const stored = {
      s1: {
        bottom: { tabs: [], activeId: undefined, size: 300, minimised: true },
        right: {
          tabs: [{ id: "t1", content: { kind: "subagents", subagentId: "subagent:abc" } }],
          activeId: "t1",
          size: 380,
          minimised: false,
        },
      },
    };
    const parsed = parseLayouts(JSON.stringify(stored));
    assert.deepEqual(parsed.s1?.right.tabs[0]?.content, { kind: "subagents", subagentId: "subagent:abc" });
  });

  it("comes back from storage on the list when nothing was selected", () => {
    const stored = {
      s1: {
        bottom: { tabs: [], activeId: undefined, size: 300, minimised: true },
        right: { tabs: [{ id: "t1", content: { kind: "subagents" } }], activeId: "t1", size: 380, minimised: false },
      },
    };
    assert.deepEqual(parseLayouts(JSON.stringify(stored)).s1?.right.tabs[0]?.content, { kind: "subagents" });
  });
});

describe("opening one Subagent from the transcript", () => {
  it("drills straight into the Subagent asked for", () => {
    // The transcript card names one, so landing on the list would make the reader find it again.
    const dock = fillWithSubagents(addTab(defaultLayout().right, "t1"), "t1", "subagent:abc");
    assert.deepEqual(dock.tabs[0]?.content, { kind: "subagents", subagentId: "subagent:abc" });
    assert.equal(dock.activeId, "t1");
  });

  it("opens on the list when no Subagent was named", () => {
    const dock = fillWithSubagents(addTab(defaultLayout().right, "t1"), "t1");
    assert.deepEqual(dock.tabs[0]?.content, { kind: "subagents" });
  });

  it("retargets a tab that was already showing a different Subagent", () => {
    const first = fillWithSubagents(addTab(defaultLayout().right, "t1"), "t1", "subagent:aaa");
    const second = fillWithSubagents(first, "t1", "subagent:bbb");
    assert.deepEqual(second.tabs[0]?.content, { kind: "subagents", subagentId: "subagent:bbb" });
    assert.equal(second.tabs.length, 1, "retargeting must not add a tab");
  });
});

/**
 * Which Dock the Subagents open in.
 *
 * A reader who put the Agents tab in the bottom Dock and then clicks a Subagent in the transcript
 * should be taken to the tab they already have, not handed a second copy on the right.
 */
describe("finding an existing Agents tab", () => {
  const agentsIn = (side: "bottom" | "right") => {
    const layout = defaultLayout();
    return { ...layout, [side]: fillWithSubagents(addTab(layout[side], "t1"), "t1") };
  };

  it("finds one in the right Dock", () => {
    assert.equal(subagentsSide(agentsIn("right")), "right");
  });

  it("finds one in the bottom Dock", () => {
    assert.equal(subagentsSide(agentsIn("bottom")), "bottom");
  });

  it("says nothing when neither Dock has one", () => {
    assert.equal(subagentsSide(defaultLayout()), undefined);
  });

  it("ignores a Shell tab", () => {
    const layout = defaultLayout();
    const withShell = { ...layout, bottom: fillWithShell(addTab(layout.bottom, "s1"), "s1") };
    assert.equal(subagentsSide(withShell), undefined);
  });

  it("settles on the right when both Docks have one", () => {
    // Either would serve the reader; a rule beats a coin, and it keeps the choice reproducible.
    const layout = defaultLayout();
    const both = {
      bottom: fillWithSubagents(addTab(layout.bottom, "b1"), "b1"),
      right: fillWithSubagents(addTab(layout.right, "r1"), "r1"),
    };
    assert.equal(subagentsSide(both), "right");
  });

  it("finds a minimised Dock's tab, so the Subagents are not duplicated to reach them", () => {
    const layout = agentsIn("bottom");
    assert.equal(layout.bottom.minimised, true, "precondition: the Dock starts minimised");
    assert.equal(subagentsSide(layout), "bottom");
  });
});
