---
name: handover
description: End-of-session handover — update the project's CLAUDE.md status and its handover/spec doc so the next session (or another agent) can continue without this conversation. Use at the end of a build session or before a long break.
disable-model-invocation: true
---

# Session handover

1. Read the project's `CLAUDE.md`, its handover doc (e.g. `docs/HANDOVER.md`), `git log --oneline -10`
   and `git status --short`.
2. Update the **Status** section of `CLAUDE.md`: what is done (with test count from an actual
   `pytest` run), what is next. Add any new rule or gotcha learned this session that a future
   session would otherwise rediscover the hard way (one or two lines each). Remove anything now
   false. Keep the file under 200 lines.
3. Update the handover doc: mark the finished session, record design decisions made this session
   and why, and list open questions for the user. Do not rewrite sections that didn't change.
4. Show the diff of both files and a short summary. Commit only if asked.
