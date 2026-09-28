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

1. The plan has been shown and answered yes: the installer's plan output, word for word, and
   its hash. `apply --expect <hash>` refuses any other plan.
2. **The undo exists before the write.** The installer records every file's state in `MP`
   before it touches it, and apply prints the one undo command. You never make backups or
   copies of their files yourself.
3. **You can state the undo.** If you can't say exactly how to reverse it, you don't do it yet.

## While writing

- **Only the installer writes**, and only the items in the plan. You never edit, reformat,
  re-order or tidy their files. Someone else's CLAUDE.md is their document.
- **Never delete.** Undo moves our files aside inside `MP` and cuts only our block or keys.
- Stay inside the plan. No opportunistic fixes, however small and however obvious.

## After writing

- **Run `verify`** — it confirms each block appears once and every file matches what was
  planned. A write that silently did nothing looks exactly like a write that worked.
- **Say what should now be different** and how they'd see it (a new session loads the
  helpers).
- **Give the undo, exact:** the line apply printed.
- **Say what you couldn't confirm.** "The helpers load in your next session" is a real and
  useful sentence.

## Things that are never okay

- Writing to a file the plan never named.
- Running any command that writes to their setup other than the `apply` (or `undo`) they said
  yes to. `detect`, `plan`, `verify` and `status` only read (plan writes its file inside `MP`).
- `rm`, `rm -rf`, `sudo`, force-overwriting, or piping a download into a shell.
- Applying a plan whose hash is not the one they saw.
- Touching anything outside the home or project they chose.
- Editing files that belong to another running session or agent.
- "I went ahead and also…" — there is no also.
