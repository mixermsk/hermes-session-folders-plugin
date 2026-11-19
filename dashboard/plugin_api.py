"""Durable state API for the Session Folders Desktop plugin."""

from __future__ import annotations

import json
import os
import re
import sqlite3
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

PLUGIN_ID = "session-folders"
STATE_FILE = "state.json"
RULES_FILE = "rules.json"
DEFAULT_RULES = {
    "rules": [{"workspace_prefix": "/Users/mixermsk/repos/", "folder": "Repos"}]
}
router = APIRouter()


class FolderStatePayload(BaseModel):
    folders: list[dict[str, Any]]
    membership: dict[str, str]
    expanded: dict[str, bool]


class FolderRulesPayload(BaseModel):
    rules: list[dict[str, Any]]


class WorkspaceLookupPayload(BaseModel):
    session_ids: list[str]


def empty_state() -> dict[str, Any]:
    return {"folders": [], "membership": {}, "expanded": {}}


def state_file() -> Path:
    try:
        from plugins.plugin_storage import plugin_data_dir
        return plugin_data_dir(PLUGIN_ID) / STATE_FILE
    except ImportError:
        from hermes_constants import get_hermes_home
        directory = get_hermes_home() / "plugin-data" / PLUGIN_ID
        directory.mkdir(parents=True, exist_ok=True)
        return directory / STATE_FILE


def rules_file() -> Path:
    return state_file().with_name(RULES_FILE)


def session_db_file() -> Path:
    try:
        from hermes_constants import get_hermes_home
        return get_hermes_home() / "state.db"
    except ImportError:
        return Path.home() / ".hermes" / "state.db"


def normalize_state(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("state must be an object")
    raw_folders, raw_membership, raw_expanded = value.get("folders"), value.get("membership"), value.get("expanded")
    if not isinstance(raw_folders, list) or not isinstance(raw_membership, dict) or not isinstance(raw_expanded, dict):
        raise ValueError("state fields must be folders array, membership object, and expanded object")
    folders, ids = [], set()
    for order, folder in enumerate(raw_folders):
        if not isinstance(folder, dict): raise ValueError("folder must be an object")
        folder_id, name = folder.get("id"), folder.get("name")
        if not isinstance(folder_id, str) or not folder_id.strip() or folder_id in ids: raise ValueError("folder ids must be unique non-empty strings")
        if not isinstance(name, str) or not name.strip(): raise ValueError("folder names must be non-empty strings")
        created_at, persisted_order = folder.get("createdAt", 0), folder.get("order", order)
        if not isinstance(created_at, (int, float)) or not isinstance(persisted_order, int): raise ValueError("folder timestamps and order are invalid")
        ids.add(folder_id)
        folders.append({"id": folder_id, "name": name.strip(), "createdAt": created_at, "order": persisted_order})
    membership = {}
    for session_id, folder_id in raw_membership.items():
        if not isinstance(session_id, str) or not session_id or not isinstance(folder_id, str) or folder_id not in ids:
            raise ValueError("membership must map session ids to existing folders")
        membership[session_id] = folder_id
    expanded = {folder_id: open_ for folder_id, open_ in raw_expanded.items() if isinstance(folder_id, str) and folder_id in ids and isinstance(open_, bool)}
    return {"folders": folders, "membership": membership, "expanded": expanded}


def read_state(*, state_file: Path | None = None) -> dict[str, Any]:
    path = state_file or globals()["state_file"]()
    if not path.exists(): return empty_state()
    try: return normalize_state(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError, ValueError) as exc: raise ValueError(f"invalid persisted folder state: {exc}") from exc


def write_state(state: Any, *, state_file: Path | None = None) -> dict[str, Any]:
    normalized = normalize_state(state)
    path = state_file or globals()["state_file"]()
    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as temp:
        temp.write(json.dumps(normalized, ensure_ascii=False, separators=(",", ":")) + "\n")
        temp.flush(); os.fsync(temp.fileno()); temp_path = Path(temp.name)
    os.replace(temp_path, path)
    return normalized


def normalize_rules(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or not isinstance(value.get("rules"), list):
        raise ValueError("rules must be an object with a rules array")
    rules = []
    for rule in value["rules"]:
        if not isinstance(rule, dict):
            raise ValueError("each rule must be an object")
        workspace_prefix, folder = rule.get("workspace_prefix"), rule.get("folder")
        if not isinstance(workspace_prefix, str) or not workspace_prefix.strip():
            raise ValueError("workspace_prefix must be a non-empty string")
        if not isinstance(folder, str) or not folder.strip():
            raise ValueError("folder must be a non-empty string")
        rules.append({"workspace_prefix": workspace_prefix, "folder": folder.strip()})
    return {"rules": rules}


def write_rules(rules: Any, *, rules_file: Path | None = None) -> dict[str, Any]:
    normalized = normalize_rules(rules)
    path = rules_file or globals()["rules_file"]()
    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as temp:
        temp.write(json.dumps(normalized, ensure_ascii=False, separators=(",", ":")) + "\n")
        temp.flush(); os.fsync(temp.fileno()); temp_path = Path(temp.name)
    os.replace(temp_path, path)
    return normalized


def read_rules(*, rules_file: Path | None = None) -> dict[str, Any]:
    path = rules_file or globals()["rules_file"]()
    if not path.exists():
        return write_rules(DEFAULT_RULES, rules_file=path)
    try:
        return normalize_rules(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        raise ValueError(f"invalid persisted folder rules: {exc}") from exc


def read_workspaces(session_ids: list[str], *, state_db: Path | None = None) -> dict[str, str]:
    ids = list(dict.fromkeys(session_id for session_id in session_ids if isinstance(session_id, str) and session_id))
    path = state_db or session_db_file()
    if not ids or not path.exists():
        return {}
    placeholders = ",".join("?" for _ in ids)
    try:
        with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as conn:
            rows = conn.execute(
                f"SELECT id, cwd FROM sessions WHERE id IN ({placeholders}) AND cwd IS NOT NULL AND cwd != ''", ids
            ).fetchall()
    except sqlite3.Error as exc:
        raise ValueError(f"could not read session workspaces: {exc}") from exc
    return {session_id: cwd for session_id, cwd in rows if isinstance(cwd, str)}


def read_all_workspaces(*, state_db: Path | None = None) -> dict[str, str]:
    path = state_db or session_db_file()
    if not path.exists():
        return {}
    try:
        with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as conn:
            rows = conn.execute(
                "SELECT id, cwd FROM sessions WHERE cwd IS NOT NULL AND cwd != '' AND archived = 0"
            ).fetchall()
    except sqlite3.Error as exc:
        raise ValueError(f"could not read session workspaces: {exc}") from exc
    return {session_id: cwd for session_id, cwd in rows if isinstance(cwd, str)}


def auto_folder_id(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", name.strip().lower()).strip("_")
    return f"f_auto_{slug or 'rule'}"


def apply_workspace_rules(state: dict[str, Any], workspaces: dict[str, str], rules_config: dict[str, Any]) -> dict[str, Any]:
    rules = rules_config["rules"]
    folders = list(state["folders"])
    membership = dict(state["membership"])
    expanded = dict(state["expanded"])
    folders_by_name = {str(folder["name"]).strip().lower(): folder["id"] for folder in folders}

    for session_id, workspace in workspaces.items():
        if session_id in membership:
            continue
        rule = next((item for item in rules if workspace.startswith(item["workspace_prefix"])), None)
        if rule is None:
            continue
        folder_name = rule["folder"]
        folder_id = folders_by_name.get(folder_name.lower())
        if folder_id is None:
            folder_id = auto_folder_id(folder_name)
            folders.append({"id": folder_id, "name": folder_name, "createdAt": 0, "order": len(folders)})
            folders_by_name[folder_name.lower()] = folder_id
            expanded[folder_id] = True
        membership[session_id] = folder_id

    return {"folders": folders, "membership": membership, "expanded": expanded}


def read_reconciled_state() -> dict[str, Any]:
    state = read_state()
    next_state = apply_workspace_rules(state, read_all_workspaces(), read_rules())
    return write_state(next_state) if next_state != state else state


@router.get("/state")
def get_state() -> dict[str, Any]:
    try: return read_reconciled_state()
    except ValueError as exc: raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.put("/state")
def put_state(payload: FolderStatePayload) -> dict[str, Any]:
    try: return write_state(payload.model_dump())
    except ValueError as exc: raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/rules")
def get_rules() -> dict[str, Any]:
    try: return read_rules()
    except ValueError as exc: raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.put("/rules")
def put_rules(payload: FolderRulesPayload) -> dict[str, Any]:
    try: return write_rules(payload.model_dump())
    except ValueError as exc: raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/workspaces")
def get_workspaces(payload: WorkspaceLookupPayload) -> dict[str, Any]:
    try: return {"workspaces": read_workspaces(payload.session_ids)}
    except ValueError as exc: raise HTTPException(status_code=500, detail=str(exc)) from exc
