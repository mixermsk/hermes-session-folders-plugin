import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const pluginPath = new URL('../plugin.js', import.meta.url)

function syntheticModule(context, exports) {
  return new vm.SyntheticModule(
    Object.keys(exports),
    function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value)
    },
    { context }
  )
}

async function loadPlugin({ api }) {
  const context = vm.createContext({
    URLSearchParams,
    console,
    window: { hermesDesktop: { api } }
  })
  const sdkExports = Object.fromEntries(
    [
      'Button', 'Codicon', 'ConfirmDialog', 'ContextMenu', 'ContextMenuContent',
      'ContextMenuItem', 'ContextMenuSeparator', 'ContextMenuTrigger', 'GlyphSpinner',
      'Input', 'ScrollArea', 'SearchField', 'Tip', 'cn', 'haptic', 'queryClient',
      'relativeTime', 'useQuery', 'useValue'
    ].map(name => [name, () => null])
  )
  sdkExports.host = {}
  const reactExports = Object.fromEntries(
    ['useCallback', 'useEffect', 'useMemo', 'useRef', 'useState'].map(name => [name, () => null])
  )
  const jsxExports = { jsx: () => null, jsxs: () => null }
  const source = await readFile(pluginPath, 'utf8')
  const plugin = new vm.SourceTextModule(source, { context, identifier: pluginPath.pathname })

  await plugin.link(specifier => {
    if (specifier === '@hermes/plugin-sdk') return syntheticModule(context, sdkExports)
    if (specifier === 'react') return syntheticModule(context, reactExports)
    if (specifier === 'react/jsx-runtime') return syntheticModule(context, jsxExports)
    throw new Error(`Unexpected import: ${specifier}`)
  })
  await plugin.evaluate()
  return plugin.namespace
}

test('fetchSessions uses the server FTS endpoint for a search query', async () => {
  const calls = []
  const plugin = await loadPlugin({
    api: async request => {
      calls.push(request)
      return {
        results: [
          {
            id: 'session-ormatek',
            title: 'Подобрать матрас',
            snippet: '…<b>Ormatek</b> Orto Premium…',
            started_at: 1,
            last_active: 2,
            message_count: 3,
            source: 'acp'
          }
        ]
      }
    }
  })

  assert.equal(typeof plugin.fetchSessions, 'function')
  const sessions = await plugin.fetchSessions('default', 'local', 'Ormatek')

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    {
      path: '/api/sessions/search?q=Ormatek&limit=20&profile=default',
      connectionId: 'local'
    }
  ])
  assert.deepEqual(JSON.parse(JSON.stringify(sessions)), [
    {
      id: 'session-ormatek',
      title: 'Подобрать матрас',
      preview: '…<b>Ormatek</b> Orto Premium…',
      started_at: 1,
      last_active: 2,
      message_count: 3,
      source: 'acp'
    }
  ])
})

test('workspace rules auto-file only unfiled sessions and preserve manual moves', async () => {
  const plugin = await loadPlugin({ api: async () => ({ results: [] }) })
  const state = {
    folders: [{ id: 'f_manual', name: 'Manual', createdAt: 1, order: 0 }],
    membership: { 'manual-repo-chat': 'f_manual' },
    expanded: {}
  }
  const sessions = [
    { id: 'repo-chat', workspace: '/Users/mixermsk/repos/example' },
    { id: 'manual-repo-chat', workspace: '/Users/mixermsk/repos/example' },
    { id: 'elsewhere', workspace: '/tmp/example' }
  ]
  const rules = [{ workspace_prefix: '/Users/mixermsk/repos/', folder: 'Repos' }]

  const actual = plugin.applyAutoFileRules(state, sessions, rules)

  assert.deepEqual(JSON.parse(JSON.stringify(actual)), {
    folders: [
      { id: 'f_manual', name: 'Manual', createdAt: 1, order: 0 },
      { id: 'f_auto_repos', name: 'Repos', createdAt: 0, order: 1 }
    ],
    membership: {
      'repo-chat': 'f_auto_repos',
      'manual-repo-chat': 'f_manual'
    },
    expanded: { f_auto_repos: true }
  })
})
