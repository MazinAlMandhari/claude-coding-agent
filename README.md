# claude-coding-agent

A ready-made coding team for [Claude Code](https://claude.com/claude-code): seven specialist
subagents, a disciplined work loop, safety hooks, and a **My agents** panel that shows each agent
working as its own animated pixel crab.

Install it once and every project you open in Claude Code gets the same way of working:
**plan → tests first → build → verify → independent review → commit.**

## What you get

**7 subagents.** Each one is a specialist Claude hands a job to:

| Agent | Model | What it does | Edits code? |
| --- | --- | --- | --- |
| `planner` | Opus | Turns a request into a file-by-file plan with tests and risks | No |
| `test-writer` | Sonnet | Writes failing tests before the code exists (TDD) | Tests only |
| `verifier` | Sonnet | Runs tests, linters and the app; short pass/fail report | No |
| `code-reviewer` | Opus | Hunts real bugs, broken rules and missing tests in the diff | No |
| `security-reviewer` | Opus | Secrets, injection, auth, personal data, prompt injection | No |
| `debugger` | Opus | Finds the root cause with evidence, fixes it, adds a regression test | Yes |
| `ai-agent-engineer` | Opus | Prompts, tool schemas, agent loops, evals and model cost for LLM features | Yes |

**4 skills** (type them in Claude Code):

| Command | What it does |
| --- | --- |
| `/deliver <task>` | The whole loop: understand, plan, tests first, build, verify, review, fix, prepare the commit |
| `/ship [push]` | For changes already made: verify, review, fix, commit (push only if you say so) |
| `/handover` | End of a session: update the project's `CLAUDE.md` status and handover notes |
| `/new-project <name> <purpose>` | Scaffold a new Python project with tests, linting, git and its own `CLAUDE.md` |

**Coding rules.** General rules Claude follows in every project: the work loop, code standards,
git hygiene, and security and privacy. They live in your `~/.claude/CLAUDE.md` as one marked block.

**3 safety hooks.** These run automatically on every tool call. They catch common accidents;
they are not a security boundary (see [the limits](docs/how-it-works.md#limits-worth-knowing)):
- `guard_bash`: blocks force-push, `git reset --hard`, `git clean -f`, deleting broad paths,
  reading `.env`, printing secrets, and committing `.env`, database or key files.
- `guard_secrets`: blocks Claude's file edits that would put an API key, token or private key
  into any file except `.env`.
- `check_python`: syntax-checks every Python file Claude edits and sends errors straight back.
  Optionally it also formats the file with the project's own ruff (set the environment variable
  `CODING_AGENT_RUFF_FORMAT=1`; off by default, because it runs a program from the project folder).

**The My agents panel.** A side panel that opens by itself in each session, with:
- the crew lineup, where each agent is a pixel crab in its own costume and colour;
- one row per agent run, showing its task, model, context used, tokens, estimated cost and time;
- totals for cost, tokens and time;
- a progress bar above the message box for the current batch of runs (`1/2 done`, 50%).

`/my-agents` opens or closes the panel.

## Install

You need:
- the **Claude desktop app**, signed in, with the **Code** tab opened once (that downloads the
  engine the panel needs), or Claude Code 2.1.325 or newer;
- **Python 3.10+**;
- **git**.

**Windows** (PowerShell):

```powershell
git clone https://github.com/MazinAlMandhari/claude-coding-agent $HOME\claude-coding-agent
cd $HOME\claude-coding-agent
py install.py
```

**macOS / Linux**:

```bash
git clone https://github.com/MazinAlMandhari/claude-coding-agent ~/claude-coding-agent
cd ~/claude-coding-agent
python3 install.py
```

Then **start a new Claude Code session**. You should see the **My agents** panel on the right.
Type `/agents` to see the seven agents, and try `/deliver add a --verbose flag to the CLI`.

Last, open `~/.claude/CLAUDE.md` and fill in **About me** (your experience, languages, OS and how
you like answers). Claude reads it in every session.

### What the installer changes

The installer is safe to run again; it updates in place. It:
- backs up everything it is about to change to `~/.claude/backups/claude-coding-agent-<time>/`;
- copies the agents, skills, hooks, the rules and the panel into `~/.claude`, and records them
  in `~/.claude/claude-coding-agent-manifest.json`;
- adds the rules block to `~/.claude/CLAUDE.md`, keeping your own text in that file;
- **merges** into `~/.claude/settings.json`: deny rules for `.env` reads and force-push, the
  three hooks, and the panel plugin. Every other setting stays as it was;
- checks that the hooks really run and that the installed panel matches the repo byte for byte.

It never touches logins, conversations or memory. If one of your own agents, skills or hooks has
the same name as one of these (say your own `planner.md`), it stops before changing anything and
lists them: rename yours, or run with `--overwrite` to replace them (they are backed up).

It keeps the 5 newest backups. They include copies of `settings.json`, so if you keep API keys
in its `env` section, treat the backups folder as private too.

## Update

```bash
git pull
python3 install.py        # or: py install.py
```

## Remove

```bash
python3 install.py --uninstall        # or: py install.py --uninstall
```

This removes the files it installed, the rules block, its hooks and the panel plugin. It keeps
the deny rules (they may be yours too) and makes a backup first.

## Make it yours

- **Change an agent:** edit `claude/agents/<name>.md` in this repo, then run the installer again.
  Each agent is plain Markdown: a short header (name, description, tools, model) and its
  instructions.
- **Change the rules:** edit `claude/coding-agent/rules.md`, then run the installer again.
- **Rules for one project only:** put them in that project's own `CLAUDE.md`, which wins over the
  global rules. `/new-project` creates one from `claude/coding-agent/templates/project-CLAUDE.md`.
- **The panel:** see [docs/how-it-works.md](docs/how-it-works.md#the-my-agents-panel). After
  changing it, bump `version` in `claude/mods/agent-crew/.claude-plugin/plugin.json`.

## Tests

```bash
python3 -m unittest discover tests            # installer (31 tests)
python3 claude/hooks/test_hooks.py            # safety hooks (74 checks)
claude plugin test claude/mods/agent-crew     # the panel (Claude Code 2.1.325+)
```

## More

- [How it works](docs/how-it-works.md): the work loop, why the reviewers are separate agents,
  each hook, the panel, and the limits.
- Tested on Windows 11. The macOS/Linux path is written but not yet tried on a real machine.
- Licence: MIT ([LICENSE](LICENSE)). The pixel crab art and progress bar are adapted from
  savvy-progress (MIT), credited in [claude/mods/agent-crew/NOTICE](claude/mods/agent-crew/NOTICE).
