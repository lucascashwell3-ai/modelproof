# The data — where it comes from and how to read it

## Fetch (silent, every session)

Primary: `https://lucascashwell3-ai.github.io/modelproof/data/models.json`
Mirror:  `https://raw.githubusercontent.com/lucascashwell3-ai/modelproof/main/data/models.json`

If both fail: say so in one line inside the recommendation ("working from memory — numbers
may be stale, live data at modelproof"), and carry on with what you know. Never pretend
you fetched.

## Fields that matter

Top level: `as_of` (mention it once), `models[]`, `releases[]` (what changed lately, each
with a `why` line), `effort_ladders[]` (cost vs score at each effort setting — the curve
shows where extra spend stops buying quality).

Per model: `name`, `vendor`, `price_input` / `price_output` (USD per 1M tokens),
`context_window`, `coding_score` (0–100 blend), `benchmarks` (`swe_bench`, `gpqa`, `aime`,
`mmlu_pro`, `lmarena_elo`), `best_for` tags, `strengths`, `weaknesses`, `use_well` (2–4
practical tips — the heart of the answer), `confidence` on figures. `null` means unknown —
say unknown, never fill it in.

## Task → how to rank

| They're about to… | Rank by | Then weight |
|---|---|---|
| code / build / agent run | `coding_score`, then the effort ladder if present | price per task, context |
| research, analysis, strategy, hard reasoning | `gpqa`, `mmlu_pro` | price |
| writing, decks, presentations, docs | no writing benchmark exists and `lmarena_elo`/`mmlu_pro` are mostly empty — rank by `best_for` containing `writing`, then `strengths`, then the vendor's current flagship over its older one; say "no clean writing benchmark" once | price |
| overnight / bulk / batch / classify / extract / summarize | **price first** (`price_input`+`price_output`), with a capability floor | batch-API and cache discounts from `use_well` |
| long documents, big codebases | `context_window` first | price |
| "what's new" | `releases[]`, newest first, read the `why` | — |

Capability floor: never hand a quality task to a weak model because it's cheap. Bulk is the
one place price leads — and even there, the pick must clear the floor. The floor for bulk:
`best_for` fits, `confidence` is not low, and at least one benchmark or `use_well` entry is
filled in. Between models that all clear it, the cheapest **well-documented** one wins —
a $0.05 model with nothing but a coding score is not a pick for an unattended overnight run
on real customer data; it's the outside-kit fact. There is no summarization benchmark;
say so if asked, and lean on `best_for` + `strengths`.

## Effort matters as much as model

Name a setting only when the model has a dial (`use_well` or the ladder says so). If it
doesn't, say what it does instead in four words ("thinking on by default") and move on —
don't dress a no-dial model up as a setting.

When a model has an effort dial, the pick names the setting ("Opus 5 at medium"), because
the ladder often shows low/medium within a few points of max at half the cost. Pull that
from `effort_ladders` when a ladder covers *this kind of task* (today they're coding-only),
from `use_well` otherwise. For extraction/bulk the setting is almost always "thinking off" —
say it as judgment, not as a sourced number. Ladders carry `publisher`
and `caveat` — a vendor's own ladder is a shape, not a cross-lab ranking.
