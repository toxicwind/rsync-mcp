import { spawn } from "child_process";

// mode: "framed" = Content-Length framing; "lines" = mcp-go newline-delimited JSON
const mode = process.argv[2] === "lines" ? "lines" : "framed";
const srv = spawn("bun", ["src/server.ts"], { stdio: ["pipe", "pipe", "inherit"] });

function rpc(msg: any): Promise<any> {
  return new Promise((resolve) => {
    const s = JSON.stringify(msg);
    const req = mode === "framed"
      ? `Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`
      : s + "\n";
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (mode === "framed") {
        const idx = buf.indexOf("\r\n\r\n");
        if (idx === -1) return;
        const m = buf.subarray(0, idx).toString().match(/Content-Length:\s*(\d+)/i);
        const len = parseInt(m![1], 10);
        if (buf.length < idx + 4 + len) return;
        srv.stdout.off("data", onData);
        resolve(JSON.parse(buf.subarray(idx + 4, idx + 4 + len).toString()));
      } else {
        // mcp-go style: one JSON object per line, skip non-JSON lines.
        // Process ALL complete lines in the buffer each data event.
        while (true) {
          const nl2 = buf.indexOf("\n");
          if (nl2 === -1) break;
          const t = buf.subarray(0, nl2).toString().trim();
          buf = buf.subarray(nl2 + 1);
          if (!t) continue;
          try {
            const d = JSON.parse(t);
            if (d.id === msg.id) {
              srv.stdout.off("data", onData);
              resolve(d);
              return;
            }
          } catch { /* skip non-JSON (e.g. Content-Length header lines) */ }
        }
      }
    };
    srv.stdout.on("data", onData);
    srv.stdin.write(req);
  });
}
console.log(`mode: ${mode}`);
const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
console.log("init:", JSON.stringify(init.result.serverInfo));
const tools = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
console.log("tools:", tools.result.tools.map((t: any) => t.name).join(","));
const info = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "rsync_connection_info", arguments: {} } });
console.log("info-host:", info.result.content[0].text.split("\n")[1].trim());
const evil = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "rsync_push", arguments: { local_path: "x", remote_path: "y", delete: true } } });
console.log("delete-no-confirm:", evil.error ? "REFUSED ok" : "NO REFUSAL - BUG");
const esc = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "rsync_pull", arguments: { remote_path: "../../etc", local_path: "x" } } });
console.log("path-escape:", esc.error ? "REFUSED ok" : "NO REFUSAL - BUG");
srv.kill();
console.log("SMOKE_DONE");
