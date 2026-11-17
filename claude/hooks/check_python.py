"""PostToolUse check after Write/Edit on a .py file.

1. Syntax check: on a SyntaxError, exit 2 so the error goes straight back to Claude.
2. Only when you turn it on (environment variable CODING_AGENT_RUFF_FORMAT=1): if the file's own
   project opts in to ruff (ruff.toml, .ruff.toml or [tool.ruff] in its pyproject.toml) and has
   ruff in its .venv, format the file with it. Off by default because that runs a program from
   the project folder, and a repo you downloaded could ship a fake one.
Any internal error exits 0.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys


def project_root(path: str) -> str | None:
    """The nearest folder at or above the file that holds .git or pyproject.toml."""
    folder = os.path.dirname(os.path.abspath(path))
    while True:
        if os.path.exists(os.path.join(folder, ".git")) or os.path.isfile(os.path.join(folder, "pyproject.toml")):
            return folder
        parent = os.path.dirname(folder)
        if parent == folder:
            return None
        folder = parent


def uses_ruff(root: str) -> bool:
    if any(os.path.isfile(os.path.join(root, name)) for name in ("ruff.toml", ".ruff.toml")):
        return True
    pyproject = os.path.join(root, "pyproject.toml")
    if not os.path.isfile(pyproject):
        return False
    with open(pyproject, encoding="utf-8", errors="replace") as f:
        return "[tool.ruff" in f.read()


def find_project_ruff(path: str) -> str | None:
    """The ruff in the file's own project .venv, only if that project is configured for ruff."""
    root = project_root(path)
    if root is None or not uses_ruff(root):
        return None
    for candidate in (
        os.path.join(root, ".venv", "Scripts", "ruff.exe"),
        os.path.join(root, ".venv", "bin", "ruff"),
    ):
        if os.path.isfile(candidate):
            return candidate
    return None


def main() -> int:
    try:
        data = json.load(sys.stdin)
        path = (data.get("tool_input") or {}).get("file_path") or ""
        if not path.endswith(".py") or not os.path.isfile(path):
            return 0
        with open(path, encoding="utf-8") as f:
            source = f.read()
    except Exception:
        return 0

    try:
        compile(source, path, "exec", dont_inherit=True)
    except SyntaxError as e:
        print(
            f"Python syntax error in {path}, line {e.lineno}: {e.msg}\n  {(e.text or '').rstrip()}",
            file=sys.stderr,
        )
        return 2

    ruff = find_project_ruff(path) if os.environ.get("CODING_AGENT_RUFF_FORMAT") == "1" else None
    if ruff:
        try:
            subprocess.run([ruff, "format", "--quiet", path], capture_output=True, timeout=20)
        except (OSError, subprocess.SubprocessError):
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
