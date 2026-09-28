# Installer fixture setups

Each folder is a pretend machine: `home/` stands for the home folder and `project/` for one
repository. `scripts/test-install.mjs` copies a setup into a fresh temp folder (links kept as
links), keeps the install record in a separate temp folder, and checks every run with
`scripts/setup-hash.mjs`. A missing `home/` or `project/` is created empty by the test. All paths
and values inside are made up (`/home/alex`, `fixture-...-not-for-output`).

| Setup | What it has | Profile used |
|---|---|---|
| `cc-max5x` | 150-line `~/.claude/CLAUDE.md` with an `@notes/style.md` import, a fenced `@path` that is not an import, and a prose line "Use opus for builds"; two helpers with no model; `settings.json` with permissions, hooks, env and apiKeyHelper (none of which may be printed); an auto-memory file and an output style | `profiles/cc-max5x.json` (user scope) |
| `codex` | `~/.codex/AGENTS.md` and `config.toml` with a model | `profiles/codex.json` (user scope) |
| `cursor` | project `AGENTS.md` and an existing `.cursor/rules/style.mdc` | `profiles/cursor.json` |
| `org-40` | shared repo: `CLAUDE.md` importing `@AGENTS.md`, a 60-line `AGENTS.md`, existing `.claude/agents` and `.codex/agents` helpers, `.claude/settings.json` with a 4-space indent | `profiles/org-40.json` |
| `empty` | nothing at all (no folder in git) | `profiles/empty.json` |
| `symlink` | `project/.claude` → `config/claude`, `project/AGENTS.md` → `docs/AGENTS.md`, `home/.claude` → `dotfiles/claude`; every link target is inside the setup | `symlink/profile.json`, `symlink/profile-user.json` |
| `agents-md-only` | a project with only `AGENTS.md`, used with Claude Code (must never get a `CLAUDE.md`) | `agents-md-only/profile.json` |
