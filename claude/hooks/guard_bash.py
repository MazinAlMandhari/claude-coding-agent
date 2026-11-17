"""PreToolUse guard for Bash and PowerShell commands.

Blocks a small set of destructive or secret-leaking commands. Exit code 2 blocks the call and
sends stderr to Claude; exit 0 lets the normal permission flow decide. Any internal error exits 0
(fail open) so a bug here never stops normal work.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys


def _trusted_git() -> str | None:
    """git from PATH, never from the current folder.

    This hook runs before the person approves the command, inside whatever project Claude is in.
    A bare "git" can resolve to a git.exe planted in that folder on Windows, so PATH is searched
    by hand and the current folder (and relative entries) are skipped.
    """
    here = os.path.abspath(os.getcwd())
    names = ("git.exe", "git") if os.name == "nt" else ("git",)
    for entry in os.environ.get("PATH", "").split(os.pathsep):
        if not entry or not os.path.isabs(entry) or os.path.abspath(entry) == here:
            continue
        for name in names:
            candidate = os.path.join(entry, name)
            if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                return candidate
    return None

# Files that must never be committed.
FORBIDDEN_FILES = re.compile(
    r"(^|/)(\.env|\.env\.(local|prod|production|dev|development|staging))$"
    r"|\.(db|sqlite|sqlite3|db-wal|db-shm|pem|key|p12|pfx)$"
    r"|(^|/)(id_rsa|id_ed25519|credentials\.json|service-account.*\.json)$",
    re.IGNORECASE,
)

# A reference to a real .env file (not .env.example / .env.sample / .env.template).
ENV_FILE = r"(?<![\w.])\.env(\.(local|prod|production|dev|development|staging))?(?![\w.-])"
READ_VERBS = (
    r"\b(cat|type|less|more|head|tail|bat|nl|xxd|od|strings|grep|rg|ag|sed|awk|findstr"
    r"|get-content|gc|select-string|sls|import-csv|notepad)\b"
)

BROAD_TARGET = r"(/|~|~/|\*|\.|\.\.|\$HOME|\$env:USERPROFILE|[A-Za-z]:[\\/]?|/c|/c/)(?=\s|$|['\"])"

RULES: list[tuple[re.Pattern[str], str]] = [
    (
        re.compile(r"\bgit\b[^\n;&|]*\bpush\b[^\n;&|]*(\s--force(-with-lease)?\b|\s-f\b|\s\+\S)", re.I),
        "force-push rewrites published history",
    ),
    (re.compile(r"\bgit\b[^\n;&|]*\breset\b[^\n;&|]*--hard\b", re.I), "git reset --hard discards work"),
    (re.compile(r"\bgit\b[^\n;&|]*\bclean\b[^\n;&|]*\s-[a-z]*f", re.I), "git clean -f deletes untracked files"),
    (
        re.compile(r"\bgit\b[^\n;&|]*\bbranch\b[^\n;&|]*\s-D\b"),
        "git branch -D deletes an unmerged branch",
    ),
    (
        re.compile(r"\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*\s+(-[a-z]*\s+)*" + BROAD_TARGET, re.I),
        "recursive delete of a broad path",
    ),
    (
        re.compile(r"\b(remove-item|rm|ri|del|rd|rmdir)\b[^\n;&|]*-recurse[^\n;&|]*\s" + BROAD_TARGET, re.I),
        "recursive delete of a broad path",
    ),
    (
        re.compile(r"\b(remove-item|ri|del|rd|rmdir)\s+" + BROAD_TARGET + r"[^\n;&|]*-recurse", re.I),
        "recursive delete of a broad path",
    ),
    (re.compile(READ_VERBS + r"[^\n;&|]*" + ENV_FILE, re.I), "reading a .env file would expose secrets"),
    (
        re.compile(r"\b(echo|printf|write-output|write-host)\b[^\n;&|]*\$(\{)?(env:)?\w*(KEY|TOKEN|SECRET|PASSWORD)", re.I),
        "printing a secret environment variable",
    ),
    (
        # Bare `env` / `printenv` / `set` (no arguments) or listing the PowerShell env: drive.
        re.compile(
            r"(^|[;&|]\s*)(printenv|env|set|(gci|ls|dir|get-childitem)\s+env:\\?)\s*($|[;&|])", re.I
        ),
        "dumping environment variables would expose secrets",
    ),
    (
        re.compile(r"\bprintenv\s+\w*(KEY|TOKEN|SECRET|PASSWORD)", re.I),
        "printing a secret environment variable",
    ),
    (re.compile(r"\bgit\b[^\n;&|]*\badd\b[^\n;&|]*" + ENV_FILE, re.I), "staging a .env file"),
    (re.compile(r"\bgit\b[^\n;&|]*\badd\b[^\n;&|]*\s-f\b", re.I), "git add -f bypasses .gitignore"),
]


def _repo_dir(command: str, cwd: str) -> str:
    """Best guess at the directory a git command runs in."""
    m = re.search(r"\bgit\s+-C\s+(\"[^\"]+\"|'[^']+'|\S+)", command)
    if m:
        return m.group(1).strip("\"'")
    m = re.match(r"\s*cd\s+(\"[^\"]+\"|'[^']+'|\S+)\s*(&&|;)", command)
    if m:
        return m.group(1).strip("\"'")
    return cwd


def _staged_forbidden(command: str, cwd: str) -> list[str]:
    if not re.search(r"\bgit\b[^\n;&|]*\bcommit\b", command):
        return []
    repo = _repo_dir(command, cwd)
    git = _trusted_git()
    if git is None:
        return []
    names: list[str] = []
    for args in (["diff", "--cached", "--name-only"],) + (
        (["diff", "--name-only"],) if re.search(r"\bcommit\b[^\n;&|]*\s-[a-z]*a", command) else ()
    ):
        try:
            out = subprocess.run(
                # fsmonitor off: a repo's own config must not run a program through this check.
                [git, "-c", "core.fsmonitor=false", "-C", repo, *args],
                capture_output=True,
                text=True,
                timeout=5,
            ).stdout
        except (OSError, subprocess.SubprocessError):
            return []
        names += [n for n in out.splitlines() if FORBIDDEN_FILES.search(n.strip())]
    return sorted(set(names))


def check(command: str, cwd: str) -> str | None:
    """Return a reason to block, or None to allow."""
    for pattern, reason in RULES:
        if pattern.search(command):
            return reason
    bad = _staged_forbidden(command, cwd)
    if bad:
        return "commit would include files that must never be committed: " + ", ".join(bad)
    return None


def main() -> int:
    try:
        data = json.load(sys.stdin)
        command = (data.get("tool_input") or {}).get("command") or ""
        cwd = data.get("cwd") or "."
        reason = check(command, cwd)
    except Exception:  # fail open: a guard bug must not block normal work
        return 0
    if reason:
        print(
            f"Blocked by ~/.claude/hooks/guard_bash.py: {reason}. "
            "Find a safer way, or if the user really wants this, ask them to run it themselves.",
            file=sys.stderr,
        )
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
