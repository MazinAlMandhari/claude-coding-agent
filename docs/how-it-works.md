# How it works

## The idea

One Claude doing everything tends to grade its own homework: it plans, writes the code, decides
the code is fine, and moves on. This setup splits the work the way a good team would. The main
Claude session runs the project and hands each job to a specialist. The specialists that judge
the work (planner, verifier, reviewers) are read-only, and each starts fresh, seeing the code
without the reasoning that produced it. That's how they catch what the author missed.

Three layers make it work:

| Layer | Where | Enforced? |
| --- | --- | --- |
| Rules | the block in `~/.claude/CLAUDE.md` | Guidance: Claude follows them, but nothing stops a slip |
| Subagents and skills | `~/.claude/agents`, `~/.claude/skills` | Used when the rules or you call for them |
| Hooks and deny rules | `~/.claude/hooks`, `~/.claude/settings.json` | Enforced by Claude Code on every tool call |

Rule of thumb: anything that must **never** happen belongs in a hook, not in the rules.

## The work loop

```
understand → plan → tests first → implement → verify → review → fix → commit → report
              │         │                        │         │
           planner  test-writer               verifier  code-reviewer (+ security-reviewer)
                                                 ▲
                                   debugger when something fails and the cause isn't obvious
```

1. **Understand.** Claude reads the project's `CLAUDE.md` and specs, then restates the goal. It
   asks only when an ambiguity would change the design.
2. **Plan.** For anything over ~50 lines or more than two files, the `planner` writes a
   file-by-file plan: signatures, test names, steps and risks. You see it before code is written.
3. **Tests first.** For logic with rules (money, time, permissions, parsing), the `test-writer`
   writes tests that fail for the right reason before the code exists.
4. **Implement** in small steps, running the tests after each one.
5. **Verify.** The `verifier` runs the full suite, the linters and type checks, and the app itself
   for user-facing changes. It reports PASS or FAIL with evidence.
6. **Review.** The `code-reviewer` checks the diff for real bugs and missing tests. The
   `security-reviewer` joins when the change touches secrets, auth, personal data, webhooks, LLM
   prompts or tools, or anything on the internet. Claude checks each finding, fixes the real
   ones, and verifies again.
7. **Commit** only when you asked, and never with `.env`, keys or databases in it.
8. **Report:** what changed, what was tested and how, and what is not done or not verified.

`/deliver <task>` runs the whole loop. `/ship` runs steps 5 to 8 on changes that already exist.

## The agents

Each agent is a Markdown file in `~/.claude/agents/`. The header gives its name, a description
(Claude uses it to decide when to call the agent), the tools it may use, and its model. The body
is its instructions.

- **planner** (Opus, read-only) reads the code and its callers first, then outputs a fixed shape:
  goal, constraints, design decisions with the rejected alternative, files, tests, steps and
  risks. It never writes the implementation.
- **test-writer** (Sonnet, test files only) lists the behaviours before writing any test: the
  happy path, every rule, boundaries and failure paths. Its tests are deterministic, with a
  fixed clock and no network or real model calls. For new features they must fail for the
  intended reason.
- **verifier** (Sonnet, read-only) runs what the project has configured and reports facts only.
  It skips tools that aren't installed (and says so), and flags files that must not be committed.
- **code-reviewer** (Opus, read-only) reads callers and tests, not just the diff. Before reporting
  a finding it tries to disprove it, and keeps only findings with a concrete failure scenario.
  Verdicts are APPROVE, APPROVE WITH NITS, or CHANGES REQUIRED.
- **security-reviewer** (Opus, read-only) goes through a checklist: secrets, injection, auth and
  tenant isolation, webhooks, LLM safety, personal data and dependencies. Every finding comes
  with a severity, how it would be exploited, and the fix.
- **debugger** (Opus) reproduces the problem, tests one hypothesis at a time, fixes the root
  cause, and adds a regression test. It never weakens a test to make it pass.
- **ai-agent-engineer** (Opus) is for products that use an LLM. The model acts only through
  validated tools, facts come from data, every agent loop has limits, a provider interface keeps
  the model swappable, and changes are judged by an eval set.

Opus is used where judgement matters (planning, review, debugging), and Sonnet for the faster,
mechanical jobs.

## The skills

Skills are workflows you start with a slash command. They are in `~/.claude/skills/<name>/SKILL.md`
and marked `disable-model-invocation`, so they only run when **you** type them.

## The safety hooks

Claude Code runs these Python scripts around tool calls. Each script gets the call as JSON and
answers with an exit code: 0 lets the call through, 2 blocks it and tells Claude why.

| Hook | When | Blocks or checks |
| --- | --- | --- |
| `guard_bash.py` | before every shell command | force-push, `reset --hard`, `clean -f`, deleting broad paths, reading `.env`, printing secrets, committing `.env` / databases / keys |
| `guard_secrets.py` | before every file write or edit | API keys, tokens and private keys written into any file except `.env` |
| `check_python.py` | after every Python edit | syntax errors; optionally formats with the project's ruff (`CODING_AGENT_RUFF_FORMAT=1`) |

The installer also adds deny rules to `settings.json`: the Read tool can't open `.env`,
`.env.local` or `.env.production`, and `git push --force`, `git push -f` and `git reset --hard`
shell commands are refused, even if a hook is turned off.

To test the hooks after changing them, run `python3 claude/hooks/test_hooks.py` (74 checks).

## The My agents panel

The panel is a Claude Code plugin called `agent-crew`, in `claude/mods/agent-crew/`. It's written
in TypeScript against Claude Code's plugin API. It doesn't send data anywhere: it only reads the
events Claude Code gives it inside your session.

- **What it listens to.**
  - When one of the seven agents starts, it adds a run.
  - For each of that agent's model requests, it updates the context, tokens and cost.
  - When the agent's turn ends, it marks the run done or failed.
  - Agents outside the crew (for example the built-in Explore agent) are ignored.
- **Costs are estimates.** They are token counts times list prices, not your bill.
- **The crabs.** Every agent is a pixel crab in its own costume and colour:
  - planner: cap and clipboard;
  - test-writer: scientist;
  - verifier: engineer;
  - code-reviewer: detective;
  - security-reviewer: knight;
  - debugger: bug hunter;
  - ai-agent-engineer: astronaut.

  While that agent works, its crab dances: it sways side to side with a little hop, raises the
  claw on the side it leans to, walks in place (the astronaut floats), and its prop moves. It all respects reduced-motion
  settings.
- **The run list** shows the latest batch: runs that overlap in time, from the first start until
  all have finished. Runs from earlier batches fold under **▸ Earlier**; click it to open them.
  The totals at the top still count the whole session.
- **The progress bar** above the message box counts the current batch: the agents started since
  the last batch finished. `×7` opens the panel; `✕` hides the bar until the next batch.
- **In the terminal** the same panel is drawn with text and symbols instead of pictures.
- **♪ Dance** in the panel, or `/crew-dance`, makes every crab dance for 30 seconds without
  running an agent (in the terminal, the crew's symbols light up). It's only a show: no model is
  called and no run is listed. `/crew-dance` also expands a collapsed panel so the dance shows.
- `/my-agents` opens or closes the panel. A model tool, `crew_status`, lets Claude read the
  panel's state when something looks wrong.

After changing the panel, run `claude plugin test claude/mods/agent-crew`, bump `version` in
`.claude-plugin/plugin.json`, and run the installer. If you forget the version bump, the
installer reports that the installed panel differs from the repo, because Claude Code keeps
the old copy for an unchanged version number.

## Limits worth knowing

- The rules are guidance. A long session can drift from them; `/deliver` and `/ship` bring
  Claude back to the loop.
- Each subagent run costs tokens. Opus reviewers are the expensive part, and the panel shows
  roughly how much.
- The hooks are accident guards, not a security boundary. They match command text, so:
  - a command that merely *mentions* force-push (in an echo, say) is blocked too. That's
    deliberate: false alarms are cheaper than a lost branch;
  - the same action done another way (a Python one-liner that runs git, copying `.env`
    before reading it, writing a key with a shell command instead of a file edit) is not
    caught;
  - if a hook itself fails, it lets the call through, so a bug never stops your work.
  Keep Claude Code's permission prompts on for anything you don't want run unasked.
- The code-quality hook knows Python only. For other languages, `verifier` runs the project's
  own linters.
- The macOS/Linux install path is written but has not been tried on a real machine yet.
