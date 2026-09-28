# Conflicts — how to spot each one

A helper file or rule that the rest of their setup overrides is worse than none: they think it
works. These are the ways that happens, in the order worth checking. All of it is read-only.
Finding a conflict never licenses editing their line; their line always stays. You say it,
one line each, under the plan (beat 3).

The installer already catches some of these itself (it marks the item `conflict`, or prints
a note). The rest are yours to judge from `detect`.

---

## 1. Contradicting model rules

**Where:** `heads_up[]` lines in always-loaded files (CLAUDE.md, AGENTS.md, imported files)
and `mentions[]` (memory, output styles).
**Looks like:** "use opus for everything", "never delegate", a model named for a job the
package gives a helper.
**Do:** ask to keep it as their choice (it becomes a role, `references/questions.md`). If they
keep a rule that fights a helper, say it: "your CLAUDE.md line 12 says X; the builder helper
says Y. Yours stays. Keep both?"

## 2. Duplicate helpers

**Where:** `agents[]` from detect.
**Looks like:** they already have a `code-reviewer` or `researcher` agent for the job a
Modelproof helper covers.
**Do:** say it in one line. Theirs stays untouched. Two helpers for one job means the tool
chooses between them, not always the one they meant: offer "no to N" for our twin.
A name collision (a non-Modelproof file already called `modelproof-*` or a clashing `name:`)
is caught by the installer as a `conflict` item — it is never overwritten.

## 3. Effort rules

**Where:** `settings[]` effort keys (values printed), `heads_up` lines like "always think
hard", "max effort".
**Do:** their setting stays. The package states effort as facts plus a link, never "always
use max". If they asked for a cap and one exists, the installer notes it and leaves it.

## 4. Absolutes

**Where:** `heads_up` lines with always / never / only plus a model or lab.
**Do:** an absolute from them is a preference: "never X" goes into `never`, "only X" into the
matching role — after they confirm. Not a fight.

## 5. Size

**Where:** `files[].lines` for every always-loaded file.
**Do:** measure, don't estimate. The plan shows each target's lines before → after. If an
always-loaded file is already long (Claude Code's docs advise keeping CLAUDE.md short), say
the number once. The package never adds to CLAUDE.md; offering a trim is never part of this
plan.

## 6. Loads twice

**Where:** the plan's notes ("may load twice"), `claude_reads_project_agents_md: "unsure"`,
an old copy of the package at the other scope (the installer refuses a second text copy for
one tool across user and project: a `conflict` item).
**Do:** say which file loads twice and let them choose which scope keeps it.

## 7. Ignored model lines

**Where:** `env.subagent_model_force` true; a tool with no documented model string (Cursor
files then say `inherit`, and the plan notes it).
**Do:** say it first, before "Go?": "While `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is set, Claude
Code ignores the model line in every helper file." Unenforced parts are plain text only.

## 8. Things that rewrite files

**Where:** a `hooks` key in `settings[]`; `files[].real_path` or plan lines with `real path:`
(a dotfile manager or synced folder); an old `modelproof-advisor` copy in a skills folder.
**Do:** one line each: "Your settings have hooks; if one rewrites these folders, the files
may change after install." A link: the plan writes at the real path shown. An old skill
copy: mention it; moving it is its own yes, never part of this plan.

---

## When nothing conflicts

One line: "Nothing in your setup fights this." Never manufacture a finding to look thorough.
A false conflict costs more trust than a missed one, because they'll check.
