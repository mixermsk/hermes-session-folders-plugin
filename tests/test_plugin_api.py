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


if __name__ == "__main__":
    unittest.main()
