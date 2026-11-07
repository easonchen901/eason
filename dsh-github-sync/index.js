/**
 * @local/dsh-github-sync — sync the DeepSeek Harness workspace to a GitHub repository.
 *
 * Host plugin. Uses the system `git` binary to commit workspace changes and
 * push them to a configured GitHub repository. Three trigger modes:
 *
 *   - `auto`: watch file changes, debounce, then commit + push
 *   - `interval`: commit + push on a fixed interval
 *   - `manual`: only through the `github_sync` tool
 *
 * The GitHub token is stored in the credentials service (never in config).
 * Non-secret settings live in the plugin `config` mapping and can be changed
 * at runtime with the `github_sync_configure` tool.
 */

import { execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const CREDENTIAL_KEY = 'github-sync'
const MODES = ['auto', 'interval', 'manual']

const DEFAULTS = {
  repository: '',
  branch: 'main',
  mode: 'auto', // 'auto' | 'interval' | 'manual'
  intervalSeconds: 300,
  debounceMs: 1500,
  authorName: 'DeepSeek Harness',
  authorEmail: 'harness@deepseek.local',
  commitMessage: 'sync: workspace changes',
  sourceDirectory: '', // empty => workspace default directory
  auth: 'token', // 'token' | 'ssh'
  push: true,
}

export const inject = ['tools']

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  if (!MODES.includes(cfg.mode)) cfg.mode = 'manual'

  const logger = ctx.logger('github-sync')
  const tools = ctx.tools
  const credentials = ctx.get('credentials')

  const state = {
    syncing: false,
    lastSyncAt: null,
    lastSync: null, // { ok, changed?, message?, commit?, pushed? }
  }

  const disposers = []
  let debounceTimer = null
  let intervalTimer = null
  let watcher = null

  // ---- directory resolution ------------------------------------------------

  function sourceDir() {
    if (cfg.sourceDirectory) return cfg.sourceDirectory
    const registry = ctx.get('workspaceRegistry')
    if (registry && typeof registry.list === 'function') {
      const workspaces = registry.list()
      const first = Array.isArray(workspaces) && workspaces.length ? workspaces[0] : undefined
      if (first && typeof first.path === 'string') return first.path
    }
    return process.cwd()
  }

  // ---- git helpers -----------------------------------------------------------

  async function runGit(cwd, args) {
    try {
      const { stdout, stderr } = await execFileAsync('git', args, {
        cwd,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        env: process.env,
      })
      return { code: 0, stdout: String(stdout || ''), stderr: String(stderr || '') }
    } catch (error) {
      return {
        code: typeof error.code === 'number' ? error.code : 1,
        stdout: String(error.stdout || ''),
        stderr: String(error.stderr || error.message || ''),
      }
    }
  }

  function cleanRemoteUrl(repo) {
    let value = String(repo || '').trim()
    if (!value) return ''
    if (/^[\w.-]+\/[\w.-]+$/.test(value)) {
      value = cfg.auth === 'ssh' ? `git@github.com:${value}.git` : `https://github.com/${value}.git`
    }
    return value
  }

  function authArgs(token) {
    if (!token) return []
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
    return ['-c', `http.extraHeader=Authorization: Basic ${basic}`]
  }

  async function readToken() {
    if (cfg.auth !== 'token' || !credentials) return null
    try {
      const record = await credentials.readRecord(CREDENTIAL_KEY)
      const payload = record && record.kind === 'grant' ? record.payload : undefined
      const token = payload && typeof payload.token === 'string' ? payload.token : ''
      return token || null
    } catch (error) {
      logger.warn('failed to read GitHub token: ' + (error && error.message ? error.message : error))
      return null
    }
  }

  async function ensureRepo() {
    const cwd = sourceDir()
    await fsp.mkdir(cwd, { recursive: true })

    const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
    if (inside.code !== 0) {
      let init = await runGit(cwd, ['init', '--initial-branch', cfg.branch])
      if (init.code !== 0) {
        init = await runGit(cwd, ['init'])
        if (init.code !== 0) throw new Error('git init failed: ' + (init.stderr || init.stdout).trim())
        if (cfg.branch && cfg.branch !== 'master') {
          const checkout = await runGit(cwd, ['checkout', '-b', cfg.branch])
          if (checkout.code !== 0) throw new Error('could not create branch ' + cfg.branch + ': ' + checkout.stderr.trim())
        }
      }
    }

    const desired = cleanRemoteUrl(cfg.repository)
    if (!desired) throw new Error('GitHub repository is not configured')

    const remote = await runGit(cwd, ['remote', 'get-url', 'origin'])
    if (remote.code !== 0 || remote.stdout.trim() !== desired) {
      const args = remote.code !== 0
        ? ['remote', 'add', 'origin', desired]
        : ['remote', 'set-url', 'origin', desired]
      const result = await runGit(cwd, args)
      if (result.code !== 0) throw new Error('could not set git remote: ' + (result.stderr || result.stdout).trim())
    }

    return cwd
  }

  async function hasUnpushed(cwd) {
    const result = await runGit(cwd, ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin'])
    if (result.code !== 0) return true
    const count = parseInt((result.stdout || '').trim() || '0', 10)
    return count > 0
  }

  async function pushWithReconcile(cwd, token) {
    const auth = authArgs(token)
    // Fetch the remote branch so we can detect work the local branch does not have.
    await runGit(cwd, [...auth, 'fetch', 'origin', cfg.branch])

    const behind = await runGit(cwd, ['rev-list', '--count', `HEAD..origin/${cfg.branch}`])
    const behindCount = behind.code === 0 ? parseInt((behind.stdout || '').trim() || '0', 10) : 0
    if (behindCount > 0) {
      // Rebase local commits onto the remote; fall back to a merge for unrelated histories.
      const rebase = await runGit(cwd, ['rebase', `origin/${cfg.branch}`])
      if (rebase.code !== 0) {
        await runGit(cwd, ['rebase', '--abort'])
        const merge = await runGit(cwd, ['merge', `origin/${cfg.branch}`, '--allow-unrelated-histories', '--no-edit'])
        if (merge.code !== 0) {
          await runGit(cwd, ['merge', '--abort'])
          throw new Error('could not reconcile with remote: ' + (merge.stderr || merge.stdout).trim())
        }
      }
    }

    const push = await runGit(cwd, [...auth, 'push', '-u', 'origin', cfg.branch])
    if (push.code !== 0) throw new Error('git push failed: ' + (push.stderr || push.stdout).trim())
    return true
  }

  // ---- sync ------------------------------------------------------------------

  async function syncNow(customMessage) {
    if (state.syncing) {
      return { ok: false, changed: false, skipped: true, message: 'a sync is already in progress' }
    }
    if (!cfg.repository) {
      return {
        ok: false,
        changed: false,
        message: 'GitHub repository is not configured. Use github_sync_configure or set `repository` in the plugin config.',
      }
    }

    state.syncing = true
    try {
      const cwd = await ensureRepo()
      await runGit(cwd, ['add', '-A'])

      const staged = await runGit(cwd, ['diff', '--cached', '--quiet'])

      let committed = false
      let commitSummary = null
      if (staged.code !== 0) {
        const message = (customMessage && String(customMessage).trim()) || cfg.commitMessage || 'sync: workspace changes'
        const commit = await runGit(cwd, [
          '-c', `user.name=${cfg.authorName}`,
          '-c', `user.email=${cfg.authorEmail}`,
          'commit', '-m', message,
        ])
        if (commit.code !== 0) throw new Error('git commit failed: ' + (commit.stderr || commit.stdout).trim())
        committed = true
        commitSummary = (commit.stdout || '').trim().split('\n')[0]
      }

      let pushed = false
      if (cfg.push) {
        const shouldPush = committed || await hasUnpushed(cwd)
        if (shouldPush) {
          const token = await readToken()
          await pushWithReconcile(cwd, token)
          pushed = true
        }
      }

      state.lastSyncAt = Date.now()
      if (committed) {
        state.lastSync = { ok: true, changed: true, commit: commitSummary, pushed }
      } else if (pushed) {
        state.lastSync = { ok: true, changed: false, pushed, message: 'pushed existing commits' }
      } else {
        state.lastSync = { ok: true, changed: false, message: 'no changes to commit' }
      }
      return { ...state.lastSync }
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      state.lastSync = { ok: false, changed: false, message }
      logger.warn('sync failed: ' + message)
      return { ...state.lastSync }
    } finally {
      state.syncing = false
    }
  }

  // ---- scheduling ------------------------------------------------------------

  function clearTimers() {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null }
    if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null }
  }

  function scheduleDebounced() {
    if (state.syncing) return
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      syncNow().then((result) => {
        if (!result.ok) logger.info('auto-sync: ' + result.message)
      }).catch(() => {})
    }, Math.max(150, Number(cfg.debounceMs) || 1500))
  }

  function isGitPath(name) {
    const first = name.split(/[\\/]/)[0]
    return first === '.git'
  }

  function startPolling() {
    if (intervalTimer) return
    const tick = async () => {
      if (state.syncing) return
      try {
        const cwd = sourceDir()
        const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
        if (inside.code !== 0) return
        const status = await runGit(cwd, ['status', '--porcelain'])
        if (status.code === 0 && status.stdout.trim()) await syncNow()
      } catch { /* transient; retry next tick */ }
    }
    intervalTimer = setInterval(tick, Math.max(2000, Number(cfg.debounceMs) || 1500))
  }

  function startAuto() {
    try {
      watcher = fs.watch(sourceDir(), { recursive: true }, (_eventType, filename) => {
        if (filename && isGitPath(String(filename))) return
        scheduleDebounced()
      })
      watcher.on('error', () => {
        try { watcher.close() } catch { /* ignore */ }
        watcher = null
        startPolling()
      })
    } catch {
      startPolling()
    }
  }

  function startInterval() {
    if (intervalTimer) return
    intervalTimer = setInterval(() => {
      syncNow().catch(() => {})
    }, Math.max(1000, Number(cfg.intervalSeconds) * 1000))
  }

  if (cfg.mode === 'auto') startAuto()
  else if (cfg.mode === 'interval') startInterval()

  // ---- tools ------------------------------------------------------------------

  function textBlock(text) {
    return [{ type: 'text', text: String(text) }]
  }

  function registerTool(definition) {
    const dispose = tools.register(definition)
    disposers.push(() => dispose())
    return dispose
  }

  registerTool({
    name: 'github_sync',
    description:
      'Commit the workspace changes and push them to the configured GitHub repository immediately. ' +
      'Use this to sync work files and code to GitHub on demand. Returns a summary of the commit and push.',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Optional commit message. Defaults to the configured message.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => textBlock(describeSync(value)),
    },
    timeoutMs: 300000,
    async execute(args) {
      const result = await syncNow(args && args.message)
      return { ...result, repository: cfg.repository, branch: cfg.branch, mode: cfg.mode }
    },
  })

  registerTool({
    name: 'github_sync_status',
    description:
      'Show the GitHub sync plugin status: configured repository, branch, mode, source directory, ' +
      'whether a token is stored, last sync result, and uncommitted change count.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => textBlock(describeStatus(value)),
    },
    async execute() {
      return await collectStatus()
    },
  })

  registerTool({
    name: 'github_sync_configure',
    description:
      'Configure the GitHub sync plugin. Set the repository (owner/repo or a full URL), branch, sync mode, ' +
      'and the GitHub personal access token (stored securely in the credentials service, never in config). ' +
      'Omit a field to leave it unchanged.',
    parameters: {
      type: 'object',
      properties: {
        repository: {
          type: 'string',
          description: 'GitHub repository as owner/repo, https://github.com/owner/repo.git, or git@github.com:owner/repo.git.',
        },
        branch: { type: 'string', description: 'Branch to push to. Defaults to main.' },
        mode: {
          type: 'string',
          enum: ['auto', 'interval', 'manual'],
          description: 'Sync trigger: auto (on file change), interval (every intervalSeconds), or manual (only via github_sync).',
        },
        intervalSeconds: { type: 'integer', description: 'Interval in seconds for interval mode.' },
        debounceMs: { type: 'integer', description: 'Debounce in milliseconds for auto mode.' },
        authorName: { type: 'string', description: 'Git commit author name.' },
        authorEmail: { type: 'string', description: 'Git commit author email.' },
        commitMessage: { type: 'string', description: 'Default commit message.' },
        sourceDirectory: { type: 'string', description: 'Absolute path to sync. Defaults to the workspace directory.' },
        auth: { type: 'string', enum: ['token', 'ssh'], description: 'Authentication method: token (HTTPS personal access token) or ssh (SSH key).' },
        token: { type: 'string', description: 'GitHub personal access token. Stored securely, never written to config.' },
        push: { type: 'boolean', description: 'Whether to push after committing.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => textBlock(describeConfigure(value)),
    },
    async execute(args) {
      return await configure(args || {})
    },
  })

  // ---- status / configure helpers -------------------------------------------

  function maskUrl(url) {
    try {
      const parsed = new URL(url)
      if (parsed.username || parsed.password) {
        parsed.username = ''
        parsed.password = ''
      }
      return parsed.toString()
    } catch {
      return String(url)
    }
  }

  async function collectStatus() {
    const cwd = sourceDir()
    const git = { isRepo: false, branch: null, remote: null, dirty: null }
    try {
      const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
      if (inside.code === 0) {
        git.isRepo = true
        const branch = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
        git.branch = branch.code === 0 ? branch.stdout.trim() : null
        const remote = await runGit(cwd, ['remote', 'get-url', 'origin'])
        git.remote = remote.code === 0 ? maskUrl(remote.stdout.trim()) : null
        const dirty = await runGit(cwd, ['status', '--porcelain'])
        git.dirty = dirty.code === 0 ? dirty.stdout.trim().split('\n').filter(Boolean).length : null
      }
    } catch { /* keep defaults */ }

    let tokenConfigured = false
    if (credentials) {
      try {
        const record = await credentials.readRecord(CREDENTIAL_KEY)
        const payload = record && record.kind === 'grant' ? record.payload : undefined
        tokenConfigured = !!(payload && typeof payload.token === 'string' && payload.token)
      } catch { /* keep false */ }
    }

    return {
      configured: !!(cfg.repository && String(cfg.repository).trim()),
      repository: cfg.repository ? cleanRemoteUrl(cfg.repository) : '',
      branch: cfg.branch,
      mode: cfg.mode,
      auth: cfg.auth,
      push: !!cfg.push,
      sourceDirectory: cwd,
      tokenConfigured,
      git,
      lastSync: state.lastSync,
      lastSyncAt: state.lastSyncAt,
    }
  }

  const CONFIG_FIELDS = [
    'repository', 'branch', 'mode', 'intervalSeconds', 'debounceMs',
    'authorName', 'authorEmail', 'commitMessage', 'sourceDirectory', 'auth', 'push',
  ]

  async function configure(args) {
    let tokenStored = false

    const tokenValue = args.token
    if (tokenValue !== undefined && tokenValue !== null && String(tokenValue) !== '') {
      if (!credentials) {
        return { ok: false, message: 'credentials service is unavailable; cannot store the token' }
      }
      await credentials.modifyRecord(CREDENTIAL_KEY, async () => ({
        kind: 'grant',
        payload: { token: String(tokenValue), configuredAt: Date.now() },
      }))
      tokenStored = true
    }

    const changes = {}
    for (const field of CONFIG_FIELDS) {
      if (args[field] !== undefined) changes[field] = args[field]
    }

    // Apply immediately for this session.
    Object.assign(cfg, changes)
    if (changes.mode !== undefined && !MODES.includes(changes.mode)) changes.mode = cfg.mode = 'manual'

    let persisted = false
    let persistError = null
    if (Object.keys(changes).length) {
      const editor = ctx.get('configEditor')
      const entry = ctx.fiber && ctx.fiber.entry
      if (editor && entry) {
        try {
          await editor.edit(entry, (current) => ({ ...(current || {}), ...changes }))
          persisted = true
        } catch (error) {
          persistError = error && error.message ? error.message : String(error)
        }
      } else {
        persistError = 'config editor is unavailable in this profile'
      }
    }

    const status = await collectStatus()
    return {
      ok: true,
      tokenStored,
      persisted,
      persistError,
      changes,
      status,
    }
  }

  // ---- render helpers ---------------------------------------------------------

  function describeSync(value) {
    if (!value) return 'No result'
    if (value.skipped) return value.message
    if (!value.ok) return 'GitHub sync failed: ' + (value.message || 'unknown error')
    if (!value.changed) {
      return value.pushed ? 'GitHub sync: pushed existing commits' : 'GitHub sync: no changes to commit'
    }
    return 'GitHub sync done: ' + (value.commit || 'committed') +
      (value.pushed ? ' (pushed to origin/' + cfg.branch + ')' : ' (commit created, push disabled)')
  }

  function describeStatus(value) {
    const lines = ['GitHub sync status']
    lines.push('  repository: ' + (value.repository || '(not set)'))
    lines.push('  branch: ' + value.branch)
    lines.push('  mode: ' + value.mode)
    lines.push('  auth: ' + value.auth + (value.tokenConfigured ? ' (token configured)' : ' (no token stored)'))
    lines.push('  push: ' + (value.push ? 'on' : 'off'))
    lines.push('  source directory: ' + value.sourceDirectory)
    if (value.git && value.git.isRepo) {
      lines.push('  git branch: ' + (value.git.branch || '(unknown)'))
      lines.push('  git remote: ' + (value.git.remote || '(none)'))
      lines.push('  uncommitted files: ' + (value.git.dirty === null ? '(unknown)' : value.git.dirty))
    } else {
      lines.push('  git: not a repository yet')
    }
    if (value.lastSync) {
      lines.push('  last sync: ' + (value.lastSync.ok ? 'ok' : 'failed') +
        (value.lastSync.message ? ' — ' + value.lastSync.message : ''))
    }
    return lines.join('\n')
  }

  function describeConfigure(value) {
    if (!value.ok) return 'github_sync_configure: ' + value.message
    const parts = []
    if (value.tokenStored) parts.push('token stored')
    if (value.persisted) parts.push('config saved')
    else if (value.persistError) parts.push('config not persisted: ' + value.persistError)
    if (value.changes && Object.keys(value.changes).length) {
      parts.push('changed: ' + Object.keys(value.changes).join(', '))
    }
    return 'github_sync_configure ok' + (parts.length ? ' (' + parts.join('; ') + ')' : '')
  }

  // ---- cleanup ----------------------------------------------------------------

  return () => {
    clearTimers()
    if (watcher) {
      try { watcher.close() } catch { /* ignore */ }
      watcher = null
    }
    for (const dispose of disposers) {
      try { dispose() } catch { /* ignore */ }
    }
  }
}
