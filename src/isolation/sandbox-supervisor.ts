/** Runs inside the sandbox as `node -e`. Stops every process carrying this command's marker when
 * stdin closes or the command exits, so one command tree stops without affecting others in the VM. */
export function sandboxSupervisor(): void {
  const { spawn } = process.getBuiltinModule("node:child_process");
  const { readdirSync, readFileSync } = process.getBuiltinModule("node:fs");
  const { constants } = process.getBuiltinModule("node:os");
  const id = `${process.pid}-${Date.now()}`;
  const marker = `FLOW_SANDBOX_COMMAND=${id}`;
  const argv = process.argv.slice(1);
  if (argv[0] === "--") argv.shift();
  const child = spawn(argv[0]!, argv.slice(1), { stdio: "pipe", env: { ...process.env, FLOW_SANDBOX_COMMAND: id } });
  child.stdout!.pipe(process.stdout);
  child.stderr!.pipe(process.stderr);
  const drained = Promise.all([child.stdout!, child.stderr!].map((stream) => new Promise((resolve) => stream.once("close", resolve))));
  const marked = () => readdirSync("/proc").filter((entry) => /^\d+$/.test(entry) && Number(entry) !== process.pid).filter((pid) => {
    try { return readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").includes(marker); } catch { return false; }
  }).map(Number);
  const signalAll = (signal: NodeJS.Signals) => {
    for (const pid of marked()) { try { process.kill(pid, signal); } catch { /* already gone */ } }
  };
  let finishing = false;
  const finish = async (code: number) => {
    if (finishing) return;
    finishing = true;
    signalAll("SIGTERM");
    for (let wait = 0; wait < 40 && marked().length; wait++) await new Promise((resolve) => setTimeout(resolve, 50));
    signalAll("SIGKILL");
    await Promise.race([drained, new Promise((resolve) => setTimeout(resolve, 2000))]);
    process.stdout.write("", () => process.exit(code));
  };
  child.on("error", () => void finish(127));
  child.on("exit", (code, signal) => void finish(code ?? 128 + (signal ? constants.signals[signal] : 1)));
  child.stdin!.on("error", () => {});
  process.stdin.pipe(child.stdin!);
  process.stdin.on("end", () => { setTimeout(() => void finish(143), 5000).unref(); });
}

export const sandboxSupervisorSource = `(${sandboxSupervisor.toString()})()`;
