---
name: new-project
description: Scaffold a new Python project with the standard layout, pyproject, tests, .env handling, git and a project CLAUDE.md, so every project starts reviewed-and-tested ready.
argument-hint: "[project-name] [one-line purpose]"
disable-model-invocation: true
---

# New project: $ARGUMENTS

Create the project in the folder the user names; if they name none, ask where (suggest a
`repositories` folder in their home directory).
Refuse to overwrite a folder that already has files; ask instead.

## Steps

1. Ask only what is missing: name, one-line purpose, whether it needs a web server (FastAPI),
   a database (SQLAlchemy + SQLite to start), or a model (Anthropic SDK behind a provider class).
2. Create this layout (omit parts not needed):

```
<name>/
  pyproject.toml        setuptools; requires-python >=3.11; deps chosen above;
                        tzdata on win32; [dev] = pytest, ruff; [tool.ruff] line-length = 100;
                        [tool.pytest.ini_options] testpaths = ["tests"]
  .env.example          placeholders only (ANTHROPIC_API_KEY=, MODEL_NAME=, DATABASE_URL=...)
  .gitignore            .venv/ .env *.db *.db-wal *.db-shm __pycache__/ *.egg-info/ .pytest_cache/ .ruff_cache/
  README.md             what it is, setup, commands
  CLAUDE.md             from the template below, filled in
  docs/                 spec / handover documents
  <package>/__init__.py
  <package>/config.py   one Settings dataclass loaded from .env via python-dotenv; nothing else reads os.environ
  tests/__init__.py
  tests/conftest.py
  tests/test_config.py  one real test so the suite runs green from day one
```

3. `python -m venv .venv`, then install with the venv's Python (`.venv\Scripts\python.exe` on
   Windows, `.venv/bin/python` elsewhere) `-m pip install -e .[dev]`, then run
   `pytest` and `ruff check .` — both must pass.
4. `git init`, first commit `Initial project skeleton`. Create a GitHub repo (`gh repo create
   <name> --private --source . --push`) only if the user confirms; default private.

## Project CLAUDE.md template

Use `~/.claude/coding-agent/templates/project-CLAUDE.md` (the Claude config folder in
the home directory, on any computer) and fill in every
section. Keep it under 200 lines: commands, architecture rules, conventions, status, out of
scope. Do not describe the file tree; Claude can read it.
