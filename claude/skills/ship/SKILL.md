---
name: ship
description: Pre-commit gate for changes already made — verify, independent code review (plus security review when relevant), fix findings, then commit (and push only if asked). Use when the user says ship it, commit this, or wrap up.
argument-hint: "[optional: commit message hint, or 'push' to also push]"
disable-model-invocation: true
---

# Ship the current changes

Arguments: $ARGUMENTS

1. **Scope.** `git status --short` and `git diff HEAD --stat`. List what will be committed. Flag
   anything that must not be committed (`.env`, `*.db`, `*.db-wal`, credentials, scratch scripts,
   large generated files) and leave it out.
2. **Verify.** Delegate to the `verifier` subagent. Stop on FAIL: report it, fix or ask.
3. **Review.** Delegate to `code-reviewer` on the diff. In parallel, `security-reviewer` if the
   diff touches secrets, auth, webhooks, personal data, LLM prompts/tools, or internet-facing code.
4. **Fix.** Check each finding; fix the real ones; say in one line why any is rejected. If
   anything changed, run `verifier` again.
5. **Commit.** Stage the intended files by name (not `git add -A` blindly). Message in the
   project's convention: imperative summary under 72 chars, blank line, what and why, any new
   dependency with its reason. End with the attribution trailer the session requires.
6. **Push** only if the arguments include `push` or the user asked in this conversation. Never
   force-push.
7. **Report:** commit hash and summary, checks run, review verdicts and fixes, anything left out.
