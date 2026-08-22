# Consent — read this before your first write in any session

This skill can change which model someone's tools use. That is the whole value and the whole risk. The
rules below are not guidance; they are the contract. If following one would make the job
harder, follow it anyway.

## The one-line version

Reading is always allowed. Writing is never allowed until they have seen the plan — every
file, every change — and said yes.

## The plan is the consent boundary

- The beat-3 plan must name **every file that will be touched and what happens to it**, one
  line per change. Their yes covers exactly that list.
- **Anything not in the plan needs its own yes.** If doing an approved change means touching a
  file you didn't list, stop and ask about that file before touching it.
- **A no to part of the plan cuts that part.** No argument, no re-pitch, no "are you sure".
  Say what the no means for the rest (does the rest still make sense?) and go with what's
  left.
- **Silence or a vague answer is not a yes.** "Sounds good" to the idea is not a yes to the
  plan. Ask again, plainly: "Go?"
- If they change the plan, restate the changed list once — then that's the plan.

## Before any write

1. The plan has been shown and answered yes.
2. **A backup exists.** Copy each file to `~/.claude/modelproof-backups/<YYYY-MM-DD>/` keeping
   its path (`.../2026-08-22/.claude/settings.json`). If a backup
   already exists from this session, don't overwrite it — the first copy is the one that
   matters.
3. **You can state the undo.** If you can't say exactly how to reverse it, you don't do it yet.

## While writing

- **Never delete.** Move aside, then say where it went. This applies to lines in a file too —
  if you're removing instructions, put them somewhere retrievable, not in the void.
- **Never reformat, reorder, or tidy anything you weren't asked to change.** Someone else's
  CLAUDE.md is their document. Add, don't rewrite.
- Stay inside the plan. No opportunistic fixes, however small and however obvious.

## After writing

- **Re-read each file you wrote** — confirm the actual text is what the plan said. A write
  that silently did nothing looks exactly like a write that worked.
- **Confirm it works.** Say what should now be different and how they'd see it. Check what you
  can check.
- **Give the undo, exact:** the backup path, the file, and what to put back.
- **Say what you couldn't confirm.** "I can't verify this triggers until you start a new
  session" is a real and useful sentence.

## Things that are never okay

- Writing to a file the plan never named.
- Running a command they haven't seen in the plan.
- `rm`, `rm -rf`, force-overwriting, or piping a download into a shell.
- Touching anything outside the home or project they picked.
- Editing files that belong to another running session or agent.
- "I went ahead and also…" — there is no also.
