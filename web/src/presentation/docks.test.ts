import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addTab,
  clampDockSize,
  closeTab,
  fillWithShell,
  defaultLayout,
  emptyDock,
  parseLayouts,
  pruneLayouts,
  reconcileLayout,
  rememberShell,
  setActive,
  setSize,
  tabLabel,
  toggleMinimised,
  type Dock,
} from "./docks.ts";

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
    assert.equal(dock.tabs[0]?.content?.shellId, "sh1");
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
      bottom.tabs.map((tab) => tab.content?.shellId),
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
      bottom.tabs.map((tab) => tab.content?.shellId),
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
    assert.equal(dock?.tabs[0]?.content?.shellId, "sh1");
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
