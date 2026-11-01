import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { encodeFrame, frameDecoder } from "../../src/backend/worker/frames.ts";

function collect() {
  const messages: unknown[] = [];
  return { messages, decode: frameDecoder((message) => messages.push(message)) };
}

test("decodes frames split at every byte", () => {
  const { messages, decode } = collect();
  const frame = encodeFrame({ kind: "call", id: 1, method: "prompt", args: ["hello"] });
  for (const byte of frame) decode(Buffer.from([byte]));
  assert.deepEqual(messages, [{ kind: "call", id: 1, method: "prompt", args: ["hello"] }]);
});

test("decodes many frames in one chunk and a frame split over chunk edges", () => {
  const { messages, decode } = collect();
  const data = Buffer.concat([encodeFrame(1), encodeFrame("two"), encodeFrame({ three: 3 })]);
  decode(data.subarray(0, 7));
  decode(data.subarray(7));
  assert.deepEqual(messages, [1, "two", { three: 3 }]);
});

test("keeps structured-clone values and large payloads", () => {
  const { messages, decode } = collect();
  const bytes = randomBytes(8 * 1024 * 1024);
  const frame = encodeFrame({ bytes, missing: undefined, map: new Map([["a", 1]]) });
  for (let offset = 0; offset < frame.length; offset += 65536) decode(frame.subarray(offset, offset + 65536));
  const message = messages[0] as { bytes: Uint8Array; missing: undefined; map: Map<string, number> };
  assert.ok(Buffer.from(message.bytes).equals(bytes));
  assert.ok("missing" in message);
  assert.equal(message.map.get("a"), 1);
});
