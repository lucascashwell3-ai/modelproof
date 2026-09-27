# Modelproof MCP server

Sourced **AI-model facts** that any MCP host (Claude Desktop, Cursor, …) can look up mid-workflow.
It reads the **same live `data/models.json`** the website renders, so its answers match the site and
stay current. Read-only, no auth, no side effects.

It never ranks models or names one for a job. It hands back the facts; the choice stays yours.

## Tools

- `compare_models({ names })` — models side by side: prices, context window, scores, release status,
  usage tips, and what the labs and reporters say about each model (the quote, its link and the date
  it was checked).
- `whats_new({ limit? })` — recent releases, newest first, each with its source.
- `list_models()` — every model with its key facts (a count of sourced quotes per model; call
  `compare_models` for the quotes themselves).

Every response carries the data's `as_of` date and a short disclaimer. Missing figures come back as
`null` ("not publicly sourced") — the server never invents a price or a benchmark.

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

Restart Claude Desktop. Ask "what do Claude Opus 5 and GPT-5.6 Sol cost, and what do their labs say about
them?" and it will call `compare_models`. MCP hosts ask you to approve the first tool call — that is
expected.

Override the data source with `Modelproof_DATA_URL` if needed.

## Changes in 0.3.0

The two ranking tools and the ranking fields on each model are retired (kept for history under
`archive/engine/`). Model entries now carry `sourced_claims` (quote + link + date) instead.

Independent tool · not affiliated with any model vendor.
