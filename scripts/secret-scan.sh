#!/usr/bin/env bash
# secret-scan.sh — high-precision secret detector for a single git repo.
# Scans TRACKED files only (so gitignored .env is never scanned).
# Exit 0 = clean, exit 1 = secret found (prints offenders).
#
# Used by: the pre-push git hook (blocks leaks) and sync-all.sh (gate before push).
# Curated, high-confidence patterns only — false positives would block auto-sync.
set -uo pipefail
repo="${1:-$(pwd)}"
cd "$repo" || exit 0

# --- 1. A tracked real .env is a failure. Allow templates (.env.example/.sample/.template/.dist) ---
tracked_env=$(git ls-files 2>/dev/null \
  | grep -E '(^|/)\.env([.][A-Za-z0-9_-]+)?$' \
  | grep -vE '\.(example|sample|template|dist)$' || true)
if [ -n "$tracked_env" ]; then
  echo "SECRET-SCAN FAIL [$repo]: a real .env file is tracked by git:"
  echo "$tracked_env" | sed 's/^/    /'
  exit 1
fi

# --- 2. High-confidence live-secret patterns in tracked content ---
# Anthropic, Stripe live, AWS, GitHub tokens, private keys, real Etherscan keys.
PATTERNS='sk-ant-(api03-)?[A-Za-z0-9_-]{40,}|sk_live_[A-Za-z0-9]{20,}|rk_live_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|ETHERSCAN_API_KEY[=: ]+[A-Z0-9]{30,}|4UQFGG19Y6RFXKQ9N6DPAZYCJPW3SCBV44'

# Exclude this scanner itself (it necessarily contains the patterns as regexes).
hits=$(git grep -nIE "$PATTERNS" -- . ':(exclude)scripts/secret-scan.sh' 2>/dev/null)
if [ -n "$hits" ]; then
  echo "SECRET-SCAN FAIL [$repo]: possible live secret in tracked files:"
  echo "$hits" | sed 's/^/    /' | head -20
  exit 1
fi
exit 0
