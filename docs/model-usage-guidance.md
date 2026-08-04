# Model usage guidance — research + sourcing log

**Status:** in progress (started 2026-08-04)
**Branch:** `claude/model-usage-guidance-89u0eh`

## What this is

A new section for the site: for each model, how to actually use it well — sourced, not
guessed. Lucas's ask (2026-08-04, his framing):

> "a feature on the site that quickly informs and summarizes insights from AI labs on how
> best to use different models. So, like, for example, Opus 5 came out as a very different
> model. It required a lot less verification and assurance… if there was a quick blurb that
> was supported by Anthropic source material, then it would be really helpful for people to
> know that because then they would be able to use their models better."

Placement decision (Lucas, same conversation): this section goes **above the model map**;
the map stays but moves below it. Design of the section is a later session — rendered
options shown when he's at a screen, per the frontend house rules.

## The two tiers (Lucas's call, and he was right)

The site's honesty model says a blank means "not reliably sourced, never a guess." That
already coexists with a clearly-labelled weaker tier — the usage lenses ship with "each lens
measures a different population; none equals global market share." Guidance works the same way:

| Tier | Label | What qualifies |
|---|---|---|
| **A — Lab guidance** | "The lab says" | Vendor-published prompting guide, migration guide, model card, release notes, official cookbook. Cite the page. |
| **B — Reported experience** | "Users report" | A consensus visible across real, linkable public discussion. Cite the threads. Never presented as best practice — presented as what people are finding. |
| _(blank)_ | — | No published guidance and no clear consensus. Show nothing. |

Guardrail agreed in conversation: **tier B still carries links.** It is reported experience
with a receipt, not Claude's opinion dressed as consensus.

## Existing groundwork

`data/models.json` already has a `use_well` array on every model (1–4 tips each), plus a
`use_well_note`. Today those tips carry **no sources and no confidence flag** — the only part
of the dataset that doesn't. That is the gap this work closes. The Opus 5 entry already
contains the exact insight Lucas cited (over-verification), unsourced.

Today `use_well` only appears in the advisor result (capped at 3 tips, `assets/app.js:355`)
and in the MCP server payload. There is no way to browse it.

## Progress

- [x] Branch created and pushed (safety first — this is a mobile session)
- [ ] Tier A sweep: per-vendor published guidance
- [ ] Tier B sweep: linkable community consensus where tier A is thin
- [ ] Schema change + data written
- [ ] Validator updated to enforce sourcing
- [ ] Section design (later session, with Lucas at a screen)
