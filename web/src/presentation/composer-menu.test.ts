import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  commandsFor,
  completed,
  leadingToken,
  matching,
  menuQuery,
  triggerables,
  triggeredBy,
  type Triggerable,
} from "./composer-menu.ts";

const CATALOGUE: Triggerable[] = [
  { kind: "command", name: "compact", description: "Summarise the Conversation Context" },
  { kind: "skill", name: "tdd", description: "Red, green, refactor" },
  { kind: "skill", name: "code-review", description: "Review the diff", argumentHint: "[<pr#>]" },
];

describe("the leading token", () => {
  it("is the name a message begins with", () => {
    assert.deepEqual(leadingToken("/tdd"), { name: "tdd", to: 4 });
    assert.deepEqual(leadingToken("/code-review the diff"), { name: "code-review", to: 12 });
  });

  it("is the bare slash that has just been typed", () => {
    assert.deepEqual(leadingToken("/"), { name: "", to: 1 });
  });

  /*
   * The whole reason position 0 is the rule. None of these needs special-casing — there is simply
   * nothing at the front of the message for a trigger to be.
   */
  it("is nothing when the slash is not the first character", () => {
    assert.equal(leadingToken("look at /etc/hosts"), undefined);
    assert.equal(leadingToken("and/or"), undefined);
    assert.equal(leadingToken(" /tdd"), undefined);
    assert.equal(leadingToken(""), undefined);
  });
});

describe("what a message triggers", () => {
  it("is the Command or Skill its leading name matches", () => {
    assert.equal(triggeredBy("/tdd", CATALOGUE)?.name, "tdd");
    assert.equal(triggeredBy("/compact", CATALOGUE)?.kind, "command");
    assert.equal(triggeredBy("/tdd write the test first", CATALOGUE)?.name, "tdd");
  });

  // Otherwise the pill flickers onto `tdd` while someone is halfway through typing a longer name.
  it("is nothing until the name has ended", () => {
    assert.equal(triggeredBy("/tddx", CATALOGUE), undefined);
    assert.equal(triggeredBy("/code", CATALOGUE), undefined);
  });

  it("is nothing for a name nobody offers", () => {
    assert.equal(triggeredBy("/nonesuch", CATALOGUE), undefined);
    assert.equal(triggeredBy("/etc/hosts", CATALOGUE), undefined);
  });
});

describe("when the menu is open", () => {
  it("opens on the slash and filters as the name is typed", () => {
    assert.equal(menuQuery("/", 1), "");
    assert.equal(menuQuery("/td", 3), "td");
  });

  // A menu still open over the arguments would be offering to replace a name already settled on.
  it("closes once the caret leaves the name", () => {
    assert.equal(menuQuery("/tdd write a test", 10), undefined);
    assert.equal(menuQuery("/tdd ", 5), undefined);
  });

  it("never opens on a message that does not begin with a slash", () => {
    assert.equal(menuQuery("look at /etc/hosts", 12), undefined);
  });
});

describe("narrowing the catalogue", () => {
  it("is everything before anything is typed", () => {
    assert.equal(matching(CATALOGUE, "").length, 3);
  });

  it("puts a prefix match above one that merely contains the query", () => {
    const names = matching(CATALOGUE, "co").map((candidate) => candidate.name);
    assert.deepEqual(names, ["compact", "code-review"]);
  });

  it("finds a name by its middle, since a Skill's name is often hyphenated", () => {
    assert.deepEqual(matching(CATALOGUE, "review").map((candidate) => candidate.name), ["code-review"]);
  });

  it("is empty for a query nothing answers, which is what closes the menu", () => {
    assert.deepEqual(matching(CATALOGUE, "zzz"), []);
  });
});

describe("completing a name", () => {
  it("replaces the token and leaves the caret past a trailing space", () => {
    assert.deepEqual(completed("/td", "tdd"), { text: "/tdd ", caret: 5 });
  });

  it("keeps whatever was already typed after the name", () => {
    assert.deepEqual(completed("/co the diff", "code-review"), { text: "/code-review the diff", caret: 13 });
  });

  it("does not double the space when there already is one", () => {
    assert.deepEqual(completed("/ ", "tdd"), { text: "/tdd ", caret: 5 });
  });
});

describe("the Commands on offer", () => {
  // The same rule every other control follows: hide what this Agent Session cannot serve.
  it("are none when the backend cannot compact", () => {
    assert.deepEqual(commandsFor(false), []);
    assert.deepEqual(commandsFor(undefined), []);
  });

  it("lead the Skills, so the one Flow performs does not sink into a list of twenty", () => {
    const all = triggerables(true, [{ name: "tdd", description: "Red, green, refactor" }]);
    assert.deepEqual(all.map((candidate) => candidate.kind), ["command", "skill"]);
  });
});
