// Child process for the tryLock stress test. argv: dir iters mode
//   mode "work":  iters × withLock(res) with an O_EXCL marker inside; prints the overlap count.
//                 A lock hook adds random 0–3 ms delays between the protocol's filesystem steps.
//   mode "crash": takes the lock and dies (SIGKILL) inside the critical section.
import { closeSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { __setLockHook, withLock } from "../../lib/util.mjs";

const [dir, iters, mode] = process.argv.slice(2);
const SAB = new Int32Array(new SharedArrayBuffer(4));
__setLockHook(() => { if (Math.random() < 0.5) Atomics.wait(SAB, 0, 0, Math.random() * 3); });
const res = join(dir, "res"), inside = join(dir, "inside");
if (mode === "crash") withLock(res, () => process.kill(process.pid, "SIGKILL"));
let overlaps = 0;
for (let i = 0; i < Number(iters); i++) {
  withLock(res, () => {
    let fd;
    try { fd = openSync(inside, "wx"); } catch { overlaps++; return; }
    closeSync(fd);
    Atomics.wait(SAB, 0, 0, Math.random() < 0.1 ? 1 : 0);
    try { unlinkSync(inside); } catch { overlaps++; }
  });
}
process.stdout.write(`${overlaps}\n`);
