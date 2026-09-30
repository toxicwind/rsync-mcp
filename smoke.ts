import { spawn } from "child_process";
const srv = spawn("bun", ["src/server.ts"], { stdio: ["pipe", "pipe", "inherit"] });
function rpc(msg: any): Promise<any> {
  return new Promise((resolve) => {
    const s = JSON.stringify(msg);
    const req = `Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`;
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf("\r\n\r\n");
      if (idx !== -1) {
        const m = buf.subarray(0, idx).toString().match(/Content-Length:\s*(\d+)/i);
        const len = parseInt(m![1], 10);
        if (buf.length >= idx + 4 + len) {
          srv.stdout.off("data", onData);
          resolve(JSON.parse(buf.subarray(idx + 4, idx + 4 + len).toString()));
        }
      }
    };
    srv.stdout.on("data", onData);
    srv.stdin.write(req);
  });
}
const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
console.log("init:", JSON.stringify(init.result.serverInfo));
const tools = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
console.log("tools:", tools.result.tools.map((t: any) => t.name).join(","));
const info = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "rsync_connection_info", arguments: {} } });
console.log("info-host:", info.result.content[0].text.split("\n")[1].trim());
const evil = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "rsync_push", arguments: { local_path: "x", remote_path: "y", delete: true } } });
console.log("delete-no-confirm:", evil.error ? "REFUSED: " + evil.error.message.slice(0, 60) : "NO REFUSAL - BUG");
const esc = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "rsync_pull", arguments: { remote_path: "../../etc", local_path: "x" } } });
console.log("path-escape:", esc.error ? "REFUSED: " + esc.error.message.slice(0, 50) : "NO REFUSAL - BUG");
const lesc = await rpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "rsync_pull", arguments: { remote_path: "x", local_path: "../../tmp/evil" } } });
console.log("local-escape:", lesc.error ? "REFUSED: " + lesc.error.message.slice(0, 50) : "NO REFUSAL - BUG");
srv.kill();
console.log("SMOKE_DONE");
