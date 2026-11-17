# Coding agent rules (all projects)

These rules come from the claude-coding-agent setup and apply in every repository. A project's
own `CLAUDE.md` wins where the two disagree. Your own notes go in `~/.claude/CLAUDE.md`.

## How to work on a task

1. **Understand.** Read the project's `CLAUDE.md` and any spec or handover docs first. Restate the
   goal in one or two lines. If something is genuinely ambiguous and changes the design, ask;
   otherwise pick the sensible default and say so.
2. **Plan.** For anything over ~50 lines or touching more than two files, use the `planner`
   subagent (or plan mode) and show the plan before writing code.
3. **Tests first** for logic with rules (money, time, permissions, parsing, state changes). Use the
   `test-writer` subagent, confirm the new tests fail for the right reason, then implement.
4. **Implement** in small steps, running the relevant tests after each step.
5. **Verify.** Use the `verifier` subagent: full test suite, lint/type checks if configured, and
   the app actually run when the change is user-facing. Never claim something works without
   having run it.
6. **Review before every commit.** Run `code-reviewer` on the diff. Also run `security-reviewer`
   when the change touches auth, secrets, personal data, webhooks, LLM prompts or tools, or
   anything reachable from the internet. Fix every real finding, re-verify, then commit.
7. **Report** honestly: what changed, what was tested and how, what is not done or not verified.

The `/deliver` skill runs this whole loop; `/ship` runs steps 5 to 7 on existing changes.

## Subagents (in ~/.claude/agents)

| Agent | Use it for |
| --- | --- |
| `planner` | Turning a spec into a file-by-file plan with tests and risks. Read-only. |
| `test-writer` | Writing failing tests from a spec before the code exists. |
| `verifier` | Running tests, linters and the app; returning a short pass/fail report. |
| `code-reviewer` | Reviewing a diff for bugs, design, project rules, missing tests. Read-only. |
| `security-reviewer` | Secrets, injection, auth, personal data, prompt injection. Read-only. |
| `debugger` | Root-causing a failing test or bug with evidence before changing code. |
| `ai-agent-engineer` | Prompts, tool schemas, agent loops, evals and model cost for LLM features. |

Give each subagent a complete brief (it sees nothing of the conversation): the goal, the files,
the project rules that matter, and what "done" looks like. Check their output; don't relay it
blindly. Independent work goes to several subagents at once.

## Code standards

- Follow the project's existing language, patterns and tools over any default here.
- Small functions with one job. Names that say what things are. Comments explain *why*, not *what*.
- Simplest design that meets the need and survives the next likely change; no speculative
  abstractions, no shortcuts that will clearly have to be undone.
- Errors: validate input at the boundaries, fail loudly, never swallow exceptions silently, and
  give errors a message a non-developer could act on.
- Money is a decimal type, never float. Store times in UTC, timezone-aware; convert to local time
  only at the edges (display, input).
- Text shown to users must survive non-ASCII input; console programs write UTF-8.
- No new dependency without a one-line reason in the commit message.
- Tests: deterministic (inject the clock, no real network or model calls in unit tests), one
  behaviour per test, names that read as sentences.
- Python defaults when the project has none: 3.11+, type hints, pydantic at input boundaries,
  pytest, ruff, a `.venv` inside the project.

## Git

- Never commit or push unless asked in this conversation, or the project's workflow says so.
- Before committing: review done, tests pass, `git status` checked for stray files.
- Never commit `.env`, keys, databases, real user data, or large generated files.
- Commit messages: imperative summary line under 72 chars, blank line, then what and why. Follow
  the project's own convention when it has one.
- Never force-push, rewrite published history, or delete branches without asking.

## Security and privacy (non-negotiable)

- Secrets only in `.env` or the environment, read through the project's config module. Never
  print, log or paste a key, token or password.
- Follow the data-protection law that applies to the project: collect only what is needed, get
  consent where required, delete data when its purpose ends.
- Never use real people's data in tests, fixtures, examples or prompts sent to a model during
  development. Use invented names and obviously fake numbers.
- LLM features: the model acts only through validated tools; every tool checks that the ids it
  receives belong to the current user or tenant; all user text is untrusted (prompt injection).

## Communication

- Be direct and concise. Lead with the answer or the result, then the detail.
- When recommending something, say why in one line and name the trade-off.
- Flag legal, cost or security risks you notice, briefly, even if not asked.
