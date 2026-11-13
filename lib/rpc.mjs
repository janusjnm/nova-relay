// rpc.mjs — host-to-host calls. Same host → in-process handler; other host → `ssh <host>
// nova-relay rpc <method>` over Tailscale with JSON on stdin/stdout. No listening ports.
import { spawn } from "node:child_process";
import { sleep } from "./util.mjs";

export class RpcError extends Error {
  constructor(msg, { network = false } = {}) { super(msg); this.network = network; }
}

function sshCall(cfg, host, method, payload, timeoutMs) {
  const h = cfg.hosts[host];
  const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=3",
    h.ssh, h.bin || "nova-relay", "rpc", method];
  return new Promise((resolve, reject) => {
    const child = spawn(cfg.ssh_bin || "ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new RpcError(`ssh ${host} ${method}: timeout`, { network: true })); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(new RpcError(`ssh ${host}: ${e.message}`, { network: true })); });
    child.on("close", (code) => {
      clearTimeout(timer);
      // ssh itself exits 255 on connection/DNS/auth problems (Tailscale down, box asleep).
      if (code === 255) return reject(new RpcError(`ssh ${host} unreachable: ${err.trim().split("\n").pop() || "exit 255"}`, { network: true }));
      let j;
      try { j = JSON.parse(out.trim().split("\n").pop() || "{}"); } catch { return reject(new RpcError(`ssh ${host} ${method}: bad reply (exit ${code}) ${err.trim().slice(-200)}`)); }
      if (j && j.error) return reject(new RpcError(`${host} ${method}: ${j.error}`));
      resolve(j);
    });
    child.stdin.end(JSON.stringify(payload ?? {}));
  });
}

// Retries only network failures, with backoff (1s, 4s, 16s by default).
export async function call(ctx, host, method, payload = {}, { tries = 3, baseMs = 1000, timeoutMs = 60_000 } = {}) {
  if (host === ctx.cfg.self) {
    const h = ctx.handlers[method];
    if (!h) throw new RpcError(`unknown rpc method: ${method}`);
    return h(ctx, payload);
  }
  if (!ctx.cfg.hosts[host]) throw new RpcError(`unknown host: ${host}`);
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await (ctx.sshCall || sshCall)(ctx.cfg, host, method, payload, timeoutMs);
    } catch (e) {
      last = e;
      if (!e.network) throw e;
      if (i < tries - 1) await sleep(baseMs * 4 ** i * (ctx.backoffScale ?? 1));
    }
  }
  throw last;
}
