"""Self-test for the hooks. Run: py -3 ~/.claude/hooks/test_hooks.py

Feeds each hook the same JSON Claude Code sends and checks the exit code.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
FAKE_ANTHROPIC = "sk-ant-" + "api03-" + "x" * 40  # built at runtime so this file passes guard_secrets


def run(script: str, payload: dict) -> int:
    proc = subprocess.run(
        [sys.executable, "-I", os.path.join(HERE, script)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
    )
    return proc.returncode


def bash(cmd: str, cwd: str = ".") -> int:
    return run("guard_bash.py", {"tool_name": "Bash", "tool_input": {"command": cmd}, "cwd": cwd})


BLOCK = [
    "git push --force origin main",
    "git push origin main -f",
    "git push --force-with-lease",
    "git push origin +main",
    "git -C C:/repos/myapp push --force",
    "git reset --hard HEAD~1",
    "git clean -fdx",
    "git branch -D feature",
    "rm -rf /",
    "rm -rf ~",
    "rm -rf .",
    "rm -rf *",
    "rm -r -f /c/",
    "Remove-Item -Recurse -Force C:\\",
    "Remove-Item C:\\ -Recurse",
    "cat .env",
    "type .env",
    "Get-Content .env",
    "grep KEY .env",
    "cat C:/repos/myapp/.env",
    "head .env.local",
    "echo $ANTHROPIC_API_KEY",
    "Write-Output $env:ANTHROPIC_API_KEY",
    "printenv",
    "env",
    "printenv ANTHROPIC_API_KEY",
    "Get-ChildItem env:",
    "git status && env",
    "git add .env",
    "git add -f secrets.txt",
]

ALLOW = [
    "git push",
    "git push origin main",
    "git push -u origin feature/login",
    "git status --short",
    "git reset HEAD file.py",
    "git reset --soft HEAD~1",
    "git clean -n",
    "git branch -d merged-branch",
    "rm -rf build",
    "rm -rf .venv",
    "rm -rf ./dist",
    "Remove-Item -Recurse -Force .pytest_cache",
    "cat .env.example",
    "cp .env.example .env",
    "Copy-Item .env.example .env",
    "cat README.md",
    "grep -r environment docs/",
    ".venv/Scripts/python.exe -m pytest -q",
    "echo $PATH",
    "env PYTHONUTF8=1 python -m myapp.seed --show sample_shop",
    "npm set registry https://registry.npmjs.org",
    "git add myapp/agent/tools.py tests/test_tools.py",
    "python -m myapp.seed data/sample_shop.yaml",
]

SECRET_BLOCK = [
    {"file_path": "C:/repo/myapp/config.py", "content": f'KEY = "{FAKE_ANTHROPIC}"'},
    {"file_path": "C:/repo/.env.example", "content": f"ANTHROPIC_API_KEY={FAKE_ANTHROPIC}"},
    {"file_path": "C:/repo/docs/x.md", "new_string": "-----BEGIN RSA " + "PRIVATE KEY-----"},
    {"file_path": "C:/repo/a.py", "content": "token = 'EAA" + "B" * 80 + "'"},
    {"notebook_path": "C:/repo/analysis.ipynb", "new_source": f"key = \"{FAKE_ANTHROPIC}\""},
]
SECRET_ALLOW = [
    {"file_path": "C:/repo/.env", "content": f"ANTHROPIC_API_KEY={FAKE_ANTHROPIC}"},
    {"file_path": "C:/repo/.env.example", "content": "ANTHROPIC_API_KEY=sk-ant-..."},
    {"file_path": "C:/repo/tests/test_x.py", "content": 'api_key = "sk-ant-test"'},
    {"file_path": "C:/repo/a.py", "new_string": "settings.anthropic_api_key"},
]


def main() -> int:
    failures: list[str] = []

    for cmd in BLOCK:
        if bash(cmd) != 2:
            failures.append(f"guard_bash should BLOCK: {cmd}")
    for cmd in ALLOW:
        if bash(cmd) != 0:
            failures.append(f"guard_bash should ALLOW: {cmd}")

    # Commit with a staged .env is blocked; a clean commit is allowed.
    with tempfile.TemporaryDirectory() as repo:
        g = lambda *a: subprocess.run(["git", "-C", repo, *a], capture_output=True)  # noqa: E731
        g("init", "-q")
        with open(os.path.join(repo, "app.py"), "w") as f:
            f.write("x = 1\n")
        g("add", "app.py")
        if bash('git commit -m "clean"', cwd=repo) != 0:
            failures.append("guard_bash should ALLOW a commit of app.py")
        with open(os.path.join(repo, ".env"), "w") as f:
            f.write("A=1\n")
        with open(os.path.join(repo, "app.db"), "w") as f:
            f.write("")
        g("add", "-f", ".env", "app.db")
        if bash('git commit -m "oops"', cwd=repo) != 2:
            failures.append("guard_bash should BLOCK a commit with staged .env / .db")
        if bash(f'git -C "{repo}" commit -m "oops"', cwd=".") != 2:
            failures.append("guard_bash should BLOCK git -C <repo> commit with staged .env")

    for ti in SECRET_BLOCK:
        if run("guard_secrets.py", {"tool_name": "Write", "tool_input": ti}) != 2:
            failures.append(f"guard_secrets should BLOCK: {ti['file_path']}")
    for ti in SECRET_ALLOW:
        if run("guard_secrets.py", {"tool_name": "Write", "tool_input": ti}) != 0:
            failures.append(f"guard_secrets should ALLOW: {ti['file_path']}")

    with tempfile.TemporaryDirectory() as d:
        good, bad = os.path.join(d, "good.py"), os.path.join(d, "bad.py")
        with open(good, "w", encoding="utf-8") as f:
            f.write('greeting = "héllo wörld ✓"\n')
        with open(bad, "w", encoding="utf-8") as f:
            f.write("def broken(:\n    pass\n")
        if run("check_python.py", {"tool_input": {"file_path": good}}) != 0:
            failures.append("check_python should ALLOW valid Python with non-ASCII text")
        if run("check_python.py", {"tool_input": {"file_path": bad}}) != 2:
            failures.append("check_python should REPORT a syntax error")
        if run("check_python.py", {"tool_input": {"file_path": os.path.join(d, "notes.md")}}) != 0:
            failures.append("check_python should ignore non-Python files")

    # ruff runs only from the file's own project, and only when that project asks for ruff.
    sys.path.insert(0, HERE)
    import check_python

    def fake_ruff(folder: str) -> None:
        os.makedirs(os.path.join(folder, ".venv", "Scripts"), exist_ok=True)
        open(os.path.join(folder, ".venv", "Scripts", "ruff.exe"), "w").close()

    with tempfile.TemporaryDirectory() as d:
        outer, project = d, os.path.join(d, "repo")
        os.makedirs(os.path.join(project, ".git"))
        target = os.path.join(project, "app.py")
        fake_ruff(outer)  # a stray .venv above the project
        if check_python.find_project_ruff(target) is not None:
            failures.append("check_python should NOT run a ruff from above the project root")
        fake_ruff(project)
        if check_python.find_project_ruff(target) is not None:
            failures.append("check_python should NOT run ruff in a project that has no ruff config")
        with open(os.path.join(project, "pyproject.toml"), "w") as f:
            f.write("[tool.ruff]\nline-length = 100\n")
        if check_python.find_project_ruff(target) is None:
            failures.append("check_python should run the project's ruff when pyproject asks for it")

    # Garbage input must never block (fail open).
    for script in ("guard_bash.py", "guard_secrets.py", "check_python.py"):
        proc = subprocess.run(
            [sys.executable, "-I", os.path.join(HERE, script)], input="not json", capture_output=True, text=True
        )
        if proc.returncode != 0:
            failures.append(f"{script} should fail open on bad input")

    total = len(BLOCK) + len(ALLOW) + 3 + len(SECRET_BLOCK) + len(SECRET_ALLOW) + 3 + 3 + 3
    if failures:
        print(f"FAILED {len(failures)} of {total}:")
        for line in failures:
            print("  -", line)
        return 1
    print(f"All {total} hook checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
