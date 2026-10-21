"""Durable state API for the Session Folders Desktop plugin."""

from __future__ import annotations

import json
import os
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

PLUGIN_ID = "session-folders"
STATE_FILE = "state.json"
router = APIRouter()


class FolderStatePayload(BaseModel):
    folders: list[dict[str, Any]]
    membership: dict[str, str]
    expanded: dict[str, bool]


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


@router.get("/state")
def get_state() -> dict[str, Any]:
    try: return read_state()
    except ValueError as exc: raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.put("/state")
def put_state(payload: FolderStatePayload) -> dict[str, Any]:
    try: return write_state(payload.model_dump())
    except ValueError as exc: raise HTTPException(status_code=422, detail=str(exc)) from exc
