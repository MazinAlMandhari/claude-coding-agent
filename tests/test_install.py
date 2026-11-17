"""Tests for install.py. Run: python -m unittest discover tests"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import install  # noqa: E402

CONFIG = Path("/home/someone/.claude")
PY = ["/usr/bin/python3", "-I"]


def write(root: Path, rel: str, text: str = "x") -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def make_repo(root: Path) -> None:
    """A minimal claude/ folder with one file of each kind."""
    for rel in ("agents/planner.md", "skills/ship/SKILL.md", "hooks/guard_bash.py", "coding-agent/rules.md"):
        write(root, rel, f"# {rel}")
    write(root, "mods/agent-crew/.claude-plugin/plugin.json", json.dumps({"name": "agent-crew", "version": "1.0.0"}))
    write(root, "mods/agent-crew/hooks/register.tsx", "export const register = () => {}")


class MergeSettingsTest(unittest.TestCase):
    def test_other_settings_are_kept(self) -> None:
        merged = install.merge_settings({"theme": "dark", "permissions": {"allow": ["Bash(ls)"]}}, CONFIG, PY)
        self.assertEqual(merged["theme"], "dark")
        self.assertEqual(merged["permissions"]["allow"], ["Bash(ls)"])

    def test_deny_rules_are_added_once(self) -> None:
        once = install.merge_settings({"permissions": {"deny": ["Read(**/.env)", "Bash(rm *)"]}}, CONFIG, PY)
        deny = install.merge_settings(once, CONFIG, PY)["permissions"]["deny"]
        self.assertEqual(len(deny), len(set(deny)))
        self.assertIn("Bash(rm *)", deny)
        self.assertTrue(set(install.DENY_RULES) <= set(deny))

    def test_running_twice_does_not_duplicate_hooks(self) -> None:
        twice = install.merge_settings(install.merge_settings({}, CONFIG, PY), CONFIG, PY)
        ours = [h for groups in twice["hooks"].values() for g in groups for h in g["hooks"]]
        self.assertEqual(len(ours), len(install.HOOKS))

    def test_hooks_point_at_this_computers_config_folder(self) -> None:
        old = install.merge_settings({}, Path("C:/Users/Old/.claude"), ["C:/Windows/py.exe", "-3", "-I"])
        new = install.merge_settings(old, CONFIG, PY)
        hooks = [h for groups in new["hooks"].values() for g in groups for h in g["hooks"]]
        self.assertTrue(all(h["args"][-1].startswith(CONFIG.as_posix()) for h in hooks))
        self.assertTrue(all(h["command"] == "/usr/bin/python3" for h in hooks))

    def test_someone_elses_hooks_are_kept(self) -> None:
        theirs = {"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "lint"}]}]}}
        merged = install.merge_settings(theirs, CONFIG, PY)
        commands = [h["command"] for g in merged["hooks"]["PreToolUse"] for h in g["hooks"]]
        self.assertIn("lint", commands)

    def test_the_panel_plugin_is_switched_on_from_the_installed_folder(self) -> None:
        merged = install.merge_settings({"enabledPlugins": {install.PLUGIN_ID: False}}, CONFIG, PY)
        self.assertIs(merged["enabledPlugins"][install.PLUGIN_ID], True)
        source = merged["extraKnownMarketplaces"][install.MARKETPLACE]["source"]
        self.assertEqual(source, {"source": "directory", "path": str(CONFIG / "mods" / "agent-crew")})

    def test_unmerging_removes_our_hooks_and_plugin_but_keeps_the_rest(self) -> None:
        theirs = {"theme": "dark", "hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "lint"}]}]}}
        back = install.unmerge_settings(install.merge_settings(theirs, CONFIG, PY))
        self.assertEqual(back["hooks"], theirs["hooks"])
        self.assertEqual(back["theme"], "dark")
        self.assertNotIn(install.PLUGIN_ID, back.get("enabledPlugins", {}))
        self.assertNotIn(install.MARKETPLACE, back.get("extraKnownMarketplaces", {}))

    def test_settings_saved_with_a_byte_order_mark_are_read(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "settings.json").write_text('{"theme": "dark"}', encoding="utf-8-sig")
            self.assertEqual(install.read_settings(Path(tmp)), {"theme": "dark"})

    def test_broken_settings_stop_the_install(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "settings.json").write_text("{not json", encoding="utf-8")
            with self.assertRaises(SystemExit):
                install.read_settings(Path(tmp))


class ClaudeMdTest(unittest.TestCase):
    def test_a_new_claude_md_gets_an_about_me_section_and_the_rules(self) -> None:
        text = install.with_rules(None, "RULES")
        self.assertIn("## About me", text)
        self.assertIn(f"{install.BLOCK_START}\n\nRULES\n\n{install.BLOCK_END}", text)

    def test_your_own_text_is_kept_above_the_rules(self) -> None:
        text = install.with_rules("# Mine\n\nI use Go.\n", "RULES")
        self.assertTrue(text.startswith("# Mine\n\nI use Go.\n\n"))
        self.assertIn("RULES", text)

    def test_installing_again_replaces_the_block_instead_of_adding_one(self) -> None:
        twice = install.with_rules(install.with_rules("# Mine\n", "OLD"), "NEW")
        self.assertEqual(twice.count(install.BLOCK_START), 1)
        self.assertNotIn("OLD", twice)
        self.assertIn("NEW", twice)

    def test_removing_the_block_gives_back_your_text(self) -> None:
        mine = "# Mine\n\nI use Go.\n"
        self.assertEqual(install.without_block(install.with_rules(mine, "RULES")), mine)


class FilesTest(unittest.TestCase):
    def test_only_source_files_belong_to_the_setup(self) -> None:
        self.assertTrue(install.is_setup_file("agents/planner.md"))
        self.assertTrue(install.is_setup_file("mods/agent-crew/NOTICE"))
        for rel in (
            "agents/.claude/settings.local.json",
            "agents/notes.local.md",
            "hooks/run.log",
            "hooks/.env",
            "hooks/__pycache__/x.py",
            "mods/agent-crew/.claude-plugin/types/claude-code/index.d.ts",
        ):
            self.assertFalse(install.is_setup_file(rel), rel)

    def test_install_removes_files_the_repo_dropped_but_keeps_yours(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo, config = Path(tmp) / "repo", Path(tmp) / "config"
            make_repo(repo)
            write(repo, "skills/handover/SKILL.md")
            install.install_files(repo, config)
            write(config, "agents/my-own-agent.md")

            (repo / "skills" / "handover" / "SKILL.md").unlink()
            install.install_files(repo, config)

            self.assertFalse((config / "skills" / "handover").exists())
            self.assertTrue((config / "agents" / "my-own-agent.md").exists())
            self.assertTrue((config / "skills" / "ship" / "SKILL.md").exists())

    def test_the_panel_folder_is_replaced_whole(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo, config = Path(tmp) / "repo", Path(tmp) / "config"
            make_repo(repo)
            write(config, "mods/agent-crew/old-file.json")
            install.install_files(repo, config)
            self.assertFalse((config / "mods" / "agent-crew" / "old-file.json").exists())


class PluginCheckTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.repo, self.config, self.cache = root / "repo", root / "config", root / "cache"
        make_repo(self.repo)
        install.install_files(self.repo, self.config)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def record(self, version: str) -> None:
        body = {"plugins": {install.PLUGIN_ID: [{"scope": "user", "version": version, "installPath": str(self.cache)}]}}
        write(self.config, "plugins/installed_plugins.json", json.dumps(body))

    def copy_to_cache(self) -> None:
        mod = self.config / "mods" / "agent-crew"
        for rel in (".claude-plugin/plugin.json", "hooks/register.tsx"):
            write(self.cache, rel, (mod / rel).read_text(encoding="utf-8"))

    def test_a_matching_install_passes(self) -> None:
        self.copy_to_cache()
        self.record("1.0.0")
        self.assertIsNone(install.plugin_problem(self.config))

    def test_changed_code_with_the_same_version_is_reported(self) -> None:
        self.copy_to_cache()
        write(self.cache, "hooks/register.tsx", "old code")
        self.record("1.0.0")
        self.assertIn("Bump `version`", install.plugin_problem(self.config) or "")

    def test_an_older_version_is_reported(self) -> None:
        self.record("0.9.0")
        self.assertIn("0.9.0", install.plugin_problem(self.config) or "")


class UninstallTest(unittest.TestCase):
    def test_uninstall_removes_what_it_installed_and_keeps_yours(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "config"
            write(config, "CLAUDE.md", "# Mine\n")
            write(config, "agents/my-own-agent.md")
            write(config, "settings.json", json.dumps({"theme": "dark"}))
            install.install(config, is_default_dir=False, use_plugin_cli=False)

            install.uninstall(config, is_default_dir=False, use_plugin_cli=False)

            self.assertFalse((config / "agents" / "planner.md").exists())
            self.assertFalse((config / "mods" / "agent-crew").exists())
            self.assertTrue((config / "agents" / "my-own-agent.md").exists())
            self.assertEqual((config / "CLAUDE.md").read_text(encoding="utf-8"), "# Mine\n")
            settings = json.loads((config / "settings.json").read_text(encoding="utf-8"))
            self.assertEqual(settings["theme"], "dark")
            self.assertNotIn("PreToolUse", settings.get("hooks", {}))


class SafetyTest(unittest.TestCase):
    """The installer must never lose or quietly replace something the person made themselves."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.config = Path(self.tmp.name) / "config"
        self.config.mkdir()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def run_install(self, **kw) -> None:
        install.install(self.config, is_default_dir=False, use_plugin_cli=False, **kw)

    def test_your_own_agent_with_the_same_name_stops_the_install_untouched(self) -> None:
        write(self.config, "agents/planner.md", "MY OWN PLANNER")
        with self.assertRaises(SystemExit) as stop:
            self.run_install()
        self.assertIn("planner.md", str(stop.exception))
        self.assertEqual((self.config / "agents" / "planner.md").read_text(encoding="utf-8"), "MY OWN PLANNER")
        self.assertFalse((self.config / install.MANIFEST).exists())

    def test_overwrite_replaces_your_agent_and_keeps_it_in_the_backup(self) -> None:
        write(self.config, "agents/planner.md", "MY OWN PLANNER")
        self.run_install(overwrite=True)
        self.assertNotEqual((self.config / "agents" / "planner.md").read_text(encoding="utf-8"), "MY OWN PLANNER")
        saved = list((self.config / "backups").glob("*/agents/planner.md"))
        self.assertEqual(saved[0].read_text(encoding="utf-8"), "MY OWN PLANNER")

    def test_installing_twice_is_not_a_name_clash(self) -> None:
        self.run_install()
        self.run_install()  # our own files from the first run must not count as yours

    def test_a_broken_rules_block_stops_the_install_and_keeps_your_text(self) -> None:
        self.run_install()
        claude_md = self.config / "CLAUDE.md"
        edited = claude_md.read_text(encoding="utf-8").replace(install.BLOCK_END, "") + "\n## Keep me\n"
        claude_md.write_text(edited, encoding="utf-8")
        with self.assertRaises(SystemExit):
            self.run_install()
        with self.assertRaises(SystemExit):
            install.uninstall(self.config, is_default_dir=False, use_plugin_cli=False)
        self.assertEqual(claude_md.read_text(encoding="utf-8"), edited)

    def test_a_claude_md_that_is_not_utf8_stops_the_install_before_any_change(self) -> None:
        (self.config / "CLAUDE.md").write_text("# Mine\n", encoding="utf-16")
        with self.assertRaises(SystemExit) as stop:
            self.run_install()
        self.assertIn("UTF-8", str(stop.exception))
        self.assertFalse((self.config / "agents").exists())

    def test_windows_line_endings_in_claude_md_survive_install_and_uninstall(self) -> None:
        mine = b"# Mine\r\n\r\nI use Go.\r\n"
        (self.config / "CLAUDE.md").write_bytes(mine)
        self.run_install()
        self.assertNotIn(b"\n", (self.config / "CLAUDE.md").read_bytes().replace(b"\r\n", b""))
        install.uninstall(self.config, is_default_dir=False, use_plugin_cli=False)
        self.assertEqual((self.config / "CLAUDE.md").read_bytes(), mine)

    def test_settings_with_an_unexpected_layout_stop_the_install_before_any_change(self) -> None:
        write(self.config, "settings.json", json.dumps({"hooks": {"PreToolUse": "oops"}}))
        with self.assertRaises(SystemExit):
            self.run_install()
        self.assertFalse((self.config / "agents").exists())

    def test_a_manifest_entry_outside_our_folders_is_never_deleted(self) -> None:
        victim = Path(self.tmp.name) / "victim.txt"
        victim.write_text("keep", encoding="utf-8")
        write(self.config, "notes.md", "keep")
        entries = ["../victim.txt", "notes.md", str(victim), "agents/../../victim.txt"]
        write(self.config, install.MANIFEST, json.dumps({"files": entries}))
        install.uninstall(self.config, is_default_dir=False, use_plugin_cli=False)
        self.assertTrue(victim.exists())
        self.assertTrue((self.config / "notes.md").exists())

    def test_uninstall_where_nothing_was_installed_creates_no_settings(self) -> None:
        install.uninstall(self.config, is_default_dir=False, use_plugin_cli=False)
        self.assertFalse((self.config / "settings.json").exists())

    def test_old_backups_are_pruned(self) -> None:
        for i in range(install.KEEP_BACKUPS + 3):
            (self.config / "backups" / f"claude-coding-agent-2026010{i}").mkdir(parents=True)
        (self.config / "backups" / "someone-elses").mkdir()
        self.run_install()
        ours = [p for p in (self.config / "backups").iterdir() if p.name.startswith("claude-coding-agent-")]
        self.assertLessEqual(len(ours), install.KEEP_BACKUPS)
        self.assertTrue((self.config / "backups" / "someone-elses").exists())


class HookOwnershipTest(unittest.TestCase):
    def test_your_own_hook_with_the_same_script_name_is_kept(self) -> None:
        mine = {"type": "command", "command": "python", "args": ["/home/me/tools/check_python.py"]}
        theirs = {"hooks": {"PostToolUse": [{"matcher": "Edit", "hooks": [mine]}]}}
        merged = install.merge_settings(theirs, CONFIG, PY)
        self.assertIn(mine, [h for g in merged["hooks"]["PostToolUse"] for h in g["hooks"]])
        self.assertEqual(install.unmerge_settings(merged)["hooks"], theirs["hooks"])


if __name__ == "__main__":
    unittest.main()
