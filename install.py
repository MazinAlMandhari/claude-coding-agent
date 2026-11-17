"""Install (or remove) the claude-coding-agent setup in the Claude config folder (~/.claude).

Run it from the repo folder:

    py install.py                Windows
    python3 install.py           macOS / Linux
    py install.py --uninstall    remove it again

Options:
    --target DIR      use another Claude config folder (used for testing)
    --no-plugin-cli   copy files and settings only; skip installing the "My agents" panel plugin
    --overwrite       replace your own agents/skills/hooks that have the same names (backed up)

What install does, in order:
 1. Reads settings.json first, so a broken one stops the install before anything changes.
 2. Backs up what it is about to change into <config>/backups/claude-coding-agent-<time>/.
 3. Copies the agents, skills, hooks, rules and the agent-crew panel into the config folder, and
    removes files an earlier install put there that the repo has since deleted.
 4. Adds the coding rules to your CLAUDE.md as one marked block (your own text is kept).
 5. Merges the safety deny rules, the hooks and the plugin switch into settings.json, keeping
    every other setting already there, then checks the hooks really start.
 6. Installs the agent-crew plugin with Claude Code's own `claude plugin` commands, so the
    "My agents" panel and progress bar show in every new session.

Running it again is safe: it updates in place. Logins, history and conversations are never touched.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent
SOURCE = REPO / "claude"

PLUGIN = "agent-crew"
MARKETPLACE = "coding-agent"
PLUGIN_ID = f"{PLUGIN}@{MARKETPLACE}"
MOD_DIR = Path("mods") / PLUGIN
RULES = Path("coding-agent") / "rules.md"
MANIFEST = "claude-coding-agent-manifest.json"
CLI_TIMEOUT = 180  # seconds; a CLI waiting on a prompt must not hang the installer

# What this setup owns inside the config folder. Nothing else there is written, except the marked
# block in CLAUDE.md and our own entries in settings.json.
MANAGED = [Path("agents"), Path("skills"), Path("hooks"), Path("coding-agent"), MOD_DIR]

# Inside those, only source-like files travel; local settings, logs and keys stay behind.
SUFFIXES = {".md", ".py", ".json", ".ts", ".tsx"}
NAMES = {"NOTICE"}
SKIPPED_DIRS = {"__pycache__", "node_modules", ".claude", ".git"}
SKIPPED_NAME_PARTS = (".local.", "settings.local", ".credentials", ".env")
GENERATED = (MOD_DIR / ".claude-plugin" / "types").as_posix()  # written by Claude Code on each computer

BLOCK_START = "<!-- claude-coding-agent:start (managed by install.py; edit the repo, not this block) -->"
BLOCK_END = "<!-- claude-coding-agent:end -->"
NEW_CLAUDE_MD = """# My Claude Code instructions

## About me

<!-- Tell Claude who you are and how you work; it reads this file in every session. For example:
     your experience level, the languages and tools you use, your operating system, where your
     projects live, and how you like answers (short, detailed, with examples). -->

"""

DENY_RULES = [
    "Read(**/.env)",
    "Read(**/.env.local)",
    "Read(**/.env.production)",
    "Bash(git push --force *)",
    "Bash(git push -f *)",
    "Bash(git reset --hard *)",
]

# (event, matcher, hook script, timeout in seconds, status message)
HOOKS = [
    ("PreToolUse", "Bash|PowerShell", "guard_bash.py", 15, "Checking command safety"),
    ("PreToolUse", "Edit|Write|MultiEdit|NotebookEdit", "guard_secrets.py", 10, "Scanning for secrets"),
    ("PostToolUse", "Edit|Write|MultiEdit", "check_python.py", 30, "Checking Python file"),
]


# ------------------------------------------------------------------------------ files


def is_setup_file(rel: str) -> bool:
    """rel is a posix path relative to the config folder (or the repo's claude/ folder)."""
    path = Path(rel)
    if rel.startswith(GENERATED + "/") or any(part in SKIPPED_DIRS for part in path.parts[:-1]):
        return False
    if any(part in path.name for part in SKIPPED_NAME_PARTS):
        return False
    return path.name in NAMES or path.suffix in SUFFIXES


def list_files(root: Path) -> set[str]:
    """Every setup file under root's managed paths, as posix paths relative to root."""
    found: set[str] = set()
    for rel in MANAGED:
        top = root / rel
        if top.is_dir():
            found.update(p.relative_to(root).as_posix() for p in top.rglob("*") if p.is_file())
    return {rel for rel in found if is_setup_file(rel)}


def _inside_managed(rel: str) -> bool:
    """A manifest entry this installer may delete: relative, no `..`, under a managed folder."""
    path = Path(rel)
    if path.is_absolute() or path.drive or ".." in path.parts or "\\" in rel:
        return False
    return any(path.parts[: len(m.parts)] == m.parts for m in MANAGED) and is_setup_file(rel)


def read_manifest(config_dir: Path) -> set[str]:
    path = config_dir / MANIFEST
    if not path.exists():
        return set()
    try:
        files = json.loads(path.read_text(encoding="utf-8-sig")).get("files", [])
    except (json.JSONDecodeError, UnicodeDecodeError, AttributeError):
        return set()
    # Only paths this setup could have written; an edited manifest must never point outside them.
    return {rel for rel in files if isinstance(rel, str) and _inside_managed(rel)}


def collisions(source_root: Path, config_dir: Path) -> list[str]:
    """Files the install would overwrite that are not ours: same name, different content.

    Typically an agent or skill the person wrote themselves (planner, debugger, ship...).
    """
    ours = read_manifest(config_dir)
    found = []
    for rel in sorted(list_files(source_root)):
        target = config_dir / rel
        if rel in ours or not target.is_file() or rel.startswith(MOD_DIR.as_posix() + "/"):
            continue
        if target.read_bytes() != (source_root / rel).read_bytes():
            found.append(rel)
    return found


def write_manifest(config_dir: Path, files: set[str]) -> None:
    body = {"note": "Files installed by claude-coding-agent. Do not edit.", "files": sorted(files)}
    (config_dir / MANIFEST).write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")


def remove_files(root: Path, files: set[str]) -> None:
    """Delete these files under root, then any folders they leave empty (never root itself)."""
    for rel in sorted(files):
        path = root / rel
        if path.is_file():
            path.unlink()
        parent = path.parent
        while parent != root and parent.is_dir() and not any(parent.iterdir()):
            parent.rmdir()
            parent = parent.parent


def install_files(source_root: Path, config_dir: Path) -> set[str]:
    """Copy the setup into config_dir and remove what an earlier install left that the repo dropped.

    Files in agents/skills/hooks that this setup never installed (yours, or another tool's) are
    left alone; the panel's folder is replaced whole so no stale file survives.
    """
    files = list_files(source_root)
    if not files:
        raise SystemExit(f"No setup files in {source_root}. Is the repo complete? Try `git pull`.")
    remove_files(config_dir, read_manifest(config_dir) - files)
    if (config_dir / MOD_DIR).exists():
        shutil.rmtree(config_dir / MOD_DIR)
    for rel in sorted(files):
        dest = config_dir / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_root / rel, dest)
    write_manifest(config_dir, files)
    return files


KEEP_BACKUPS = 5


def prune_backups(config_dir: Path) -> None:
    """Keep only the newest few of our backups: each holds a copy of settings.json, which can
    contain API keys in its `env` block, so they should not pile up."""
    folder = config_dir / "backups"
    if not folder.is_dir():
        return
    ours = sorted(p for p in folder.iterdir() if p.is_dir() and p.name.startswith("claude-coding-agent-"))
    for old in ours[: max(0, len(ours) - (KEEP_BACKUPS - 1))]:
        shutil.rmtree(old, ignore_errors=True)


def back_up(config_dir: Path, stamp: str) -> Path | None:
    prune_backups(config_dir)
    candidates = [*MANAGED, Path("CLAUDE.md"), Path("settings.json")]
    existing = [rel for rel in candidates if (config_dir / rel).exists()]
    if not existing:
        return None
    backup = config_dir / "backups" / f"claude-coding-agent-{stamp}"
    n = 1
    while backup.exists():  # two runs in the same second must not share (or crash on) one folder
        n += 1
        backup = config_dir / "backups" / f"claude-coding-agent-{stamp}-{n}"
    for rel in existing:
        src, dest = config_dir / rel, backup / rel
        if src.is_dir():
            shutil.copytree(src, dest, ignore=shutil.ignore_patterns("__pycache__", "node_modules"))
        else:
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)
    return backup


# ------------------------------------------------------------------------------ CLAUDE.md


def block_problem(text: str) -> str | None:
    """None when CLAUDE.md holds no rules block or exactly one intact one; else what is wrong."""
    starts, ends = text.count(BLOCK_START), text.count(BLOCK_END)
    if starts == ends == 0:
        return None
    if starts == ends == 1 and text.index(BLOCK_START) < text.index(BLOCK_END):
        return None
    return (
        "its claude-coding-agent rules block has been edited (a start or end marker is missing or "
        "repeated). Delete the whole block, from the line with 'claude-coding-agent:start' to the "
        "line with 'claude-coding-agent:end', then run this again"
    )


def without_block(text: str) -> str:
    """text with our marked block (and the blank lines before it) removed. Call block_problem first."""
    if BLOCK_START not in text:
        return text
    pattern = re.compile(r"\n*" + re.escape(BLOCK_START) + r".*?" + re.escape(BLOCK_END) + r"\n?", re.S)
    return pattern.sub("\n", text).rstrip("\n") + "\n"


def with_rules(text: str | None, rules: str) -> str:
    """CLAUDE.md text with the rules block added at the end, or replaced where it already is."""
    base = NEW_CLAUDE_MD if text is None else without_block(text)
    block = f"{BLOCK_START}\n\n{rules.strip()}\n\n{BLOCK_END}\n"
    return base.rstrip("\n") + "\n\n" + block


def read_text(path: Path) -> str | None:
    """The file's text, or None when it does not exist. Stops cleanly on a non-UTF-8 file."""
    if not path.exists():
        return None
    try:
        return path.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError as exc:
        raise SystemExit(
            f"{path} is not saved as UTF-8 (Windows PowerShell and old Notepad can save UTF-16 or "
            "ANSI). Nothing was changed. Open it in an editor, save it as UTF-8, then run this again."
        ) from exc


def read_claude_md(config_dir: Path) -> tuple[str | None, str]:
    """CLAUDE.md's text with \\n line endings, and the line ending to write it back with."""
    path = config_dir / "CLAUDE.md"
    raw = read_text(path)  # universal newlines: \r\n arrives as \n
    if raw is None:
        return None, "\n"
    problem = block_problem(raw)
    if problem:
        raise SystemExit(f"{path}: {problem}. Nothing was changed.")
    eol = "\r\n" if b"\r\n" in path.read_bytes() else "\n"
    return raw, eol


def write_claude_md(config_dir: Path, text: str, eol: str) -> None:
    (config_dir / "CLAUDE.md").write_text(text.replace("\n", eol), encoding="utf-8", newline="")


# ------------------------------------------------------------------------------ settings


def _runs(command: list[str]) -> bool:
    try:
        return subprocess.run([*command, "-c", "pass"], capture_output=True, timeout=30).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def python_command() -> list[str]:
    """The interpreter the hooks run with: the first candidate that actually starts.

    A launcher on PATH (`py` on Windows, `python3` elsewhere) survives Python upgrades; the exact
    interpreter running this script is the fallback, and it is known to work.
    """
    candidates: list[list[str]] = []
    if os.name == "nt":
        launcher = shutil.which("py") or str(Path(os.environ.get("SystemRoot", r"C:\Windows")) / "py.exe")
        if Path(launcher).exists():
            candidates.append([Path(launcher).as_posix(), "-3", "-I"])
    else:
        python3 = shutil.which("python3")
        if python3:
            candidates.append([Path(python3).as_posix(), "-I"])
    base = getattr(sys, "_base_executable", None) or sys.executable
    fallback = [Path(base).as_posix(), "-I"]
    return next((c for c in candidates if _runs(c)), fallback)


def _is_our_hook(hook: dict) -> bool:
    """True for a hook entry this installer wrote: it runs <config>/hooks/<one of our scripts>.

    Matched on the path ending, not the bare name, so someone's own `check_python.py` elsewhere
    is never taken for ours, while a moved config folder still is.
    """
    parts = [str(hook.get("command", ""))] + [str(a) for a in hook.get("args", [])]
    ends = [p.replace("\\", "/").strip("\"' ") for p in parts]
    return any(e.endswith(f"/hooks/{script}") for e in ends for _, _, script, _, _ in HOOKS)


def without_our_hooks(settings: dict) -> dict:
    """A copy of settings with this setup's hook entries removed (found by script name)."""
    cleaned = json.loads(json.dumps(settings))  # deep copy; settings are plain JSON
    hooks = cleaned.get("hooks", {})
    for event in list(hooks):
        kept = []
        for group in hooks[event]:
            others = [h for h in group.get("hooks", []) if not _is_our_hook(h)]
            if others:
                kept.append({**group, "hooks": others})
        if kept:
            hooks[event] = kept
        else:
            del hooks[event]
    return cleaned


def merge_settings(settings: dict, config_dir: Path, python: list[str]) -> dict:
    """Return settings with this setup's rules, hooks and plugin added; other keys untouched.

    Our own hook entries are replaced, so re-running never duplicates them and a moved config
    folder gets fresh paths.
    """
    merged = without_our_hooks(settings)

    deny = merged.setdefault("permissions", {}).setdefault("deny", [])
    deny.extend(rule for rule in DENY_RULES if rule not in deny)

    hooks = merged.setdefault("hooks", {})
    for event, matcher, script, timeout, status in HOOKS:
        hooks.setdefault(event, []).append(
            {
                "matcher": matcher,
                "hooks": [
                    {
                        "type": "command",
                        "command": python[0],
                        "args": [*python[1:], (config_dir / "hooks" / script).as_posix()],
                        "timeout": timeout,
                        "statusMessage": status,
                    }
                ],
            }
        )

    merged.setdefault("enabledPlugins", {})[PLUGIN_ID] = True
    merged.setdefault("extraKnownMarketplaces", {})[MARKETPLACE] = {
        "source": {"source": "directory", "path": str(config_dir / MOD_DIR)}
    }
    return merged


def unmerge_settings(settings: dict) -> dict:
    """Return settings without this setup's hooks and plugin. Deny rules are kept: they may be yours."""
    cleaned = without_our_hooks(settings)
    cleaned.get("enabledPlugins", {}).pop(PLUGIN_ID, None)
    cleaned.get("extraKnownMarketplaces", {}).pop(MARKETPLACE, None)
    for key in ("hooks", "enabledPlugins", "extraKnownMarketplaces"):
        if cleaned.get(key) == {}:
            del cleaned[key]
    return cleaned


def read_settings(config_dir: Path) -> dict:
    """settings.json as a dict; stops, before anything changes, if it is not one we can merge into."""
    path = config_dir / "settings.json"
    try:
        # utf-8-sig: Notepad and Windows PowerShell 5 save JSON with a byte-order mark.
        settings = json.loads(read_text(path) or "{}")
    except json.JSONDecodeError as exc:
        raise SystemExit(
            f"{path} is not valid JSON ({exc}). Nothing was changed. Fix or remove it, then run the "
            "installer again."
        ) from exc
    shape_ok = (
        isinstance(settings, dict)
        and isinstance(settings.get("hooks", {}), dict)
        and all(isinstance(v, list) and all(isinstance(g, dict) for g in v) for v in settings.get("hooks", {}).values())
        and isinstance(settings.get("permissions", {}), dict)
        and isinstance(settings.get("permissions", {}).get("deny", []), list)
        and isinstance(settings.get("enabledPlugins", {}), dict)
        and isinstance(settings.get("extraKnownMarketplaces", {}), dict)
    )
    if not shape_ok:
        raise SystemExit(
            f"{path} has an unexpected layout (hooks, permissions.deny, enabledPlugins or "
            "extraKnownMarketplaces is not the kind of value Claude Code uses). Nothing was changed."
        )
    return settings


def write_settings(config_dir: Path, settings: dict) -> None:
    text = json.dumps(settings, indent=2, ensure_ascii=False) + "\n"
    (config_dir / "settings.json").write_text(text, encoding="utf-8")


def hooks_start(config_dir: Path, python: list[str]) -> bool:
    """Run the command guard on a harmless and a forbidden command, as Claude Code would."""

    def guard(command: str) -> int:
        payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": command}})
        proc = subprocess.run(
            [*python, str(config_dir / "hooks" / "guard_bash.py")],
            input=payload,
            capture_output=True,
            text=True,
            timeout=30,
        )
        return proc.returncode

    try:
        return guard("git status") == 0 and guard("git reset --hard HEAD") == 2
    except (OSError, subprocess.SubprocessError):
        return False


# ------------------------------------------------------------------------------ plugin


def _version(path: Path) -> tuple[int, ...]:
    for part in path.parts[::-1]:
        if re.fullmatch(r"\d+(\.\d+)+", part):
            return tuple(int(n) for n in part.split("."))
    return (0,)


def find_claude() -> Path | None:
    """The newest Claude Code engine on this computer.

    The desktop app keeps its own engine (usually newer than a `claude` installed on PATH), and
    the panel needs a recent one, so the app's copy comes first.
    """
    home = Path.home()
    roots = [
        Path(os.environ.get("LOCALAPPDATA", home / "AppData" / "Local")),
        home / "Library" / "Application Support",
        home / ".local" / "share",
        home / ".config",
    ]
    name = "claude.exe" if os.name == "nt" else "claude"
    found = [
        p
        for root in roots
        for pattern in (f"Claude*/*/claude-code/*/*/{name}", f"Claude*/claude-code/*/*/{name}")
        for p in root.glob(pattern)
        if p.is_file()
    ]
    if found:
        return max(found, key=_version)
    on_path = shutil.which("claude")
    return Path(on_path) if on_path else None


def _run(claude: Path, args: list[str], env: dict[str, str]) -> str:
    """Run one `claude` command; returns a one-line outcome for the report."""
    try:
        proc = subprocess.run(
            [str(claude), *args],
            env=env,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=CLI_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        return f"`claude {' '.join(args)}` timed out after {CLI_TIMEOUT}s"
    except OSError as exc:
        return f"`claude {' '.join(args)}` could not start: {exc}"
    detail = (proc.stderr or proc.stdout or "").strip().splitlines()
    return f"`claude {' '.join(args)}` exit {proc.returncode}" + (f": {detail[-1]}" if detail else "")


def plugin_problem(config_dir: Path) -> str | None:
    """None when the installed plugin is this repo's panel, byte for byte; else what is wrong."""
    mod = config_dir / MOD_DIR
    wanted = json.loads(read_text(mod / ".claude-plugin" / "plugin.json") or "{}").get("version")
    try:
        record = json.loads(read_text(config_dir / "plugins" / "installed_plugins.json") or "{}")
    except json.JSONDecodeError:
        return "the plugin install record is unreadable"
    entries = record.get("plugins", {}).get(PLUGIN_ID, [])
    user = next((e for e in entries if e.get("scope") == "user"), None)
    if user is None:
        return "the plugin is not installed for this user"
    if user.get("version") != wanted:
        return f"installed version is {user.get('version')}, the repo has {wanted}"
    cache = Path(user.get("installPath", ""))
    for rel in list_files(config_dir):
        if not rel.startswith(MOD_DIR.as_posix() + "/"):
            continue
        inside = Path(rel).relative_to(MOD_DIR)
        if not (cache / inside).is_file() or (cache / inside).read_bytes() != (config_dir / rel).read_bytes():
            return (
                f"the installed {wanted} differs from the repo's panel ({inside.as_posix()}). "
                "Bump `version` in claude/mods/agent-crew/.claude-plugin/plugin.json and install again"
            )
    return None


def _cli_env(config_dir: Path, is_default_dir: bool) -> dict[str, str]:
    env = dict(os.environ)
    if not is_default_dir:
        env["CLAUDE_CONFIG_DIR"] = str(config_dir)
    return env


def install_plugin(config_dir: Path, is_default_dir: bool) -> bool:
    claude = find_claude()
    if claude is None:
        print(
            "  ! Claude Code was not found. Open the Claude desktop app, go to the Code tab once (it\n"
            "    downloads its engine then), and run this installer again. Everything else is installed."
        )
        return False
    print(f"  using {claude}")
    env = _cli_env(config_dir, is_default_dir)

    # Each step tolerates "already there": add or refresh the marketplace, then install or update.
    outcomes = [_run(claude, ["plugin", "marketplace", "add", str(config_dir / MOD_DIR)], env)]
    if "exit 0" not in outcomes[0]:
        outcomes.append(_run(claude, ["plugin", "marketplace", "update", MARKETPLACE], env))
    for step in ("install", "update", "enable"):
        outcomes.append(_run(claude, ["plugin", step, PLUGIN_ID, "--scope", "user"], env))

    problem = plugin_problem(config_dir)
    if problem is None:
        print("  My agents panel (agent-crew plugin) installed and matches the repo")
        return True
    print(f"  ! The panel plugin is not right: {problem}.")
    for line in outcomes:
        print(f"    {line}")
    return False


def uninstall_plugin(config_dir: Path, is_default_dir: bool) -> None:
    claude = find_claude()
    if claude is None:
        print("  Claude Code not found; the panel's settings entries are removed, its cache is left.")
        return
    env = _cli_env(config_dir, is_default_dir)
    outcomes = [
        _run(claude, ["plugin", "uninstall", PLUGIN_ID, "--scope", "user"], env),
        _run(claude, ["plugin", "marketplace", "remove", MARKETPLACE], env),
    ]
    failed = [o for o in outcomes if " exit 0" not in o]
    if not failed:
        print("  removed the My agents panel plugin")
    for line in failed:
        print(f"  ! {line}")


# ------------------------------------------------------------------------------ main


def install(config_dir: Path, is_default_dir: bool, use_plugin_cli: bool, overwrite: bool = False) -> bool:
    print(f"Installing into {config_dir}")
    # Every check that can stop the install runs before anything is written.
    settings = read_settings(config_dir)
    claude_md_text, eol = read_claude_md(config_dir)
    clashes = collisions(SOURCE, config_dir)
    if clashes and not overwrite:
        listed = "\n".join(f"    {config_dir / rel}" for rel in clashes)
        raise SystemExit(
            "These files of yours have the same names as files in this setup, and installing would\n"
            f"replace them:\n{listed}\n"
            "Nothing was changed. Rename yours (for example planner.md -> my-planner.md, and the\n"
            "`name:` inside it), or run again with --overwrite to replace them (they are backed up first)."
        )
    python = python_command()
    merged = merge_settings(settings, config_dir, python)

    backup = back_up(config_dir, dt.datetime.now().strftime("%Y%m%d-%H%M%S"))
    if backup:
        print(f"  backed up what will change to {backup}")
    for rel in clashes:
        print(f"  replaced your {rel} (your version is in the backup)")

    files = install_files(SOURCE, config_dir)
    print(f"  installed {len(files)} files (agents, skills, hooks, rules, My agents panel)")

    rules = (SOURCE / RULES).read_text(encoding="utf-8")
    existed = claude_md_text is not None
    write_claude_md(config_dir, with_rules(claude_md_text, rules), eol)
    print("  added the coding rules to CLAUDE.md" + (" (your own text is kept)" if existed else ""))

    write_settings(config_dir, merged)
    print("  merged settings.json (deny rules, hooks, panel plugin switched on)")

    ok = hooks_start(config_dir, python)
    print("  safety hooks start and block correctly" if ok else f"  ! The safety hooks did not run with {python[0]}.")

    if use_plugin_cli:
        ok = install_plugin(config_dir, is_default_dir) and ok
    if ok:
        print("Done. Start a new Claude Code session to pick it up.")
        if not existed:
            print(f"Tip: open {config_dir / 'CLAUDE.md'} and fill in 'About me' so Claude knows how you work.")
    else:
        print("Finished with a problem (above).")
    return ok


def uninstall(config_dir: Path, is_default_dir: bool, use_plugin_cli: bool) -> bool:
    print(f"Removing claude-coding-agent from {config_dir}")
    settings_existed = (config_dir / "settings.json").exists()
    settings = read_settings(config_dir)
    text, eol = read_claude_md(config_dir)
    backup = back_up(config_dir, dt.datetime.now().strftime("%Y%m%d-%H%M%S"))
    if backup:
        print(f"  backed up current files to {backup}")
    remove_files(config_dir, read_manifest(config_dir))
    if (config_dir / MOD_DIR).exists():
        shutil.rmtree(config_dir / MOD_DIR)
    (config_dir / MANIFEST).unlink(missing_ok=True)
    print("  removed the agents, skills, hooks, rules and panel files it installed")

    if text is not None and BLOCK_START in text:
        write_claude_md(config_dir, without_block(text), eol)
        print("  removed the rules block from CLAUDE.md (your own text is kept)")

    if settings_existed:
        write_settings(config_dir, unmerge_settings(settings))
        print("  removed its hooks and plugin from settings.json (the deny rules are kept)")
    if use_plugin_cli:
        uninstall_plugin(config_dir, is_default_dir)
    print("Done. Start a new Claude Code session.")
    return True


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Install or remove the claude-coding-agent setup.")
    default_dir = Path(os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude"))
    parser.add_argument("--target", type=Path, default=default_dir, help="Claude config folder")
    parser.add_argument("--no-plugin-cli", action="store_true", help="skip the panel plugin commands")
    parser.add_argument("--uninstall", action="store_true", help="remove everything this installed")
    parser.add_argument("--overwrite", action="store_true", help="replace your own files that have the same names")
    args = parser.parse_args()

    config_dir = args.target.expanduser().resolve()
    is_default_dir = config_dir == (Path.home() / ".claude").resolve() and "CLAUDE_CONFIG_DIR" not in os.environ
    config_dir.mkdir(parents=True, exist_ok=True)
    if args.uninstall:
        ok = uninstall(config_dir, is_default_dir, not args.no_plugin_cli)
    else:
        ok = install(config_dir, is_default_dir, not args.no_plugin_cli, args.overwrite)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
