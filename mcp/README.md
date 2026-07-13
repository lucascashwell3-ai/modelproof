# MODELproof MCP server

A neutral, cost-first **AI-model advisor** that any MCP host (Claude Desktop, Cursor, …) can call
mid-workflow. It reads the **same live `data/models.json`** the website renders, so its answers match
the site and stay current. Read-only, no auth, no side effects.

## Tools

- `recommend_model({ task_description?, task?, cost_attitude?, labs? })` — the pick + runners-up for a
  task and budget attitude, plus a neutral "outside your labs…" note when relevant.
- `compare_models({ names })` — sourced facts side by side.
- `whats_new({ limit? })` — recent releases worth knowing about.
- `list_models()` — every model with key facts.

Every response carries the data's `as_of` date and a disclaimer. Missing figures come back as `null`
("not publicly sourced") — the server never invents a price or benchmark.

## Run it (local, stdio)

```bash
cd mcp
npm install
node server.js      # speaks MCP over stdio
```

### Add to Claude Desktop

In `claude_desktop_config.json` → `mcpServers`:

```json
{
  "mcpServers": {
    "modelproof": { "command": "node", "args": ["/absolute/path/to/modelproof/mcp/server.js"] }
  }
}
```

Restart Claude Desktop. Ask "which model should I use for cheap bulk classification?" and it will call
`recommend_model`. **Note:** MCP hosts gate the first tool call behind a user approval — the model
*chooses* to call it, the host asks the user once. That's expected; it is not silent.

Override the data source with `MODELPROOF_DATA_URL` if needed.

## Deploying as a remote connector (follow-up)

This is the local **stdio** build. To let others add it by pasting one URL (a remote connector), wrap
the same tool handlers in a Streamable-HTTP transport and host it serverless (Cloudflare Worker /
Vercel edge — free tier fits, since it only proxies a static JSON file). That's a hosting decision,
not code work — the tool logic above is transport-agnostic and ready to reuse.

Independent tool · not affiliated with any model vendor.
