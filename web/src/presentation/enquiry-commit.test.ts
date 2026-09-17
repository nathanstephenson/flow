import assert from "node:assert/strict";
import { it } from "node:test";
import { answerCurrentEnquiry } from "./enquiry-commit.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it("does not commit an answer after a terminal event clears the enquiry", async () => {
  let current: string | undefined = "ask-1";
  const response = deferred<boolean>();
  const result = answerCurrentEnquiry("ask-1", [["Yes"]], () => response.promise, () => current);
  current = undefined;
  response.resolve(true);
  assert.equal(await result, false);
});

it("does not let a back-to-back relay overwrite the next enquiry", async () => {
  let current: string | undefined = "ask-1";
  const response = deferred<boolean>();
  const first = answerCurrentEnquiry("ask-1", [["First"]], () => response.promise, () => current);
  current = "ask-2";
  response.resolve(true);
  assert.equal(await first, false);

  assert.equal(await answerCurrentEnquiry("ask-2", [["Second"]], async () => true, () => current), true);
});
