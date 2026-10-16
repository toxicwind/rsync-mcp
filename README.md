# rsync-mcp

The `/home/toxic` **rsync connection as a first-class MCP server**.
Bun/TypeScript, zero npm dependencies, stdio JSON-RPC — the same house
pattern as `estate-scripts/tools/tmux-mcp/server.ts`.

## Lineage

Fork lineage: [jasonlinjc/mcp-ssh-remote](https://github.com/jasonlinjc/mcp-ssh-remote)
(MIT) — the system-rsync + system-ssh wrapping pattern, with `~/.ssh/config`
inheritance (so host aliases like `pc` resolve). Rewritten rsync-first for
the estate: the connection is parameterized, both ends are sandboxed, and
destructive operations are gated. Full upstream history is preserved in this
repo; the Bun rewrite lands on top.

## The connection

The estate's established rsync route, as found in shell history
(`estate-scripts-recon-20260928`):

```
rsync -avzP -e 'ssh -o ServerAliveInterval=30 -o ConnectTimeout=10' pc:/home/toxic/<path>/ <dest>
```

All knobs are env config (non-secret — host alias + existing SSH keys only,
never credential values):

| Env | Default | Meaning |
|---|---|---|
| `RSYNC_HOST` | `pc` | SSH host alias of the box holding the tree |
| `RSYNC_REMOTE_ROOT` | `/home/toxic` | Remote tree root; all remote paths are relative to it |
| `RSYNC_SSH_OPTS` | `-o ServerAliveInterval=30 -o ConnectTimeout=10` | Extra ssh options |
| `RSYNC_LOCAL_ROOT` | `/home/toxic` | Local sandbox root — local paths cannot escape it |
| `RSYNC_FLAGS` | `-avzP` | Default rsync flags |

## Tools

| Tool | Safety |
|---|---|
| `rsync_connection_info` | Read-only. Describes the route (no secrets). |
| `rsync_list` | Read-only. `rsync --list-only` of a remote dir. |
| `rsync_pull` | Copies remote → local sandbox. Non-destructive to remote. |
| `rsync_dry_run` | Preview a push/pull with `--itemize-changes`. Nothing transfers. |
| `rsync_push` | Copies local sandbox → remote. `delete:true` requires explicit `confirm:true` — run `rsync_dry_run` first. |

Path rules: remote `..` segments are refused; local paths must resolve
inside `RSYNC_LOCAL_ROOT`. Output capped at 24KB per call; per-call ceiling
4.5 min (under Gatehouse's 5-min tool timeout).

## Run

```sh
bun src/server.ts
```

## Gatehouse

Registered as the `rsync` stdio server in
`ranch/barn/gatehouse/mcp_config.json` (+ durable `mcp_config.json.dist`):

```json
{
  "name": "rsync",
  "command": "/home/toxic/.bun/bin/bun",
  "args": ["run", "/home/toxic/projects/rsync-mcp/src/server.ts"],
  "env": {
    "RSYNC_HOST": "pc",
    "RSYNC_REMOTE_ROOT": "/home/toxic",
    "RSYNC_LOCAL_ROOT": "/home/toxic"
  },
  "protocol": "stdio",
  "enabled": true,
  "health_check_interval": "15s",
  "tool_discovery_interval": "2m0s",
  "isolation": { "enabled": false, "mode": "none" },
  "quarantined": false
}
```

Restart Gatehouse through its owned path after config changes:

```sh
cd /home/toxic/estate && bin/pitchfork-restart gatehouse   # gatehouse daemon only
```
