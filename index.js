/**
 * no-sleep, Host half.
 *
 * Keeps Windows awake for as long as this Harness runs. The request is
 * `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED [| ES_DISPLAY_REQUIRED])`
 * held inside one small helper process started with PowerShell's Add-Type. It
 * lives on the helper's own thread, and Windows drops the request with that
 * process, so stopping is one `kill` and a Harness exit (even a crash) can never
 * leave the machine held awake.
 *
 * Why a helper process instead of an in-process call: the Host loads plugin rows
 * inside its own cordis runner, which hands a plugin Harness APIs only — no
 * Electron or process-level native bridge — and the Desktop loads no native
 * Node addon. A child process is the one native surface a Host plugin does have.
 *
 * Surfaces:
 *   GET  /no-sleep/api  -> status JSON
 *   POST /no-sleep/api  -> { enabled?, mode? }, saved and applied
 *
 * The preference lives in the profile directory (no-sleep.json): it belongs to
 * the application, not to a session. The patch row's `config` seeds the first run.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Route path and preference file owned by this plugin. */
const ROUTE = '/no-sleep/api'
const STATE_FILE = 'no-sleep.json'

/** Loopback-only: this route changes host power state. */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

const MODES = new Set(['display', 'system'])
const WAKE_SOURCES = new Set(['process', 'window'])

/** A spawn that shows no pid within this window counts as failed. */
const START_WATCHDOG_MS = 15_000
const SUPERVISE_MS = 30_000

/** Windows PowerShell 5.1, the one every Windows install carries. */
const WINDOWS_POWERSHELL = join(
  process.env.WINDIR || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)

export const name = 'no-sleep'

/** The browser route is served by the Host's web server; nothing else is needed. */
export const inject = ['webServer']

export function apply(ctx, config = {}) {
  const keepAwake = new KeepAwake({
    enabled: config.enabled !== false,
    mode: MODES.has(config.mode) ? config.mode : 'display',
    wakeSource: WAKE_SOURCES.has(config.wakeSource) ? config.wakeSource : 'process',
  }, (message) => ctx.logger?.warn?.(`no-sleep: ${message}`))

  if (process.platform !== 'win32') {
    keepAwake.platformError = `this host is ${process.platform}; only Windows is supported`
    ctx.logger?.info?.(`no-sleep: ${keepAwake.platformError}`)
  }

  ctx.effect(() => {
    keepAwake.start()
    return () => keepAwake.stop()
  }, 'no-sleep: keep-awake hold')

  const webServer = ctx.webServer ?? ctx.get?.('webServer')
  if (!webServer) {
    ctx.logger?.warn?.('no-sleep: no web server in this profile; the settings row has no endpoint')
    return
  }
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: (req, res) => keepAwake.handle(req, res),
  }), 'no-sleep: settings route')
}

/**
 * The PowerShell program the helper runs. It compiles the pinvoke, starts a
 * background thread that holds the request on its own thread (the state is
 * per-thread and per-process), and then blocks the main thread forever so the
 * process cannot exit while the hold is wanted.
 */
function holderScript(flags) {
  return [
    '$source = @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'using System.Threading;',
    'public static class DshNoSleep {',
    '  [DllImport("kernel32.dll", SetLastError = true)]',
    '  public static extern uint SetThreadExecutionState(uint flags);',
    '  public static void Hold(uint flags) {',
    '    var thread = new Thread(() => {',
    '      SetThreadExecutionState(0x80000000u | flags);',
    '      Thread.Sleep(Timeout.Infinite);',
    '    });',
    '    thread.IsBackground = true;',
    '    thread.Start();',
    '    Thread.Sleep(Timeout.Infinite);',
    '  }',
    '}',
    '"@',
    'Add-Type -TypeDefinition $source',
    `[void][DshNoSleep]::Hold(${flags})`,
  ].join('\n')
}

/** One process-wide holder: preference file, helper process and HTTP surface. */
class KeepAwake {
  constructor(defaults, warn) {
    this.settings = { ...defaults }
    this.warn = warn
    this.loaded = false
    this.platformError = ''
    this.proc = null
    this.procStartedAt = 0
    this.procMode = ''
    this.stderrTail = ''
    this.error = ''
    this.startedAt = Date.now()
    this.timer = null
    this.active = false
  }

  // ---- lifecycle -----------------------------------------------------

  start() {
    this.active = true
    void this.boot()
  }

  stop() {
    this.active = false
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.release()
  }

  async boot() {
    try {
      await this.loadState()
      if (!this.active) return
      this.apply()
      // Supervisor: restarts a helper that died, and retries a build that was
      // missing at first. It never stops a healthy holder in between.
      this.timer = setInterval(() => {
        if (this.active) this.apply()
      }, SUPERVISE_MS)
      if (typeof this.timer.unref === 'function') this.timer.unref()
    } catch (error) {
      this.error = describe(error)
    }
  }

  // ---- preference ----------------------------------------------------

  /**
   * Where the preference lives. The Host's own environment does not carry
   * `DSH_PROFILE`, so it is never read from a session; a linked path may instead
   * name the profile directory of this process, which comes from the Host's argv.
   */
  get statePath() {
    const dir = activeProfileDir()
    const base = dir !== '' ? dir : join(homedir(), '.dsh', 'profiles', 'default')
    return join(base, STATE_FILE)
  }

  async loadState() {
    if (this.loaded) return
    this.loaded = true
    try {
      const stored = JSON.parse(await readFile(this.statePath, 'utf8'))
      this.settings = normalizeSettings(stored, this.settings)
    } catch {
      // First run, or an unreadable file: the patch config seeds the settings.
    }
  }

  async saveState(patch) {
    const next = normalizeSettings({ ...this.settings, ...patch }, this.settings)
    this.settings = next
    try {
      await mkdir(dirname(this.statePath), { recursive: true })
      const temp = `${this.statePath}.${process.pid}.tmp`
      await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      await rename(temp, this.statePath)
    } catch (error) {
      this.error = `could not save the preference: ${describe(error)}`
      throw error
    }
    return next
  }

  // ---- helper process ------------------------------------------------

  /** The helper in the wanted state: running, or not running at all. */
  apply() {
    if (this.platformError !== '' || !this.settings.enabled) {
      this.release()
      return
    }
    if (this.proc !== null) {
      const lifetime = Date.now() - this.procStartedAt
      // A helper spawned ages ago without ever yielding a pid is a stall.
      if (this.proc.pid === undefined && lifetime > START_WATCHDOG_MS) {
        this.fail('the helper process did not start')
        this.release()
      } else if (this.proc.pid !== undefined && this.procMode !== this.settings.mode) {
        // The mode changed: the thread's flags are fixed for its lifetime, so
        // this is the one case that replaces a running holder.
        this.release()
        this.spawnHelper()
      }
      return
    }
    this.spawnHelper()
  }

  release() {
    const proc = this.proc
    this.proc = null
    this.procMode = ''
    if (proc === null) return
    try {
      proc.kill()
    } catch {
      // Already gone: the OS released the request with the process.
    }
  }

  spawnHelper() {
    if (!existsSync(WINDOWS_POWERSHELL)) {
      this.fail(`Windows PowerShell not found at ${WINDOWS_POWERSHELL}`)
      return
    }
    const flags = this.settings.mode === 'display' ? 3 : 1
    let proc
    try {
      proc = spawn(
        WINDOWS_POWERSHELL,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', holderScript(flags)],
        {
          cwd: dirname(WINDOWS_POWERSHELL),
          // A console window must never flash on screen for this.
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      )
    } catch (error) {
      this.fail(`could not start the helper: ${describe(error)}`)
      return
    }
    this.proc = proc
    this.procStartedAt = Date.now()
    this.procMode = this.settings.mode
    this.stderrTail = ''
    this.error = ''
    proc.stderr?.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-2048)
    })
    proc.on('error', (error) => {
      if (this.proc !== proc) return
      this.fail(`the helper failed: ${describe(error)}`)
      this.release()
    })
    proc.on('exit', (code, signal) => {
      if (this.proc !== proc) return
      const tail = this.stderrTail.trim()
      this.fail(tail !== '' ? tail.slice(-500) : `the helper exited (${signal ?? String(code)})`)
      this.release()
    })
  }

  fail(message) {
    this.error = message
    this.warn(message)
  }

  // ---- HTTP ----------------------------------------------------------

  async handle(req, res) {
    const remote = req.socket?.remoteAddress ?? ''
    if (!LOOPBACK.has(remote)) {
      return sendJson(res, 403, { ok: false, error: 'loopback clients only' })
    }
    try {
      if (req.method === 'GET') {
        return sendJson(res, 200, this.snapshot())
      }
      if (req.method !== 'POST') {
        return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      }
      const body = await readJson(req)
      const patch = {}
      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
      if (MODES.has(body.mode)) patch.mode = body.mode
      if (WAKE_SOURCES.has(body.wakeSource)) patch.wakeSource = body.wakeSource
      await this.saveState(patch)
      // A successful save clears a previous failure: the answer describes the
      // request that was just applied, not an older one.
      this.error = ''
      this.apply()
      return sendJson(res, 200, this.snapshot())
    } catch (error) {
      this.error = describe(error)
      return sendJson(res, 400, { ok: false, error: this.error, status: this.snapshot() })
    }
  }

  snapshot() {
    const holding = this.proc !== null && this.settings.enabled && this.platformError === ''
    return {
      ok: true,
      platform: process.platform,
      supported: this.platformError === '',
      settings: { ...this.settings },
      hold: {
        enabled: this.settings.enabled,
        holding,
        mode: holding ? this.procMode : 'none',
        // What Windows is asked for vs. what this Host can verify: the helper
        // process is alive with the requested flags. Anything beyond that (a
        // power policy, an idle or active-lock screen) is outside its reach.
        confirmed: holding && this.proc !== null && this.proc.pid !== undefined,
        processId: this.proc === null ? null : this.proc.pid ?? null,
        startedAt: this.proc === null ? null : this.procStartedAt,
      },
      uptimeMs: Date.now() - this.startedAt,
      error: this.error === '' ? null : this.error,
    }
  }
}

/** The profile directory this Host serves, from its argv, or "" when unknown. */
function activeProfileDir() {
  // The Desktop announces it as the second argument of "<app.asar>/…/index.js"
  // followed by the dsh root, the profile directory, and the runtime.
  const argv = process.argv
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (typeof value !== 'string' || value === '') continue
    if (argv[index - 2] === undefined || argv[index - 1] === undefined) continue
    if (!/index\.js$/i.test(argv[index - 2])) continue
    if (!/app\.asar/i.test(argv[index - 2])) continue
    return value
  }
  return ''
}

function normalizeSettings(input, fallback) {
  const next = { ...fallback }
  if (input !== null && typeof input === 'object') {
    if (typeof input.enabled === 'boolean') next.enabled = input.enabled
    if (MODES.has(input.mode)) next.mode = input.mode
    if (WAKE_SOURCES.has(input.wakeSource)) next.wakeSource = input.wakeSource
  }
  return next
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 16 * 1024) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  return parsed !== null && typeof parsed === 'object' ? parsed : {}
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function describe(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
