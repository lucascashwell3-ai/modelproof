# MODELproof — take the advisor with you

Three ways to get MODELproof's neutral, cost-first model advice **inside your own AI workflow**,
from zero-effort to auto-invoked. All read the same live sourced data, so they stay current.

The advisor answers two questions, in this order: **"what should I use from what I already
have — and how do I use it well?"** (per-model `use_well` tips: when thinking modes earn their
cost, when the cheap tier is enough, cache/context tactics), and only then **"should I consider
anything else?"** — a neutral, cost-first upgrade check that's just as happy to say "you're set."

| | What it is | Best for | Install |
|---|---|---|---|
| **Prompt** | A paste-in system prompt | Anyone, any chatbot (works on free tiers) | Click **"Get my advisor prompt"** on the site, paste into Claude/ChatGPT |
| **Skill** | `modelproof-advisor/` — Claude auto-uses it when you're picking a model | Claude users who want it to trigger automatically | Copy the folder into your Claude skills, or install via the plugin marketplace |
| **MCP** | A server any AI host can call as a tool | Cross-tool / power users (Claude Desktop, Cursor) | See [`../mcp/`](../mcp/) |

## The skill (`modelproof-advisor/`)

Drop the `modelproof-advisor/` folder into your Claude skills directory (Claude Code:
`.claude/skills/` in a project or `~/.claude/skills/` for everywhere; Claude Desktop/claude.ai:
Settings → Capabilities → Skills). Then, whenever you ask something like *"which model should I
use for X?"*, *"what's the best model I have for this?"*, or *"am I overpaying for Opus?"*,
Claude uses the skill: it **fetches the live MODELproof data** and answers your-kit-first — the
best of what you already pay for plus how to use it well — then a neutral upgrade check, never
favoring a lab.

The skill has no bundled data snapshot on purpose — it always fetches
`https://lucascashwell3-ai.github.io/modelproof/data/models.json` so it can't go stale. If it can't
browse, it says so and tells you to check the site.

Independent tool · not affiliated with any model vendor · unsourced figures stay blank, never guessed.
