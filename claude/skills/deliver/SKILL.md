---
name: deliver
description: Full delivery pipeline for a coding task — understand, plan, tests first, implement, verify, independent code and security review, fix, then prepare a commit. Use when the user asks to build a feature, a build-plan session, or any change that should arrive reviewed and tested.
argument-hint: "[task, e.g. 'step 3 of docs/PLAN.md' or 'add a --verbose flag']"
disable-model-invocation: true
---

# Deliver: $ARGUMENTS

Run this pipeline for the task above. Keep the task list current. Do not skip a gate; if a gate
can't be met, stop and say why.

## 1. Understand
- Read the project's `CLAUDE.md` and every spec it points to (e.g. `docs/HANDOVER.md`) for this task.
- Run `git status --short` and `git log --oneline -5`. If the tree has unrelated uncommitted
  changes, ask before mixing them into this work.
- Restate the goal and the acceptance criteria in a few lines.

## 2. Plan
- Delegate to the `planner` subagent with: the task, the spec section, the project rules, the
  files involved. For a task under ~50 lines in one or two files, plan inline instead.
- Show the plan to the user. Wait for approval if it makes a real design choice or the spec
  was ambiguous; otherwise continue and note the assumptions.

## 3. Tests first
- Delegate to `test-writer` with the plan's test list and the signatures.
- Confirm the new tests fail, and fail for the intended reason. Existing tests still pass.

## 4. Implement
- Write the code in the plan's step order, running the relevant tests after each step.
- Follow the project's patterns; no new dependency without a reason.
- If a test turns out wrong, fix it with a stated reason; never weaken it just to pass.
- If something fails and the cause isn't obvious within one attempt, delegate to `debugger`.

## 5. Verify
- Delegate to `verifier`. Required: RESULT: PASS. For user-facing changes ask it to exercise the
  changed path in the real app or CLI.

## 6. Review (independent)
- Delegate to `code-reviewer` on the diff (in parallel with `security-reviewer` when the change
  touches secrets, auth, webhooks, personal data, LLM prompts or tools, or internet-facing code).
- Check each finding yourself. Fix every real "Must fix" and "Should fix"; for any you reject,
  write one line why.
- After fixes, re-run `verifier`. If fixes were non-trivial, run `code-reviewer` once more on the
  new diff.

## 7. Wrap up
- Update the project's `CLAUDE.md` status section (and the handover doc if the project keeps one)
  when this task completes a planned milestone.
- Draft the commit message in the project's convention (e.g. a ticket prefix) listing what was
  built and any new dependency with its reason.
- Commit only if the user asked for it in this conversation; otherwise show the message and ask.
  Never push without being asked.
- Final report: what changed (files), test counts before and after, review verdicts and what was
  fixed, anything not done or not verified, and the next step from the plan.
