import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path


PLUGIN_API = Path(__file__).resolve().parents[1] / "dashboard" / "plugin_api.py"


def load_api():
    fastapi = types.ModuleType("fastapi")
    class APIRouter:
        def get(self, _path): return lambda fn: fn
        def put(self, _path): return lambda fn: fn
        def post(self, _path): return lambda fn: fn
    class HTTPException(Exception): pass
    fastapi.APIRouter = APIRouter
    fastapi.HTTPException = HTTPException
    pydantic = types.ModuleType("pydantic")
    class BaseModel: pass
    pydantic.BaseModel = BaseModel
    sys.modules.update({"fastapi": fastapi, "pydantic": pydantic})
    spec = importlib.util.spec_from_file_location("session_folders_plugin_api", PLUGIN_API)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class SessionFoldersStateTests(unittest.TestCase):
    def test_state_round_trip_preserves_all_memberships(self):
        api = load_api()
        state = {
            "folders": [
                {"id": "f_work", "name": "Work", "createdAt": 1, "order": 0},
                {"id": "f_personal", "name": "Personal", "createdAt": 2, "order": 1},
            ],
            "membership": {
                "session-old": "f_work",
                "session-recent": "f_personal",
            },
            "expanded": {"f_work": True, "f_personal": False},
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            state_file = Path(temp_dir) / "state.json"
            api.write_state(state, state_file=state_file)
            self.assertEqual(api.read_state(state_file=state_file), state)

    def test_state_write_rejects_membership_to_unknown_folder(self):
        api = load_api()
        state = {
            "folders": [{"id": "f_work", "name": "Work", "createdAt": 1, "order": 0}],
            "membership": {"session-old": "f_missing"},
            "expanded": {},
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            with self.assertRaises(ValueError):
                api.write_state(state, state_file=Path(temp_dir) / "state.json")

    def test_default_rules_create_the_repos_workspace_rule(self):
        api = load_api()
        with tempfile.TemporaryDirectory() as temp_dir:
            rules_file = Path(temp_dir) / "rules.json"
            rules = api.read_rules(rules_file=rules_file)

            self.assertEqual(rules, {
                "rules": [{
                    "workspace_prefix": "/Users/mixermsk/repos/",
                    "folder": "Repos",
                }]
            })
            self.assertTrue(rules_file.exists())

    def test_rules_reject_empty_folder_or_workspace_prefix(self):
        api = load_api()
        with tempfile.TemporaryDirectory() as temp_dir:
            rules_file = Path(temp_dir) / "rules.json"
            with self.assertRaises(ValueError):
                api.write_rules({"rules": [{"workspace_prefix": "", "folder": "Repos"}]}, rules_file=rules_file)
            with self.assertRaises(ValueError):
                api.write_rules({"rules": [{"workspace_prefix": "/Users/mixermsk/repos/", "folder": " "}]}, rules_file=rules_file)

    def test_workspace_lookup_returns_only_requested_session_ids(self):
        api = load_api()
        with tempfile.TemporaryDirectory() as temp_dir:
            state_db = Path(temp_dir) / "state.db"
            import sqlite3
            with sqlite3.connect(state_db) as conn:
                conn.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT)")
                conn.executemany(
                    "INSERT INTO sessions(id, cwd) VALUES (?, ?)",
                    [("in-repos", "/Users/mixermsk/repos/example"), ("elsewhere", "/tmp/example")],
                )

            self.assertEqual(api.read_workspaces(["in-repos", "missing"], state_db=state_db), {
                "in-repos": "/Users/mixermsk/repos/example"
            })

    def test_workspace_rules_create_folder_and_preserve_manual_membership(self):
        api = load_api()
        state = {
            "folders": [{"id": "f_manual", "name": "Manual", "createdAt": 1, "order": 0}],
            "membership": {"manual-repo": "f_manual"},
            "expanded": {},
        }
        rules = {"rules": [{"workspace_prefix": "/Users/mixermsk/repos/", "folder": "Repos"}]}

        self.assertEqual(api.apply_workspace_rules(state, {
            "repo": "/Users/mixermsk/repos/example",
            "manual-repo": "/Users/mixermsk/repos/example",
            "other": "/tmp/example",
        }, rules), {
            "folders": [
                {"id": "f_manual", "name": "Manual", "createdAt": 1, "order": 0},
                {"id": "f_auto_repos", "name": "Repos", "createdAt": 0, "order": 1},
            ],
            "membership": {"repo": "f_auto_repos", "manual-repo": "f_manual"},
            "expanded": {"f_auto_repos": True},
        })


if __name__ == "__main__":
    unittest.main()
