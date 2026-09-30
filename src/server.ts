// rsync-mcp — the /home/toxic rsync connection as a first-class MCP server.
// Bun/TypeScript, zero npm dependencies, stdio JSON-RPC (Content-Length framing),
// same house pattern as sovereign/tools/tmux-mcp/server.ts.
//
// Fork lineage: jasonlinjc/mcp-ssh-remote (system rsync + system ssh, ssh-config
// inheritance). Rewritten rsync-first for the estate: the connection is fully
// parameterized, both ends sandboxed, destructive ops gated.
//
// Connection (env, all non-secret — host alias + ssh keys, never values):
//   RSYNC_HOST         SSH host alias of the box holding the tree (default "pc")
//   RSYNC_REMOTE_ROOT  remote tree root (default "/home/toxic")
//   RSYNC_SSH_OPTS     extra ssh options (default "-o ServerAliveInterval=30 -o ConnectTimeout=10")
//   RSYNC_LOCAL_ROOT   local sandbox root (default "/home/toxic")
//   RSYNC_FLAGS        default rsync flags (default "-avzP")

import { resolve, sep } from "path";

const HOST = process.env.RSYNC_HOST ?? "pc";
const REMOTE_ROOT = (process.env.RSYNC_REMOTE_ROOT ?? "/home/toxic").replace(/\/+$/, "") || "/";
const SSH_OPTS = process.env.RSYNC_SSH_OPTS ?? "-o ServerAliveInterval=30 -o ConnectTimeout=10";
const LOCAL_ROOT = resolve(process.env.RSYNC_LOCAL_ROOT ?? "/home/toxic");
const FLAGS = (process.env.RSYNC_FLAGS ?? "-avzP").split(/\s+/).filter(Boolean);
const TOOL_TIMEOUT_MS = 270_000; // 4.5 min — under Gatehouse's 5-min tool timeout
const MAX_OUT = 24_000;

function writeRpc(res: object) {
  const s = JSON.stringify(res);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(s, "utf8")}\r\n\r\n${s}`);
}

// --- path sandboxing -------------------------------------------------------
// Remote paths are relative to REMOTE_ROOT; any ".." segment is refused outright.
function remoteSpec(rel: string, trailingSlash: boolean): string {
  const segs = (rel ?? "").split("/").filter((s) => s.length > 0 && s !== ".");
  if (segs.includes("..")) throw new Error(`refused: remote path escapes root: ${rel}`);
  const full = REMOTE_ROOT + "/" + segs.join("/");
  return `${HOST}:${full}${trailingSlash ? "/" : ""}`;
}

// Local paths must resolve inside LOCAL_ROOT.
function localPath(p: string): string {
  const abs = resolve(LOCAL_ROOT, p ?? "");
  if (abs !== LOCAL_ROOT && !abs.startsWith(LOCAL_ROOT + sep))
    throw new Error(`refused: local path escapes sandbox ${LOCAL_ROOT}: ${p}`);
  return abs;
}

function sshCmd(): string {
  return `ssh ${SSH_OPTS}`.trim();
}

function runRsync(args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolveP) => {
    const proc = Bun.spawn(["rsync", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    let out = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { proc.kill(); } catch { /* already gone */ }
    }, TOOL_TIMEOUT_MS);
    const pump = async () => {
      const dec = new TextDecoder();
      for await (const chunk of proc.stdout) out += dec.decode(chunk, { stream: true });
      for await (const chunk of proc.stderr) out += dec.decode(chunk, { stream: true });
      out += dec.decode();
    };
    (async () => {
      await pump();
      const code = await proc.exited;
      clearTimeout(timer);
      if (out.length > MAX_OUT) out = out.slice(0, MAX_OUT) + `\n…[truncated ${out.length - MAX_OUT} chars]`;
      if (killed) resolveP({ ok: false, out: `TIMEOUT after ${TOOL_TIMEOUT_MS / 1000}s\n${out}` });
      else if (code !== 0) resolveP({ ok: false, out: `rsync exit ${code}\n${out}` });
      else resolveP({ ok: true, out: out || "(no output)" });
    })();
  });
}

function withExcludes(args: string[], excludes?: string[]): string[] {
  for (const pat of excludes ?? []) {
    if (typeof pat === "string" && pat.length > 0 && !pat.includes("\0")) args.push("--exclude", pat);
  }
  return args;
}

const TOOLS = [
  {
    name: "rsync_connection_info",
    description:
      "Describe the configured rsync connection (host alias, remote root, ssh options, local sandbox). Read-only, no secrets — the route uses the SSH alias and existing keys.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "rsync_list",
    description:
      "List a remote directory through the rsync connection (rsync --list-only). Read-only, transfers nothing.",
    inputSchema: {
      type: "object",
      properties: {
        remote_path: { type: "string", description: "Path under the remote root, e.g. 'sovereign/projects' or '' for the root." },
      },
    },
  },
  {
    name: "rsync_pull",
    description:
      "Pull remote_path from the rsync connection into local_path (inside the local sandbox). Non-destructive to the remote.",
    inputSchema: {
      type: "object",
      properties: {
        remote_path: { type: "string" },
        local_path: { type: "string", description: "Destination inside the local sandbox root." },
        excludes: { type: "array", items: { type: "string" } },
        dry_run: { type: "boolean" },
      },
      required: ["remote_path", "local_path"],
    },
  },
  {
    name: "rsync_dry_run",
    description:
      "Preview exactly what a push or pull would transfer, without transferring anything. Always run this before a push with delete:true.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["push", "pull"] },
        local_path: { type: "string" },
        remote_path: { type: "string" },
        excludes: { type: "array", items: { type: "string" } },
      },
      required: ["direction", "local_path", "remote_path"],
    },
  },
  {
    name: "rsync_push",
    description:
      "Push local_path (inside the local sandbox) to remote_path. DESTRUCTIVE-CAPABLE: delete:true requires explicit confirm:true (run rsync_dry_run first).",
    inputSchema: {
      type: "object",
      properties: {
        local_path: { type: "string" },
        remote_path: { type: "string" },
        excludes: { type: "array", items: { type: "string" } },
        delete: { type: "boolean", description: "Pass --delete (remove remote files absent locally)." },
        dry_run: { type: "boolean" },
        confirm: { type: "boolean", description: "Must be true when delete:true. No default." },
      },
      required: ["local_path", "remote_path"],
    },
  },
];

let buf = Buffer.alloc(0);
process.stdin.on("data", async (chunk: Buffer) => {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const idx = buf.indexOf("\r\n\r\n");
    if (idx === -1) break;
    const len =
      parseInt((buf.subarray(0, idx).toString().match(/Content-Length:\s*(\d+)/i) || [])[1] || "0", 10);
    if (buf.length < idx + 4 + len) break;
    const msg = JSON.parse(buf.subarray(idx + 4, idx + 4 + len).toString());
    buf = buf.subarray(idx + 4 + len);

    const ok = (text: string) =>
      writeRpc({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } });
    const err = (code: number, message: string) =>
      writeRpc({ jsonrpc: "2.0", id: msg.id, error: { code, message } });

    if (msg.method === "initialize") {
      writeRpc({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "rsync-mcp", version: "1.0.0" },
        },
      });
    } else if (msg.method === "notifications/initialized") {
      // no-op
    } else if (msg.method === "tools/list") {
      writeRpc({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
    } else if (msg.method === "tools/call") {
      const a = msg.params.arguments || {};
      try {
        const name = msg.params.name;
        if (name === "rsync_connection_info") {
          ok(
            `rsync connection\n  host alias : ${HOST}\n  remote root: ${REMOTE_ROOT}\n  ssh        : ${sshCmd()}\n  local root : ${LOCAL_ROOT} (sandbox)\n  flags      : ${FLAGS.join(" ")}\nAuth: SSH alias + existing keys only — no credentials stored here.`,
          );
        } else if (name === "rsync_list") {
          const src = remoteSpec(a.remote_path ?? "", true);
          const r = await runRsync(["--list-only", ...FLAGS, "-e", sshCmd(), src]);
          r.ok ? ok(r.out) : err(-32603, r.out);
        } else if (name === "rsync_pull") {
          const src = remoteSpec(a.remote_path, true);
          const dst = localPath(a.local_path);
          const args = withExcludes([...FLAGS, "-e", sshCmd()], a.excludes);
          if (a.dry_run) args.push("--dry-run");
          args.push(src, dst + "/");
          process.stderr.write(`[rsync-mcp] PULL ${src} -> ${dst}${a.dry_run ? " (dry-run)" : ""}\n`);
          const r = await runRsync(args);
          r.ok ? ok(r.out) : err(-32603, r.out);
        } else if (name === "rsync_dry_run") {
          const lp = localPath(a.local_path);
          const rp = remoteSpec(a.remote_path, true);
          const args = withExcludes([...FLAGS, "-e", sshCmd(), "--dry-run", "--itemize-changes"], a.excludes);
          args.push(...(a.direction === "push" ? [lp + "/", rp] : [rp, lp + "/"]));
          process.stderr.write(`[rsync-mcp] DRY-RUN ${a.direction} local=${lp} remote=${rp}\n`);
          const r = await runRsync(args);
          r.ok ? ok(r.out) : err(-32603, r.out);
        } else if (name === "rsync_push") {
          if (a.delete === true && a.confirm !== true) {
            err(-32602, "Refused: rsync_push with delete:true requires explicit confirm:true. Run rsync_dry_run first.");
          } else {
            const src = localPath(a.local_path);
            const dst = remoteSpec(a.remote_path, true);
            const args = withExcludes([...FLAGS, "-e", sshCmd()], a.excludes);
            if (a.dry_run) args.push("--dry-run");
            if (a.delete) args.push("--delete");
            args.push(src + "/", dst);
            process.stderr.write(`[rsync-mcp] PUSH ${src} -> ${dst}${a.delete ? " (DELETE)" : ""}${a.dry_run ? " (dry-run)" : ""}\n`);
            const r = await runRsync(args);
            r.ok ? ok(r.out) : err(-32603, r.out);
          }
        } else {
          err(-32601, "unknown tool");
        }
      } catch (e: any) {
        err(-32603, String(e?.message || e));
      }
    }
  }
});
