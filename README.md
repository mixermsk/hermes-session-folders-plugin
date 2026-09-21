# Session Folders (Hermes Desktop plugin)

ChatGPT-style **conversation folders** for [Hermes Desktop](https://github.com/NousResearch/hermes-agent) — without patching core.

Adds a **Folders** tab next to **Sessions** (same dock pattern as Bot Mode). You create folders, drag sessions into them, and open chats with a click. Membership is stored locally in the plugin’s `ctx.storage` (scoped by connection + profile).

## Install

```bash
# From this repo:
mkdir -p ~/.hermes/desktop-plugins/session-folders
cp plugin.js ~/.hermes/desktop-plugins/session-folders/plugin.js

# Or symlink (edits hot-reload):
ln -sfn "$(pwd)" ~/.hermes/desktop-plugins/session-folders
```

The folder name **must** be `session-folders` (matches `id` in `plugin.js`).

Then in Desktop: **⌘K → Reload desktop plugins**, or restart the app.  
Enable under **Settings → Plugins** if it shows as off.

For a named Hermes profile, install under that profile’s home:

```bash
mkdir -p ~/.hermes/profiles/<name>/desktop-plugins/session-folders
cp plugin.js ~/.hermes/profiles/<name>/desktop-plugins/session-folders/
```

## What you get

- Create / rename / delete folders
- Auto-file ACP sessions into an **ACP** folder (created if missing)
- **Unfiled** list of sessions from `session.list`
- Drag a session onto a folder (or back to Unfiled)
- Drag folders to reorder
- Context menu: Open, Rename, Move to…, Remove from folder, Archive, Delete
- Folder context menu: Rename, Delete folder
- Search within the pane
- State survives app restart (stored per Hermes **profile** in `ctx.storage`; migrates older connection-scoped keys automatically)

## Docs

- [Desktop Plugin SDK](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/desktop-plugin-sdk.md)

## License

MIT
