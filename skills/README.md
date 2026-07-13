# MODELproof — take the advisor with you

Three ways to get MODELproof's neutral, cost-first model advice **inside your own AI workflow**,
from zero-effort to auto-invoked. All read the same live sourced data, so they stay current.

| | What it is | Best for | Install |
|---|---|---|---|
| **Prompt** | A paste-in system prompt | Anyone, any chatbot (works on free tiers) | Click **"Get my advisor prompt"** on the site, paste into Claude/ChatGPT |
| **Skill** | `modelproof-advisor/` — Claude auto-uses it when you're picking a model | Claude users who want it to trigger automatically | Copy the folder into your Claude skills, or install via the plugin marketplace |
| **MCP** | A server any AI host can call as a tool | Cross-tool / power users (Claude Desktop, Cursor) | See [`../mcp/`](../mcp/) |

## The skill (`modelproof-advisor/`)

Drop the `modelproof-advisor/` folder into your Claude skills directory (Claude Code:
`.claude/skills/`; Claude Desktop/plugins: per the marketplace flow). Then, whenever you ask something
like *"which model should I use for X?"* or *"am I overpaying for Opus?"*, Claude uses the skill: it
**fetches the live MODELproof data** and gives a sourced, cost-first answer — naming a cheaper option
when one exists and never favoring a lab.

The skill has no bundled data snapshot on purpose — it always fetches
`https://lucascashwell3-ai.github.io/modelproof/data/models.json` so it can't go stale. If it can't
browse, it says so and tells you to check the site.

Independent tool · not affiliated with any model vendor · unsourced figures stay blank, never guessed.
