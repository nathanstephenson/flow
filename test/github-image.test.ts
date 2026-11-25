import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { githubImage } from "../src/daemon/github-image.ts";

const raw = "https://raw.githubusercontent.com/o/r/abc123/view.png";
const attachment = "https://github.com/user-attachments/assets/0ec2d14f-f106-45c3-9095-98e5007c8f92";

function fake(status: number, type: string) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response("bytes", { status, headers: { "content-type": type } });
  };
  return { calls, fetcher: fetcher as typeof fetch };
}

describe("githubImage", () => {
  it("fetches raw files and user attachments with the gh token", async () => {
    for (const url of [raw, attachment]) {
      const { calls, fetcher } = fake(200, "image/png");
      const image = await githubImage(url, async () => "secret\n", fetcher);
      assert.equal(image?.headers.get("content-type"), "image/png");
      assert.equal(calls[0]?.url, url);
      assert.deepEqual(calls[0]?.init?.headers, { authorization: "token secret" });
    }
  });

  it("refuses URLs that are not GitHub images", async () => {
    for (const url of ["http://raw.githubusercontent.com/o/r/a.png", "https://example.com/a.png", "https://github.com/o/r/raw/a/b.png", "https://github.com/user-attachments/files/1/a.zip", "not a url"]) {
      const { calls, fetcher } = fake(200, "image/png");
      assert.equal(await githubImage(url, async () => "secret", fetcher), null);
      assert.equal(calls.length, 0);
    }
  });

  it("refuses failures and types other than raster images", async () => {
    for (const [status, type] of [[404, "image/png"], [200, "image/svg+xml"], [200, "text/html; charset=utf-8"]] as const) {
      assert.equal(await githubImage(raw, async () => "secret", fake(status, type).fetcher), null);
    }
  });
});
