/**
 * Session Folders — ChatGPT-style conversation folders for Hermes Desktop.
 *
 * Second left-column tab next to Sessions (Bots dock pattern). Folder state is
 * stored by the bundled plugin backend; legacy `ctx.storage` is migrated once.
 *   cp -R . ~/.hermes/desktop-plugins/session-folders
 * Folder name must equal plugin id (`session-folders`).
 */

import {
  Button,
  Codicon,
  ConfirmDialog,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  GlyphSpinner,
  Input,
  ScrollArea,
  SearchField,
  Tip,
  cn,
  haptic,
  host,
  queryClient,
  relativeTime,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const PLUGIN_ID = 'session-folders'
const LIST_LIMIT = 100
const ACP_FOLDER_ID = 'f_auto_acp'
const ACP_FOLDER_NAME = 'ACP'

/** @type {null | { get: Function, set: Function, remove: Function }} */
let _storage = null
let _rest = null

function setPersistence(ctx) {
  _storage = ctx.storage
  _rest = ctx.rest
}

function scopeProfile(profile) {
  return String(profile || 'default').trim() || 'default'
}

// Retained for an already-mounted pane while Desktop hot-reloads this module.
function scopeKey(connectionId, profile) {
  const conn = String(connectionId || 'local').trim() || 'local'
  return `${conn}::${scopeProfile(profile)}`
}

/** Stable persistence key — profile only (connectionId shifts across restarts). */
function storageKey(profile) {
  return `profile.${scopeProfile(profile)}`
}

function legacyStorageKeys(profile, connectionId) {
  const prof = scopeProfile(profile)
  const conn = String(connectionId || '').trim() || 'local'
  return [...new Set([storageKey(prof), `scopes.${conn}::${prof}`, `scopes.local::${prof}`, `scopes.null::${prof}`])]
}

function parseScopeRaw(raw) {
  if (!raw || typeof raw !== 'object') return emptyState()

  const folders = Array.isArray(raw.folders)
    ? raw.folders
        .filter(f => f && typeof f.id === 'string' && typeof f.name === 'string')
        .map((f, i) => ({
          id: f.id,
          name: String(f.name).trim() || 'Untitled',
          createdAt: Number(f.createdAt) || Date.now(),
          order: typeof f.order === 'number' ? f.order : i
        }))
        .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
    : []

  const membership =
    raw.membership && typeof raw.membership === 'object' && !Array.isArray(raw.membership)
      ? Object.fromEntries(
          Object.entries(raw.membership).filter(
            ([sid, fid]) => typeof sid === 'string' && typeof fid === 'string'
          )
        )
      : {}

  const expanded =
    raw.expanded && typeof raw.expanded === 'object' && !Array.isArray(raw.expanded)
      ? Object.fromEntries(Object.entries(raw.expanded).filter(([, v]) => typeof v === 'boolean'))
      : {}

  return { folders, membership, expanded }
}

function loadLocalScope(profile, connectionId) {
  if (!_storage) return emptyState()

  const canonical = storageKey(profile)
  const direct = _storage.get(canonical, null)
  if (direct && typeof direct === 'object') {
    const parsed = parseScopeRaw(direct)
    if (parsed.folders.length || Object.keys(parsed.membership).length) {
      return parsed
    }
  }

  for (const legacyKey of legacyStorageKeys(profile, connectionId)) {
    if (legacyKey === canonical) continue
    const raw = _storage.get(legacyKey, null)
    if (!raw || typeof raw !== 'object') continue
    const parsed = parseScopeRaw(raw)
    if (!parsed.folders.length && !Object.keys(parsed.membership).length) continue
    saveLocalScope(profile, parsed)
    return parsed
  }

  return parseScopeRaw(direct)
}

function saveLocalScope(profile, state) {
  if (!_storage) return
  _storage.set(storageKey(profile), {
    folders: state.folders,
    membership: state.membership,
    expanded: state.expanded
  })
}

function hasState(state) {
  return state.folders.length > 0 || Object.keys(state.membership).length > 0
}

async function loadScope(profile, connectionId) {
  const local = loadLocalScope(profile, connectionId)
  if (typeof _rest !== 'function') return local

  try {
    const remote = parseScopeRaw(await _rest('/state'))
    if (hasState(remote) || !hasState(local)) return remote
    await _rest('/state', { method: 'PUT', body: local })
    return local
  } catch (err) {
    console.warn('[session-folders] durable storage unavailable; using legacy local storage', err)
    return local
  }
}

async function saveScope(profile, state) {
  if (typeof _rest === 'function') {
    try {
      await _rest('/state', { method: 'PUT', body: state })
      return
    } catch (err) {
      console.warn('[session-folders] durable storage write failed; using legacy local storage', err)
    }
  }
  saveLocalScope(profile, state)
}

function emptyState() {
  return { folders: [], membership: {}, expanded: {} }
}

function newFolderId() {
  return `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function sessionTitle(session) {
  const t = String(session?.title || '').trim()
  if (t) return t
  const preview = String(session?.preview || '').trim()
  if (preview) return preview.slice(0, 72)
  return session?.id ? `Session ${String(session.id).slice(0, 8)}` : 'Untitled'
}

/** session.list returns Unix seconds; relativeTime expects ms. */
function toMs(epoch) {
  const n = Number(epoch) || 0
  if (n <= 0) return 0
  // Seconds are ~1e9; ms are ~1e12. Threshold keeps both shapes honest.
  return n < 1e12 ? n * 1000 : n
}

function matchesQuery(session, q) {
  if (!q) return true
  const hay = `${sessionTitle(session)} ${session?.preview || ''} ${session?.id || ''}`.toLowerCase()
  return hay.includes(q)
}

export async function fetchSessions(profile, connectionId, query = '') {
  const api = typeof window !== 'undefined' ? window.hermesDesktop?.api : null
  const searchQuery = String(query || '').trim()
  let res
  if (typeof api === 'function') {
    const params = searchQuery
      ? new URLSearchParams({ q: searchQuery, limit: String(LIST_LIMIT) })
      : new URLSearchParams({ limit: String(LIST_LIMIT) })
    const prof = String(profile || '').trim()
    if (prof) params.set('profile', prof)
    const request = { path: `${searchQuery ? '/api/sessions/search' : '/api/sessions'}?${params}` }
    const conn = String(connectionId || '').trim()
    if (conn) request.connectionId = conn
    res = await api(request)
  } else {
    res = await host.request('session.list', { limit: LIST_LIMIT })
  }
  const rows = Array.isArray(res?.results)
    ? res.results
    : Array.isArray(res?.data)
      ? res.data
      : Array.isArray(res?.sessions)
        ? res.sessions
        : Array.isArray(res)
          ? res
          : []
  return rows
    .filter(s => s && typeof s.id === 'string')
    .map(s => {
      const workspace = s.workspace || s.cwd || ''
      return {
        id: s.id,
        title: s.title || '',
        preview: s.preview || s.snippet || '',
        started_at: Number(s.started_at) || Number(s.session_started) || 0,
        last_active: Number(s.last_active) || Number(s.started_at) || Number(s.session_started) || 0,
        message_count: Number(s.message_count) || 0,
        source: s.source || '',
        ...(workspace ? { workspace } : {})
      }
    })
    .sort((a, b) => b.last_active - a.last_active)
}

function isAcpSession(session) {
  return String(session?.source || '')
    .trim()
    .toLowerCase() === 'acp'
}

function normalizeRules(raw) {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(rule => {
    const workspacePrefix = String(rule?.workspace_prefix || '').trim()
    const folder = String(rule?.folder || '').trim()
    return workspacePrefix && folder ? [{ workspacePrefix, folder }] : []
  })
}

function autoFolderId(name) {
  const slug = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `f_auto_${slug || 'rule'}`
}

function matchingRule(session, rules) {
  const workspace = String(session?.workspace || '').trim()
  return rules.find(rule => workspace.startsWith(rule.workspacePrefix)) || null
}

/**
 * Auto-file ACP and configured workspace sessions. Existing membership always
 * wins, so a user's manual move is never overwritten by a later refresh.
 */
export function applyAutoFileRules(state, sessions, rawRules = []) {
  const rules = normalizeRules(rawRules)
  let folders = state.folders
  let expanded = state.expanded
  let membership = state.membership
  let changed = false
  const nextMembership = { ...membership }
  const folderIdsByName = new Map(folders.map(folder => [String(folder.name || '').trim().toLowerCase(), folder.id]))

  const ensureFolder = (name, preferredId) => {
    const normalizedName = String(name || '').trim()
    const key = normalizedName.toLowerCase()
    const existingId = folderIdsByName.get(key)
    if (existingId) return existingId
    const id = preferredId || autoFolderId(normalizedName)
    folders = [...folders, { id, name: normalizedName, createdAt: 0, order: folders.length }]
    folderIdsByName.set(key, id)
    expanded = { ...expanded, [id]: true }
    changed = true
    return id
  }

  for (const s of sessions) {
    if (!nextMembership[s.id]) {
      const acp = isAcpSession(s)
      const rule = acp ? null : matchingRule(s, rules)
      if (!acp && !rule) continue
      nextMembership[s.id] = ensureFolder(acp ? ACP_FOLDER_NAME : rule.folder, acp ? ACP_FOLDER_ID : null)
      changed = true
    }
  }

  if (!changed) return state
  return {
    ...state,
    folders,
    membership: nextMembership,
    expanded
  }
}

async function loadRules() {
  if (typeof _rest !== 'function') return []
  try {
    const config = await _rest('/rules')
    return normalizeRules(config?.rules)
  } catch (err) {
    console.warn('[session-folders] rules unavailable; automatic workspace filing disabled', err)
    return []
  }
}

async function loadWorkspaces(sessions) {
  if (typeof _rest !== 'function' || !sessions.length) return {}
  try {
    const result = await _rest('/workspaces', {
      method: 'POST',
      body: { session_ids: sessions.map(session => session.id) }
    })
    return result?.workspaces && typeof result.workspaces === 'object' ? result.workspaces : {}
  } catch (err) {
    console.warn('[session-folders] workspace lookup unavailable; automatic workspace filing disabled', err)
    return {}
  }
}

function openSession(id) {
  if (typeof host.openSession !== 'function') {
    host.notify?.({
      kind: 'error',
      message: 'openSession is not available on this desktop build.'
    })
    return
  }
  haptic?.('tap')
  void host.openSession(id).catch(err => {
    host.notifyError?.(err, 'Could not open session')
  })
}

/** Same REST door core uses for sidebar archive (PATCH /api/sessions/:id). */
async function archiveSessionRemote(sessionId, profile) {
  const api = typeof window !== 'undefined' ? window.hermesDesktop?.api : null
  if (typeof api !== 'function') {
    throw new Error('Archive is not available on this desktop build.')
  }
  const body = { archived: true }
  const prof = String(profile || '').trim()
  if (prof) body.profile = prof
  return api({
    path: `/api/sessions/${encodeURIComponent(sessionId)}`,
    method: 'PATCH',
    body
  })
}

/** Same REST door core uses for sidebar delete (DELETE /api/sessions/:id). */
async function deleteSessionRemote(sessionId, profile) {
  const api = typeof window !== 'undefined' ? window.hermesDesktop?.api : null
  if (typeof api !== 'function') {
    throw new Error('Delete is not available on this desktop build.')
  }
  const opts = {
    path: `/api/sessions/${encodeURIComponent(sessionId)}`,
    method: 'DELETE'
  }
  const prof = String(profile || '').trim()
  if (prof) opts.profile = prof
  return api(opts)
}

/**
 * Prefer gateway `session.title` (works for live / runtime-only chats), then
 * the same REST PATCH core uses for persisted sidebar rows.
 */
async function renameSessionRemote(sessionId, title, profile) {
  const trimmed = String(title || '').trim()
  if (!trimmed) throw new Error('Title is required')

  let rpcError = null
  if (typeof host.request === 'function') {
    try {
      const result = await host.request('session.title', {
        session_id: sessionId,
        title: trimmed
      })
      return { title: result?.title ?? trimmed }
    } catch (err) {
      rpcError = err
    }
  }

  const api = typeof window !== 'undefined' ? window.hermesDesktop?.api : null
  if (typeof api === 'function') {
    const body = { title: trimmed }
    const prof = String(profile || '').trim()
    if (prof) body.profile = prof
    return api({
      path: `/api/sessions/${encodeURIComponent(sessionId)}`,
      method: 'PATCH',
      body
    })
  }

  throw rpcError || new Error('Rename is not available on this desktop build.')
}

function readDragSession(e, fallback) {
  try {
    const raw = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text/session-folders-session') || ''
    if (raw.startsWith(DRAG_SESSION_PREFIX)) return raw.slice(DRAG_SESSION_PREFIX.length)
    if (raw && !raw.startsWith(DRAG_FOLDER_PREFIX)) return raw
  } catch {
    /* ignore */
  }
  return fallback
}

function readDragFolder(e, fallback) {
  try {
    const raw = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text/session-folders-folder') || ''
    if (raw.startsWith(DRAG_FOLDER_PREFIX)) return raw.slice(DRAG_FOLDER_PREFIX.length)
  } catch {
    /* ignore */
  }
  return fallback
}

const DRAG_SESSION_PREFIX = 'sf:s:'
const DRAG_FOLDER_PREFIX = 'sf:f:'

function beginSessionDrag(e, sessionId, setDragSessionId) {
  setDragSessionId(sessionId)
  try {
    e.dataTransfer.setData('text/plain', `${DRAG_SESSION_PREFIX}${sessionId}`)
    e.dataTransfer.setData('text/session-folders-session', sessionId)
    e.dataTransfer.effectAllowed = 'move'
    if (e.currentTarget?.getBoundingClientRect) {
      const rect = e.currentTarget.getBoundingClientRect()
      e.dataTransfer.setDragImage(
        e.currentTarget,
        Math.max(0, e.clientX - rect.left),
        Math.max(0, e.clientY - rect.top)
      )
    }
  } catch {
    /* older webviews */
  }
}

function beginFolderDrag(e, folderId, setDragFolderId) {
  e.stopPropagation()
  setDragFolderId(folderId)
  try {
    e.dataTransfer.setData('text/plain', `${DRAG_FOLDER_PREFIX}${folderId}`)
    e.dataTransfer.setData('text/session-folders-folder', folderId)
    e.dataTransfer.effectAllowed = 'move'
  } catch {
    /* ignore */
  }
}

function folderDropHandlers({ setDropOver, onSessionDrop, onFolderDrop, dragSessionId, dragFolderId }) {
  return {
    onDragEnter: e => {
      e.preventDefault()
      setDropOver(true)
    },
    onDragOver: e => {
      e.preventDefault()
      try {
        e.dataTransfer.dropEffect = 'move'
      } catch {
        /* ignore */
      }
      setDropOver(true)
    },
    onDragLeave: e => {
      if (e.currentTarget.contains(e.relatedTarget)) return
      setDropOver(false)
    },
    onDrop: e => {
      e.preventDefault()
      e.stopPropagation()
      setDropOver(false)
      const sessionId = readDragSession(e, dragSessionId)
      const folderId = readDragFolder(e, dragFolderId)
      if (sessionId) onSessionDrop?.(sessionId)
      else if (folderId) onFolderDrop?.(folderId)
    }
  }
}

const FALLBACK_ATOM = {
  get: () => null,
  listen: () => () => {},
  subscribe: () => () => {}
}

// ─── Session row ────────────────────────────────────────────────────────────

function SessionRow({
  session,
  folders,
  currentFolderId,
  onAssign,
  onUnfile,
  onArchive,
  onRename,
  onDelete,
  dragSessionId,
  setDragSessionId
}) {
  const focusedId = useValue(host.state.focusedStoredSessionId || FALLBACK_ATOM)
  const active = focusedId === session.id
  const title = sessionTitle(session)
  const when = session.last_active && relativeTime ? relativeTime(toMs(session.last_active)) : ''
  const otherFolders = folders.filter(f => f.id !== currentFolderId)

  const row = jsxs('div', {
    role: 'button',
    tabIndex: 0,
    onKeyDown: e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        openSession(session.id)
      }
    },
    onClick: () => openSession(session.id),
    className: cn(
      'group flex w-full cursor-pointer items-start gap-1 rounded-md px-1 py-1.5 text-left text-[0.8125rem] transition-colors',
      'hover:bg-(--chrome-action-hover)',
      active && 'bg-(--chrome-action-hover) text-foreground',
      dragSessionId === session.id && 'opacity-50'
    ),
    children: [
      jsx('span', {
        draggable: true,
        title: 'Drag to folder',
        className: cn(
          'mt-0.5 flex h-4 w-4 shrink-0 cursor-grab items-center justify-center rounded text-(--ui-text-tertiary)',
          'opacity-40 group-hover:opacity-100 active:cursor-grabbing',
          dragSessionId === session.id && 'opacity-100'
        ),
        onClick: e => e.stopPropagation(),
        onDragStart: e => {
          e.stopPropagation()
          beginSessionDrag(e, session.id, setDragSessionId)
        },
        onDragEnd: () => setDragSessionId(null),
        children: jsx(Codicon, { name: 'grabber', size: '0.7rem' })
      }),
      jsx(Codicon, {
        name: 'comment-discussion',
        size: '0.75rem',
        className: 'mt-0.5 shrink-0 text-(--ui-text-tertiary)'
      }),
      jsxs('span', {
        className: 'min-w-0 flex-1',
        children: [
          jsx('span', {
            className: 'block truncate font-medium text-foreground',
            children: title
          }),
          when
            ? jsx('span', {
                className: 'block truncate text-[0.6875rem] text-(--ui-text-tertiary)',
                children: when
              })
            : null
        ]
      })
    ]
  })

  const menuItems = [
    jsx(ContextMenuItem, { onSelect: () => openSession(session.id), children: 'Open' }, 'open'),
    jsx(ContextMenuItem, { onSelect: () => onRename?.(session), children: 'Rename' }, 'rename')
  ]
  if (otherFolders.length) {
    menuItems.push(jsx(ContextMenuSeparator, {}, 'sep-move'))
    for (const f of otherFolders) {
      menuItems.push(
        jsx(
          ContextMenuItem,
          { onSelect: () => onAssign(session.id, f.id), children: `Move to ${f.name}` },
          `move-${f.id}`
        )
      )
    }
  }
  if (currentFolderId) {
    menuItems.push(jsx(ContextMenuSeparator, {}, 'sep-unfile'))
    menuItems.push(
      jsx(ContextMenuItem, { onSelect: () => onUnfile(session.id), children: 'Remove from folder' }, 'unfile')
    )
  }
  menuItems.push(jsx(ContextMenuSeparator, {}, 'sep-danger'))
  menuItems.push(
    jsx(
      ContextMenuItem,
      {
        onSelect: () => onArchive?.(session.id),
        children: 'Archive'
      },
      'archive'
    )
  )
  menuItems.push(
    jsx(
      ContextMenuItem,
      {
        onSelect: () => onDelete?.(session),
        className: 'text-destructive',
        children: 'Delete'
      },
      'delete'
    )
  )

  return jsxs(ContextMenu, {
    children: [
      jsx(ContextMenuTrigger, { asChild: true, children: row }),
      jsx(ContextMenuContent, { children: menuItems })
    ]
  })
}

// ─── Folder section ─────────────────────────────────────────────────────────

function FolderSection({
  folder,
  sessions,
  folders,
  expanded,
  onToggle,
  onRename,
  onRenameSession,
  onDelete,
  onDeleteSession,
  onAssign,
  onUnfile,
  onArchive,
  onDropSession,
  onReorderFolder,
  dragSessionId,
  setDragSessionId,
  dragFolderId,
  setDragFolderId
}) {
  const [dropOver, setDropOver] = useState(false)
  const open = expanded[folder.id] !== false
  const dropHandlers = folderDropHandlers({
    setDropOver,
    dragSessionId,
    dragFolderId,
    onSessionDrop: sid => onDropSession(sid, folder.id),
    onFolderDrop: fromId => {
      if (fromId !== folder.id) onReorderFolder(fromId, folder.id)
    }
  })

  return jsxs('div', {
    className: cn('mb-1', dropOver && 'rounded-md ring-1 ring-foreground/30'),
    ...dropHandlers,
    children: [
      jsxs(ContextMenu, {
        children: [
          jsx(ContextMenuTrigger, {
            asChild: true,
            children: jsxs('div', {
              className: 'group flex items-center gap-0.5 px-1',
              children: [
                jsx('span', {
                  draggable: true,
                  title: 'Drag to reorder',
                  className:
                    'flex h-7 w-4 shrink-0 cursor-grab items-center justify-center text-(--ui-text-tertiary) opacity-40 group-hover:opacity-100 active:cursor-grabbing',
                  onDragStart: e => beginFolderDrag(e, folder.id, setDragFolderId),
                  onDragEnd: () => setDragFolderId(null),
                  children: jsx(Codicon, { name: 'grabber', size: '0.65rem' })
                }),
                jsx('button', {
                  type: 'button',
                  className:
                    'flex h-7 w-5 shrink-0 items-center justify-center text-(--ui-text-tertiary) hover:text-foreground',
                  onClick: () => onToggle(folder.id),
                  'aria-label': open ? 'Collapse' : 'Expand',
                  children: jsx(Codicon, {
                    name: open ? 'chevron-down' : 'chevron-right',
                    size: '0.7rem'
                  })
                }),
                jsx(Codicon, {
                  name: 'folder',
                  size: '0.75rem',
                  className: 'shrink-0 text-(--ui-text-tertiary)'
                }),
                jsx('button', {
                  type: 'button',
                  className:
                    'min-w-0 flex-1 truncate px-1 py-1 text-left text-[0.75rem] font-medium text-foreground',
                  onClick: () => onToggle(folder.id),
                  children: folder.name
                }),
                jsx('span', {
                  className: 'px-1 text-[0.6875rem] tabular-nums text-(--ui-text-tertiary)',
                  children: String(sessions.length)
                }),
                jsx('button', {
                  type: 'button',
                  className:
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded opacity-0 hover:bg-(--chrome-action-hover) group-hover:opacity-100',
                  'aria-label': 'Folder menu',
                  children: jsx(Codicon, { name: 'ellipsis', size: '0.75rem' })
                })
              ]
            })
          }),
          jsxs(ContextMenuContent, {
            children: [
              jsx(ContextMenuItem, {
                onSelect: () => onRename(folder),
                children: 'Rename'
              }),
              jsx(ContextMenuSeparator, {}),
              jsx(ContextMenuItem, {
                onSelect: () => onDelete(folder),
                className: 'text-destructive',
                children: 'Delete folder'
              })
            ]
          })
        ]
      }),
      open
        ? sessions.length
          ? jsx('div', {
              className: 'ml-2 border-l border-(--ui-border) pl-1',
              children: sessions.map(s =>
                jsx(
                  SessionRow,
                  {
                    session: s,
                    folders,
                    currentFolderId: folder.id,
                    onAssign,
                    onUnfile,
                    onArchive,
                    onRename: onRenameSession,
                    onDelete: onDeleteSession,
                    dragSessionId,
                    setDragSessionId
                  },
                  s.id
                )
              )
            })
          : jsx('div', {
              className: 'min-h-8 px-3 py-2 text-[0.6875rem] text-(--ui-text-tertiary)',
              children: 'Empty — drop sessions here'
            })
        : null
    ]
  })
}

function UnfiledSection({
  sessions,
  folders,
  onAssign,
  onUnfile,
  onArchive,
  onRenameSession,
  onDeleteSession,
  onDropSession,
  dragSessionId,
  setDragSessionId
}) {
  const [dropOver, setDropOver] = useState(false)
  const dropHandlers = folderDropHandlers({
    setDropOver,
    dragSessionId,
    dragFolderId: null,
    onSessionDrop: sid => onDropSession(sid, null)
  })

  return jsxs('div', {
    className: cn('mt-2 mb-1', dropOver && 'rounded-md ring-1 ring-foreground/30'),
    ...dropHandlers,
    children: [
      jsxs('div', {
        className:
          'flex items-center gap-1 px-2 py-1 text-[0.6875rem] font-medium uppercase tracking-wide text-(--ui-text-tertiary)',
        children: [
          jsx('span', { className: 'flex-1', children: 'Unfiled' }),
          jsx('span', { className: 'tabular-nums', children: String(sessions.length) })
        ]
      }),
      sessions.length
        ? sessions.map(s =>
            jsx(
              SessionRow,
              {
                session: s,
                folders,
                currentFolderId: null,
                onAssign,
                onUnfile,
                onArchive,
                onRename: onRenameSession,
                onDelete: onDeleteSession,
                dragSessionId,
                setDragSessionId
              },
              s.id
            )
          )
        : jsx('div', {
            className: 'px-3 py-1 text-[0.6875rem] text-(--ui-text-tertiary)',
            children: 'All sessions are in folders'
          })
    ]
  })
}

// ─── Main pane ──────────────────────────────────────────────────────────────

function FoldersPane() {
  const profile = useValue(host.state.profile || FALLBACK_ATOM) || 'default'
  const connectionId = useValue(host.state.connectionId || FALLBACK_ATOM) || 'local'
  const profileKey = scopeProfile(profile)

  const [state, setState] = useState(emptyState)
  const [stateReady, setStateReady] = useState(false)
  const [rules, setRules] = useState([])
  const [workspaces, setWorkspaces] = useState({})
  const [query, setQuery] = useState('')
  const [dragSessionId, setDragSessionId] = useState(null)
  const [dragFolderId, setDragFolderId] = useState(null)
  const [renameTarget, setRenameTarget] = useState(null)
  const [renameValue, setRenameValue] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const newInputRef = useRef(null)
  const renameInputRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    setStateReady(false)
    void loadScope(profile, connectionId).then(next => {
      if (!cancelled) {
        setState(next)
        setStateReady(true)
      }
    })
    return () => {
      cancelled = true
    }
  }, [profileKey, connectionId])

  useEffect(() => {
    let cancelled = false
    void loadRules().then(next => {
      if (!cancelled) setRules(next)
    })
    return () => {
      cancelled = true
    }
  }, [profileKey])

  const persist = useCallback(
    updater => {
      setState(prev => {
        const next = typeof updater === 'function' ? updater(prev) : updater
        void saveScope(profile, next)
        return next
      })
    },
    [profileKey]
  )

  const q = query.trim().toLowerCase()
  const { data: sessions = [], isLoading, isError, isSuccess, refetch, error } = useQuery({
    queryKey: [PLUGIN_ID, 'sessions', profileKey, connectionId, q],
    queryFn: () => fetchSessions(profile, connectionId, q),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true
  })

  useEffect(() => {
    let cancelled = false
    void loadWorkspaces(sessions).then(next => {
      if (!cancelled) setWorkspaces(next)
    })
    return () => {
      cancelled = true
    }
  }, [sessions])

  const sessionsWithWorkspace = useMemo(
    () => sessions.map(session => ({ ...session, workspace: workspaces[session.id] || session.workspace || '' })),
    [sessions, workspaces]
  )

  // Never delete membership from a partial session-list response. The backend
  // may cap that response, while saved memberships must survive indefinitely.
  // Auto-file only after durable state and rule data have loaded.
  useEffect(() => {
    if (!stateReady || !isSuccess || sessionsWithWorkspace.length === 0) return
    persist(prev => applyAutoFileRules(prev, sessionsWithWorkspace, rules))
  }, [sessionsWithWorkspace, rules, isSuccess, persist, stateReady])

  useEffect(() => {
    if (creating) newInputRef.current?.focus?.()
  }, [creating])

  useEffect(() => {
    if (!renameTarget) return
    const el = renameInputRef.current
    el?.focus?.()
    el?.select?.()
  }, [renameTarget])

  const filtered = useMemo(
    () => (q ? sessionsWithWorkspace.filter(s => matchesQuery(s, q)) : sessionsWithWorkspace),
    [sessionsWithWorkspace, q]
  )

  const byFolder = useMemo(() => {
    const map = {}
    for (const f of state.folders) map[f.id] = []
    const unfiled = []
    for (const s of filtered) {
      const fid = state.membership[s.id]
      if (fid && map[fid]) map[fid].push(s)
      else unfiled.push(s)
    }
    return { map, unfiled }
  }, [filtered, state.folders, state.membership])

  const createFolder = () => {
    const name = newName.trim() || 'New folder'
    const folder = {
      id: newFolderId(),
      name,
      createdAt: Date.now(),
      order: state.folders.length
    }
    persist(prev => ({
      ...prev,
      folders: [...prev.folders, folder],
      expanded: { ...prev.expanded, [folder.id]: true }
    }))
    setCreating(false)
    setNewName('')
    haptic?.('success')
  }

  const closeRename = () => {
    if (renaming) return
    setRenameTarget(null)
    setRenameValue('')
  }

  const beginRenameFolder = folder => {
    setRenameTarget({ type: 'folder', id: folder.id, name: folder.name })
    setRenameValue(folder.name)
  }

  const beginRenameSession = session => {
    const name = sessionTitle(session)
    setRenameTarget({ type: 'session', id: session.id, name })
    setRenameValue(name)
  }

  const commitRename = () => {
    if (!renameTarget || renaming) return
    const name = renameValue.trim()
    if (!name) return

    if (renameTarget.type === 'folder') {
      persist(prev => ({
        ...prev,
        folders: prev.folders.map(f => (f.id === renameTarget.id ? { ...f, name } : f))
      }))
      setRenameTarget(null)
      setRenameValue('')
      return
    }

    if (name === renameTarget.name) {
      closeRename()
      return
    }

    setRenaming(true)
    void (async () => {
      try {
        await renameSessionRemote(renameTarget.id, name, profile)
        queryClient?.invalidateQueries?.({ queryKey: [PLUGIN_ID, 'sessions', profileKey] })
        host.notify?.({ kind: 'success', message: 'Session renamed', durationMs: 2000 })
        setRenameTarget(null)
        setRenameValue('')
      } catch (err) {
        host.notifyError?.(err, 'Could not rename session')
      } finally {
        setRenaming(false)
      }
    })()
  }

  const confirmDelete = () => {
    if (!deleteTarget) return

    if (deleteTarget.type === 'session') {
      const sessionId = deleteTarget.id
      setDeleteTarget(null)
      haptic?.('warning')
      void (async () => {
        try {
          await deleteSessionRemote(sessionId, profile)
          persist(prev => {
            const membership = { ...prev.membership }
            delete membership[sessionId]
            return { ...prev, membership }
          })
          queryClient?.invalidateQueries?.({ queryKey: [PLUGIN_ID, 'sessions', profileKey] })
          host.notify?.({ kind: 'success', message: 'Session deleted', durationMs: 2000 })
        } catch (err) {
          host.notifyError?.(err, 'Could not delete session')
        }
      })()
      return
    }

    const id = deleteTarget.id
    persist(prev => {
      const membership = { ...prev.membership }
      for (const [sid, fid] of Object.entries(membership)) {
        if (fid === id) delete membership[sid]
      }
      const expanded = { ...prev.expanded }
      delete expanded[id]
      return {
        folders: prev.folders.filter(f => f.id !== id).map((f, i) => ({ ...f, order: i })),
        membership,
        expanded
      }
    })
    setDeleteTarget(null)
  }

  const beginDeleteFolder = folder => {
    setDeleteTarget({ type: 'folder', id: folder.id, name: folder.name })
  }

  const beginDeleteSession = session => {
    setDeleteTarget({ type: 'session', id: session.id, name: sessionTitle(session) })
  }

  const assign = (sessionId, folderId) => {
    persist(prev => ({
      ...prev,
      membership: { ...prev.membership, [sessionId]: folderId }
    }))
    haptic?.('tap')
  }

  const unfile = sessionId => {
    persist(prev => {
      const membership = { ...prev.membership }
      delete membership[sessionId]
      return { ...prev, membership }
    })
    haptic?.('tap')
  }

  const archive = sessionId => {
    if (!sessionId) return
    haptic?.('tap')
    void (async () => {
      try {
        await archiveSessionRemote(sessionId, profile)
        persist(prev => {
          const membership = { ...prev.membership }
          delete membership[sessionId]
          return { ...prev, membership }
        })
        queryClient?.invalidateQueries?.({ queryKey: [PLUGIN_ID, 'sessions', profileKey] })
        host.notify?.({ kind: 'success', message: 'Session archived', durationMs: 2000 })
      } catch (err) {
        host.notifyError?.(err, 'Could not archive session')
      }
    })()
  }

  const dropSession = (sessionId, folderId) => {
    if (!sessionId) return
    if (folderId) assign(sessionId, folderId)
    else unfile(sessionId)
  }

  const reorderFolder = (fromId, beforeId) => {
    persist(prev => {
      const list = [...prev.folders]
      const fromIdx = list.findIndex(f => f.id === fromId)
      const toIdx = list.findIndex(f => f.id === beforeId)
      if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return prev
      const [item] = list.splice(fromIdx, 1)
      list.splice(toIdx, 0, item)
      return { ...prev, folders: list.map((f, i) => ({ ...f, order: i })) }
    })
  }

  const toggle = folderId => {
    persist(prev => ({
      ...prev,
      expanded: {
        ...prev.expanded,
        [folderId]: !(prev.expanded[folderId] !== false)
      }
    }))
  }

  const startNewSession = () => {
    haptic?.('tap')
    if (typeof host.newChat !== 'function') {
      host.notify?.({
        kind: 'error',
        message: 'New chat is not available on this desktop build.'
      })
      return
    }
    try {
      host.newChat()
    } catch (err) {
      host.notifyError?.(err, 'Could not start a new session')
    }
  }

  const searchControl = SearchField
    ? jsx(SearchField, {
        value: query,
        onChange: setQuery,
        placeholder: 'Search sessions…'
      })
    : jsx(Input, {
        value: query,
        onChange: e => setQuery(e.target.value),
        placeholder: 'Search sessions…',
        className: 'h-8 w-full'
      })

  const header = jsxs('div', {
    className: 'flex shrink-0 flex-col gap-2 border-b border-(--ui-border) p-2',
    children: [
      jsxs('div', {
        className: 'flex items-center gap-1',
        children: [
          jsx('div', {
            className: 'flex-1 text-[0.75rem] font-medium text-foreground',
            children: 'Folders'
          }),
          jsx(Tip, {
            label: 'Refresh sessions',
            children: jsx('button', {
              type: 'button',
              className:
                'flex h-7 w-7 items-center justify-center rounded hover:bg-(--chrome-action-hover)',
              onClick: () => void refetch(),
              'aria-label': 'Refresh',
              children: jsx(Codicon, { name: 'refresh', size: '0.75rem' })
            })
          }),
          jsx(Tip, {
            label: 'New folder',
            children: jsx('button', {
              type: 'button',
              className:
                'flex h-7 w-7 items-center justify-center rounded hover:bg-(--chrome-action-hover)',
              onClick: () => {
                setCreating(true)
                setNewName('')
              },
              'aria-label': 'New folder',
              children: jsx(Codicon, { name: 'new-folder', size: '0.8rem' })
            })
          })
        ]
      }),
      jsx(Button, {
        size: 'sm',
        className: 'w-full gap-1.5',
        onClick: startNewSession,
        children: [
          jsx(Codicon, { name: 'add', size: '0.75rem' }, 'icon'),
          'New session'
        ]
      }),
      searchControl,
      creating
        ? jsxs('div', {
            className: 'flex items-center gap-1',
            children: [
              jsx(Input, {
                ref: newInputRef,
                value: newName,
                onChange: e => setNewName(e.target.value),
                placeholder: 'Folder name',
                className: 'h-8 flex-1',
                onKeyDown: e => {
                  if (e.key === 'Enter') createFolder()
                  if (e.key === 'Escape') {
                    setCreating(false)
                    setNewName('')
                  }
                }
              }),
              jsx(Button, { size: 'sm', onClick: createFolder, children: 'Add' }),
              jsx(Button, {
                size: 'sm',
                variant: 'ghost',
                onClick: () => {
                  setCreating(false)
                  setNewName('')
                },
                children: 'Cancel'
              })
            ]
          })
        : null
    ]
  })

  let body
  if (isLoading && !sessions.length) {
    body = jsxs('div', {
      className: 'flex flex-1 items-center justify-center gap-2 text-(--ui-text-tertiary)',
      children: [jsx(GlyphSpinner, {}), jsx('span', { className: 'text-sm', children: 'Loading…' })]
    })
  } else if (isError) {
    body = jsxs('div', {
      className: 'flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-sm',
      children: [
        jsx('div', { children: 'Could not load sessions' }),
        jsx('div', {
          className: 'text-[0.6875rem] text-(--ui-text-tertiary)',
          children: String(error?.message || error || '')
        }),
        jsx(Button, { size: 'sm', onClick: () => void refetch(), children: 'Retry' })
      ]
    })
  } else if (!state.folders.length && !filtered.length) {
    body = jsxs('div', {
      className: 'flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center',
      children: [
        jsx(Codicon, {
          name: 'folder',
          size: '1.5rem',
          className: 'text-(--ui-text-tertiary)'
        }),
        jsx('div', { className: 'text-sm font-medium', children: 'No folders yet' }),
        jsx('div', {
          className: 'max-w-[14rem] text-[0.75rem] text-(--ui-text-tertiary)',
          children: 'Create a folder, then drag sessions into it from Unfiled.'
        }),
        jsx(Button, {
          size: 'sm',
          onClick: () => setCreating(true),
          children: 'New folder'
        })
      ]
    })
  } else {
    body = jsx(ScrollArea, {
      className: 'min-h-0 flex-1',
      children: jsxs('div', {
        className: 'p-1 pb-4',
        children: [
          ...state.folders.map(folder =>
            jsx(
              FolderSection,
              {
                folder,
                sessions: byFolder.map[folder.id] || [],
                folders: state.folders,
                expanded: state.expanded,
                onToggle: toggle,
                onRename: beginRenameFolder,
                onRenameSession: beginRenameSession,
                onDelete: beginDeleteFolder,
                onDeleteSession: beginDeleteSession,
                onAssign: assign,
                onUnfile: unfile,
                onArchive: archive,
                onDropSession: dropSession,
                onReorderFolder: reorderFolder,
                dragSessionId,
                setDragSessionId,
                dragFolderId,
                setDragFolderId
              },
              folder.id
            )
          ),
          jsx(UnfiledSection, {
            sessions: byFolder.unfiled,
            folders: state.folders,
            onAssign: assign,
            onUnfile: unfile,
            onArchive: archive,
            onRenameSession: beginRenameSession,
            onDeleteSession: beginDeleteSession,
            onDropSession: dropSession,
            dragSessionId,
            setDragSessionId
          })
        ]
      })
    })
  }

  return jsxs('div', {
    className: 'relative flex h-full min-h-0 flex-col',
    children: [
      header,
      body,
      renameTarget
        ? jsx('div', {
            className:
              'absolute inset-0 z-20 flex items-center justify-center bg-black/70 p-4 backdrop-blur-[2px]',
            onClick: closeRename,
            children: jsxs('div', {
              className:
                'w-full max-w-xs rounded-lg border border-(--ui-border) p-3 text-foreground shadow-lg',
              style: {
                backgroundColor: 'var(--ui-chat-bubble-background, var(--chrome-panel, #1e1e1e))'
              },
              onClick: e => e.stopPropagation(),
              children: [
                jsx('div', {
                  className: 'mb-2 text-sm font-medium text-foreground',
                  children: renameTarget.type === 'session' ? 'Rename session' : 'Rename folder'
                }),
                jsx(Input, {
                  ref: renameInputRef,
                  value: renameValue,
                  onChange: e => setRenameValue(e.target.value),
                  className: 'mb-3 h-8',
                  disabled: renaming,
                  onKeyDown: e => {
                    if (e.key === 'Enter') commitRename()
                    if (e.key === 'Escape') closeRename()
                  }
                }),
                jsxs('div', {
                  className: 'flex justify-end gap-1',
                  children: [
                    jsx(Button, {
                      size: 'sm',
                      variant: 'ghost',
                      disabled: renaming,
                      onClick: closeRename,
                      children: 'Cancel'
                    }),
                    jsx(Button, {
                      size: 'sm',
                      disabled: renaming || !renameValue.trim(),
                      onClick: commitRename,
                      children: 'Save'
                    })
                  ]
                })
              ]
            })
          })
        : null,
      deleteTarget
        ? jsx(ConfirmDialog, {
            open: true,
            onClose: () => setDeleteTarget(null),
            title: deleteTarget.type === 'session' ? 'Delete session?' : 'Delete folder?',
            description:
              deleteTarget.type === 'session'
                ? `"${deleteTarget.name}" will be permanently deleted.`
                : `"${deleteTarget.name}" will be removed. Sessions go back to Unfiled.`,
            confirmLabel: 'Delete',
            destructive: true,
            dismissOnConfirm: true,
            onConfirm: confirmDelete
          })
        : null
    ]
  })
}

export default {
  id: PLUGIN_ID,
  name: 'Session Folders',
  description:
    'ChatGPT-style conversation folders in a tab next to Sessions. Folder state is stored durably per Hermes profile.',
  defaultEnabled: true,
  register(ctx) {
    setPersistence(ctx)

    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'Folders',
      data: {
        placement: 'left',
        width: '260px',
        collapsible: true,
        hideOnly: true,
        dock: { pane: 'sessions', pos: 'center', enforce: true }
      },
      render: () => jsx(FoldersPane, {})
    })
  }
}
