"""PreToolUse guard for Write, Edit, MultiEdit and NotebookEdit: block real-looking secrets outside .env files.

Exit 2 blocks the write and tells Claude why. Any internal error exits 0 (fail open).
"""

from __future__ import annotations

import json
import os
import re
import sys

ALLOWED_BASENAMES = {".env", ".env.local"}

SECRET_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"sk-ant-[A-Za-z0-9_\-]{20,}"), "Anthropic API key"),
    (re.compile(r"\bsk-(proj-)?[A-Za-z0-9]{32,}"), "OpenAI-style API key"),
    (re.compile(r"\bEAA[A-Za-z0-9]{60,}"), "Meta (Facebook / WhatsApp) access token"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "AWS access key id"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}"), "GitHub token"),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{50,}"), "GitHub token"),
    (re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}"), "Slack token"),
    (re.compile(r"-----BEGIN (RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----"), "private key"),
]


def find_secret(text: str) -> str | None:
    for pattern, label in SECRET_PATTERNS:
        if pattern.search(text):
            return label
    return None


def main() -> int:
    try:
        data = json.load(sys.stdin)
        tool_input = data.get("tool_input") or {}
        path = tool_input.get("file_path") or tool_input.get("notebook_path") or ""
        if os.path.basename(path) in ALLOWED_BASENAMES:
            return 0
        text = "\n".join(
            str(tool_input.get(k) or "") for k in ("content", "new_string", "new_source")
        )
        for edit in tool_input.get("edits") or []:
            text += "\n" + str(edit.get("new_string") or "")
        label = find_secret(text)
    except Exception:
        return 0
    if label:
        print(
            f"Blocked by ~/.claude/hooks/guard_secrets.py: this write to {path} contains what looks "
            f"like a real {label}. Secrets belong only in .env (read through the project's config "
            "module). Use a placeholder in code, docs, tests and .env.example.",
            file=sys.stderr,
        )
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
