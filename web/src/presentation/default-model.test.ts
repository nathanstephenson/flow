import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BackendModels } from "../../../src/protocol/events.ts";
import { preselectedModel } from "./default-model.ts";

/**
 * Which model the New Agent Session view starts on.
 *
 * The whole behaviour is the fallback order, and what it is *for* is the paste guard: ADR 0014 says
 * a composer must treat an unknown model as one that cannot be shown an image, and
 * `providers.defaults` is empty on every fresh installation. So the cases that matter here are the
 * ones where nothing is configured — answering `undefined` for those would have left Attachments
 * quietly unavailable for most people.
 */

const catalogue: BackendModels[] = [
  {
    backend: "claude",
    models: [
      { id: "sonnet", acceptsImages: true },
      { id: "haiku", acceptsImages: true },
    ],
  },
  { backend: "pi", models: [{ id: "gpt", acceptsImages: true }, { id: "text-only" }] },
  { backend: "broken", models: [], problem: "not logged in" },
];

describe("preselecting a model for a new Agent Session", () => {
  it("prefers the configured Default Model", () => {
    assert.equal(preselectedModel(catalogue, { claude: "haiku" }, "claude")?.id, "haiku");
  });

  it("falls back to the backend's first model when none is configured", () => {
    assert.equal(preselectedModel(catalogue, undefined, "claude")?.id, "sonnet");
    assert.equal(preselectedModel(catalogue, {}, "claude")?.id, "sonnet");
  });

  /*
   * Nothing validates a model id at save time (ADR 0020), so a Default Model may name one that has
   * been withdrawn. Preselecting it anyway would put an id in the picker that its own list does not
   * contain, which reads as a broken control rather than as a stale setting.
   */
  it("falls back when the configured default is not in that backend's list", () => {
    assert.equal(preselectedModel(catalogue, { claude: "withdrawn" }, "claude")?.id, "sonnet");
  });

  // A default configured for one Backend Adapter says nothing about another's.
  it("ignores a default configured for a different backend", () => {
    assert.equal(preselectedModel(catalogue, { claude: "haiku" }, "pi")?.id, "gpt");
  });

  describe("the cases where the composer is legitimately inert", () => {
    it("answers nothing while the catalogue is in flight", () => {
      assert.equal(preselectedModel(undefined, { claude: "haiku" }, "claude"), undefined);
    });

    it("answers nothing for a backend that could not list its models", () => {
      assert.equal(preselectedModel(catalogue, undefined, "broken"), undefined);
    });

    it("answers nothing for a backend the catalogue does not mention", () => {
      assert.equal(preselectedModel(catalogue, undefined, "absent"), undefined);
    });
  });

  /*
   * The guard downstream is `acceptsImages !== true`, not `=== false`. The field is `true | undefined`
   * (ADR 0014), so a model that simply does not declare it must read as refusing.
   */
  it("resolves a model that declares no image support, which then refuses a paste", () => {
    const model = preselectedModel(catalogue, { pi: "text-only" }, "pi");
    assert.equal(model?.id, "text-only");
    assert.notEqual(model?.acceptsImages, true);
  });
});
