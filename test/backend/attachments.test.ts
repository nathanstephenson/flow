import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { userContent } from "../../src/backend/claude/index.ts";
import { PiSession } from "../../src/backend/pi/index.ts";
import type { PromptAttachment } from "../../src/backend/types.ts";
import type { ModelInfo } from "../../src/protocol/events.ts";

/**
 * What each SDK is actually handed for an Attachment.
 *
 * The payloads, not the plumbing, because the two SDKs disagree about where an image goes and
 * neither disagreement is visible from anywhere else: Claude takes content blocks *inside* the user
 * message, and pi takes an `images` array *beside* the text. A mistake in either is a turn where the
 * model simply never saw the picture — no error, no notice, just an answer about nothing.
 *
 * Asserted here rather than in the conformance suite on purpose. The contract runs against real
 * models, so "did it see it" would cost an API call and a judgement about a reply; these assert the
 * exact bytes handed over, which is the part that can regress silently.
 */

const png: PromptAttachment = { mediaType: "image/png", data: "iVBORw0KGgo=" };
const jpeg: PromptAttachment = { mediaType: "image/jpeg", data: "/9j/4AAQSkZJRg==" };

describe("what Claude is handed", () => {
  /*
   * A plain string, not a one-element block array. This backend has sent `content` as a string since
   * it was written, and re-shaping every ordinary turn for a feature most turns do not use would put
   * an untested code path under the common case.
   */
  it("keeps a turn with no attachments as a plain string", () => {
    assert.equal(userContent("hello"), "hello");
    assert.equal(userContent("hello", []), "hello");
  });

  it("leads with the images and ends with the text", () => {
    assert.deepEqual(userContent("what is this?", [png, jpeg]), [
      { type: "image", source: { type: "base64", media_type: "image/png", data: png.data } },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.data } },
      { type: "text", text: "what is this?" },
    ]);
  });

  /*
   * A wordless paste still carries its text block. Dropping an empty one would leave a user turn
   * that is images alone, and the block is what the model's answer is grammatically about.
   */
  it("carries an empty text block for a wordless paste", () => {
    assert.deepEqual(userContent("", [png]), [
      { type: "image", source: { type: "base64", media_type: "image/png", data: png.data } },
      { type: "text", text: "" },
    ]);
  });
});

describe("what pi is handed", () => {
  const stub = () => {
    const prompts: Array<{ text: string; options: unknown }> = [];
    const models = [
      { id: "m1", provider: "anthropic", name: "M1", input: ["text", "image"] },
      { id: "m2", provider: "anthropic", name: "M2", input: ["text"] },
    ];
    const session = {
      subscribe: () => () => {},
      dispose() {},
      async prompt(text: string, options: unknown) {
        prompts.push({ text, options });
      },
      modelRuntime: { getAvailable: async () => models, getAvailableSnapshot: () => models },
      get model() {
        return models[0];
      },
      supportsThinking: () => false,
      getAvailableThinkingLevels: () => [],
    } as unknown as AgentSession;
    return { session, prompts };
  };

  const start = () => {
    const { session, prompts } = stub();
    return { session: new PiSession(session, () => {}), prompts };
  };

  it("sends no images key at all when there are none", () => {
    const { session, prompts } = start();
    void session.prompt("hello");
    assert.deepEqual(prompts[0]?.options, { streamingBehavior: "steer" });
  });

  it("sends images beside the text, keeping the steer (ADR 0002)", () => {
    const { session, prompts } = start();
    void session.prompt("what is this?", [png, jpeg]);
    assert.deepEqual(prompts[0], {
      text: "what is this?",
      options: {
        streamingBehavior: "steer",
        images: [
          { type: "image", data: png.data, mimeType: "image/png" },
          { type: "image", data: jpeg.data, mimeType: "image/jpeg" },
        ],
      },
    });
  });

  it("reads acceptsImages from the registry, per model", () => {
    const { session } = start();
    const models = session.capabilities.models;
    assert.equal(models.find((model: ModelInfo) => model.id === "anthropic/m1")?.acceptsImages, true);
    // Absent, not false — a client hides the control rather than reading a flag it must negate.
    assert.equal(models.find((model: ModelInfo) => model.id === "anthropic/m2")?.acceptsImages, undefined);
  });
});
