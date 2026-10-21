# Session Folders (Hermes Desktop plugin)

ChatGPT-style **conversation folders** for [Hermes Desktop](https://github.com/NousResearch/hermes-agent) — without patching core.

Adds a **Folders** tab next to **Sessions** (same dock pattern as Bot Mode). You create folders, drag sessions into them, and open chats with a click. Folder state is stored in `<HERMES_HOME>/plugin-data/session-folders/state.json`

## Install

```bash
# From this repo (the plugin backend must be enabled once):
mkdir -p ~/.hermes/plugins ~/.hermes/desktop-plugins
ln -sfn "$(pwd)" ~/.hermes/plugins/session-folders
ln -sfn "$(pwd)" ~/.hermes/desktop-plugins/session-folders
hermes config set plugins.enabled '["session-folders"]'
```

The folder name **must** be `session-folders` (matches the plugin id). The same checkout supplies the Desktop UI and the trusted backend; `plugin.js` is the only Desktop entry point.

Then in Desktop: **⌘K → Reload desktop plugins**, or restart the app.


For a named profile, use that profile’s Hermes home; its state remains isolated under that home’s `plugin-data/session-folders/` directory.

## What you get

- Create / rename / delete folders
- Auto-file ACP sessions into an **ACP** folder (created if missing)
- **Unfiled** list of sessions from `session.list`
- Drag a session onto a folder (or back to Unfiled)
- Drag folders to reorder
- Context menu: Open, Rename, Move to…, Remove from folder, Archive, Delete
- Folder context menu: Rename, Delete folder
- Search within the pane
- State survives Desktop updates and browser-origin changes (atomic JSON file per Hermes **profile**)
- Existing `ctx.storage` state is migrated into the durable backend on first successful load
- Membership is never garbage-collected from a capped session-list response

## Docs

- [Desktop Plugin SDK](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/desktop-plugin-sdk.md)

## License

MIT
