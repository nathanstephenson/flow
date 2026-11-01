import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { sandboxSupervisorSource } from "../src/isolation/sandbox-supervisor.ts";

const supervised = (argv: string[]) => spawn(process.execPath, ["-e", sandboxSupervisorSource, "--", ...argv], { stdio: ["pipe", "pipe", "pipe"] });
const running = (tag: string) => spawnSync("pgrep", ["-f", `^sleep ${tag}`], { encoding: "utf8" }).stdout.trim();
const exited = (child: ReturnType<typeof spawn>) => new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));

test("passes bytes and the exit code through", async () => {
  const input = randomBytes(4 * 1024 * 1024);
  const child = supervised(["sh", "-c", "cat; exit 7"]);
  const chunks: Buffer[] = [];
  child.stdout!.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stdin!.end(input);
  assert.equal(await exited(child), 7);
  assert.ok(Buffer.concat(chunks).equals(input));
});

for (const stop of ["stdin close", "command exit"] as const) {
  test(`stops normal, setsid and detached children on ${stop}`, { skip: process.platform !== "linux" }, async () => {
    const tag = `${stop === "stdin close" ? 3001 : 3002}${process.pid % 1000}`;
    const script = `sleep ${tag}1 & setsid sleep ${tag}2 & (sleep ${tag}3 &); ${stop === "stdin close" ? "cat >/dev/null" : "sleep 1"}`;
    const bystander = spawn("sleep", [`${tag}9`], { stdio: "ignore" });
    const child = supervised(["sh", "-c", script]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(running(tag).split("\n").filter(Boolean).length, 4);
    if (stop === "stdin close") child.stdin!.end();
    await exited(child);
    assert.equal(running(`${tag}[123]`), "");
    assert.notEqual(running(`${tag}9`), "");
    bystander.kill();
  });
}
