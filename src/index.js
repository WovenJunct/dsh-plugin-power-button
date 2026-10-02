/**
 * dsh-plugin-power-button — host half.
 *
 * One job: turn one browser click into "this DSH desktop application is gone" or
 * "this DSH desktop application restarted".
 *
 * The browser half never touches processes. It calls one HTTP route with
 * `describe`, `shutdown` or `restart`, and this module decides:
 *
 *   1. `describe` reports whether the host is a desktop shell child, which pid
 *      and executable the shell owns, whether shutting down now would interrupt
 *      work, and where the helper writes its log — so the confirmation dialog can
 *      warn before anything happens.
 *   2. `shutdown`/`restart` flush the live sessions (with a deadline), arm the
 *      detached helper, and answer the browser *before* the helper terminates the
 *      shell (the helper itself waits out the response).
 *
 * The route can terminate the application, so it is fenced three ways: the
 * request must be `application/json` (which a cross-site page cannot send without
 * a preflight), a foreign web `Origin` is refused outright, and every action must
 * carry a per-boot nonce that this plugin injects into the page's HTML. A local
 * attacker could always kill the process directly, but a web page in the user's
 * browser must not be able to.
 *
 * Only public Cordis services are used: `webServer`, `agents`, `jobs`,
 * `sessions` and the `webserver/index-inject` hook. Nothing in the DSH
 * installation is modified, and no message is ever sent over the shell's IPC
 * channel: that channel's whitelist is strict and an unexpected message makes the
 * shell kill the host.
 */
import { randomUUID } from 'node:crypto'
import { appendHelperLog, classifyRuntime, helperLogPath, helperScriptExists, observeRuntime, spawnPowerHelper } from './power.js'

/** HTTP route the browser half calls. */
const ROUTE = '/plugins/dsh-plugin-power-button/power'

/** Bounded request body (a JSON envelope with one action). */
const MAX_BODY_BYTES = 16 * 1024

/** Actions the route accepts. */
const ACTIONS = new Set(['describe', 'shutdown', 'restart', 'trace'])

/** Global the injected script defines, read by the browser half. */
const TOKEN_GLOBAL = '__DSH_POWER_TOKEN__'

/**
 * How long an accepted shutdown/restart may stay unexplained before the host
 * releases the claim. The helper needs ~1.2 s of grace plus up to ~15 s of port
 * waiting, so this only fires when the helper genuinely failed.
 */
const SHUTDOWN_WATCHDOG_MS = 40_000

/** Deadline for the best-effort pre-shutdown session flush. */
const FLUSH_DEADLINE_MS = 2_000

/**
 * Whether a process id is still alive.
 * @param pid - process id to probe.
 * @returns true when the process exists (including "exists but not signallable").
 */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * Resolve one value with a deadline, so a stuck dependency cannot hold the whole
 * action open. The abandoned promise is left to settle on its own.
 * @param promise - value to await.
 * @param milliseconds - deadline.
 * @param fallback - value used when the deadline passes.
 * @returns the resolved value or the fallback.
 */
function withDeadline(promise, milliseconds, fallback) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    // Deliberately NOT unref'd: the deadline is what keeps this await alive, and an
    // unref'd timer would let the process settle the promise out from under us.
    const timer = setTimeout(() => finish(fallback), milliseconds)
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); finish(value) },
      () => { clearTimeout(timer); finish(fallback) },
    )
  })
}

/**
 * Read and parse a JSON request body.
 * @param req - Node request.
 * @returns the parsed object ({} for an empty body).
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let text = ''
    // A client that aborts mid-body never emits 'end'; without this flag the handler
    // would hold the request open for the lifetime of the process.
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      callback(value)
    }
    req.on('data', (chunk) => {
      text += chunk
      if (text.length > MAX_BODY_BYTES) {
        finish(reject, new Error('request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (text.trim() === '') {
        finish(resolve, {})
        return
      }
      try {
        const value = JSON.parse(text)
        finish(resolve, value !== null && typeof value === 'object' ? value : {})
      } catch (error) {
        finish(reject, new Error('request body is not valid JSON'))
      }
    })
    req.on('error', (error) => finish(reject, error))
    req.on('close', () => finish(reject, new Error('request closed before the body was read')))
  })
}

/**
 * Write one JSON response.
 * @param res - Node response.
 * @param status - HTTP status code.
 * @param body - JSON-serializable body.
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** @returns a message string for an unknown thrown value. */
function messageOf(error) {
  if (error === null || error === undefined) return 'unknown error'
  return error instanceof Error ? error.message : String(error)
}

/** @returns whether an origin header names the loopback interface. */
function isLoopbackOrigin(origin) {
  try {
    const url = new URL(origin)
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname === '::1'
  } catch {
    return false
  }
}

/**
 * The transport gate every request must pass.
 *
 * `application/json` is not a CORS-safelisted content type, so a cross-site page
 * cannot send it without a preflight, and a plain web page's `Origin` is refused
 * even then. The desktop renderer runs on the `dsh-app:` scheme, so its origin is
 * never a foreign `http(s)` origin and passes.
 * @param req - Node request.
 * @returns null when acceptable, otherwise the refusal reason.
 */
function transportRefusal(req) {
  const headers = req.headers ?? {}
  const contentType = String(headers['content-type'] ?? '').toLowerCase()
  if (!contentType.includes('application/json')) return 'content-type must be application/json'
  const origin = headers.origin
  if (typeof origin === 'string' && origin !== '' && /^https?:\/\//iu.test(origin) && !isLoopbackOrigin(origin)) {
    return 'cross-origin request refused'
  }
  return null
}

/**
 * Whether stopping the host now would interrupt something.
 *
 * This mirrors `hasDesktopActiveTasks` plus the armed-reminder probe in
 * `@deepseek-ai/dsh-desktop-host`, which is what the shipped quit confirmation
 * uses: a generating or tool-running agent (including subagents and turns waiting
 * for approval), a queued inbox message, a running/stopping background job, or an
 * armed scheduled reminder in a loaded session. An inspection that cannot be
 * completed reports `activeTasks: true`, because the shell's own rule is to ask
 * when the answer is unknown.
 * @param ctx - plugin context carrying `agents`, `jobs` and the activity waterfall.
 * @returns `{ activeTasks, unknown, scheduled, agents, queuedAgents, jobs }`.
 */
async function inspectWork(ctx) {
  const lookup = (name) => {
    try {
      return ctx.get(name)
    } catch {
      return undefined
    }
  }
  const unavailable = (reason) => ({
    activeTasks: true,
    unknown: true,
    reason,
    scheduled: 0,
    agents: 0,
    queuedAgents: 0,
    jobs: 0,
  })

  const agents = lookup('agents')
  const jobs = lookup('jobs')
  if (agents === undefined || jobs === undefined) return unavailable('inspection-unavailable')

  let live = []
  try {
    if (typeof agents.list === 'function') live = agents.list() ?? []
  } catch {
    return unavailable('agent-roster-failed')
  }

  const runningAgents = live.filter((agent) => agent?.status === 'running')
  const queuedAgents = live.filter((agent) => {
    const nextTurn = Array.isArray(agent?.inbox?.nextTurn) ? agent.inbox.nextTurn.length : 0
    const nextStep = Array.isArray(agent?.inbox?.nextStep) ? agent.inbox.nextStep.length : 0
    return nextTurn > 0 || nextStep > 0
  })
  let runningJobs = 0
  if (typeof jobs.list === 'function') {
    for (const agent of [undefined, ...live]) {
      try {
        const list = jobs.list(agent?.id) ?? []
        runningJobs += list.filter((job) => job?.status === 'running' || job?.status === 'stopping').length
      } catch {
        // one agent's roster that refuses must not reset the count of the others
      }
    }
  }
  const counts = {
    agents: runningAgents.length,
    queuedAgents: queuedAgents.length,
    jobs: runningJobs,
  }

  let scheduled = 0
  if (typeof ctx.waterfall === 'function') {
    try {
      for (const agent of live) {
        const entries = await ctx.waterfall('workspace/session-activity', { sessionId: agent?.id }, () => Promise.resolve([]))
        if (Array.isArray(entries)) scheduled += entries.filter((entry) => entry?.kind === 'schedule').length
      }
    } catch {
      return { ...unavailable('reminder-inspection-failed'), ...counts }
    }
  }

  return {
    activeTasks: counts.agents > 0 || counts.queuedAgents > 0 || counts.jobs > 0 || scheduled > 0,
    unknown: false,
    reason: null,
    scheduled,
    ...counts,
  }
}

/**
 * Drain buffered session appends before the process tree is torn down.
 *
 * The shell normally asks the host to shut down, and the host's own teardown
 * flushes as part of stopping. Terminating the shell is necessarily abrupt at
 * the window level, so this narrows the window in which a just-written turn
 * could still sit in a buffer. Best effort by design: a missing, unusual or stuck
 * session service must not block a shutdown the user asked for.
 * @param ctx - plugin context.
 * @returns how many live sessions were flushed.
 */
async function flushLiveSessions(ctx) {
  let sessions
  try {
    sessions = ctx.get('sessions')
  } catch {
    return 0
  }
  if (sessions === undefined || typeof sessions.flush !== 'function') return 0
  let entries = []
  try {
    if (typeof sessions.list === 'function') entries = sessions.list() ?? []
    else if (sessions.store !== undefined && typeof sessions.store.values === 'function') entries = [...sessions.store.values()]
  } catch {
    entries = []
  }
  let flushed = 0
  for (const entry of entries) {
    const session = entry?.session ?? entry
    try {
      await sessions.flush(session)
      flushed += 1
    } catch {
      // one session that refuses to flush must not stop the shutdown
    }
  }
  return flushed
}

/**
 * The service mounted behind the plugin's route. It owns one piece of state:
 * whether a shutdown/restart was already requested, so a double click cannot arm
 * two helpers.
 */
export class PowerButtonService {
  /**
   * @param ctx - plugin context carrying the injected services.
   * @param deps - `{ observe, spawnHelper, token }` seams; the real implementations
   *   are the defaults and tests inject fakes, so no process is ever touched.
   */
  constructor(ctx, deps = {}) {
    this.ctx = ctx
    /** `null` while idle, otherwise the action that was already accepted. */
    this.pending = null
    this.observe = deps.observe ?? observeRuntime
    this.spawnHelper = deps.spawnHelper ?? spawnPowerHelper
    /** Per-boot nonce; when set, every action must present it. */
    this.token = typeof deps.token === 'string' && deps.token !== '' ? deps.token : null
  }

  /** @returns whether this host can terminate/relaunch the desktop application. */
  #runtime() {
    const runtime = classifyRuntime(this.observe())
    let port = null
    try {
      const webServer = this.ctx.get?.('webServer')
      if (typeof webServer?.port === 'number' && Number.isInteger(webServer.port)) port = webServer.port
    } catch {
      port = null
    }
    return { ...runtime, port }
  }

  /** @returns the JSON-safe description the browser half renders. */
  async describe() {
    const runtime = this.#runtime()
    const work = await inspectWork(this.ctx)
    return {
      ok: true,
      supported: runtime.mode === 'desktop',
      mode: runtime.mode,
      reason: runtime.reason,
      electron: runtime.electron,
      port: runtime.port,
      pending: this.pending,
      logPath: runtime.mode === 'desktop' ? helperLogPath() : null,
      helperScript: runtime.mode === 'desktop' ? helperScriptExists() : null,
      clientBundle: this.#clientBundle(),
      ...work,
      // The whole route is nonce-gated, so this only ever reaches the page that
      // carries the injected token; the dialog shows it as evidence.
      appPid: runtime.appPid,
      appExecutable: runtime.appExecutable,
    }
  }

  /**
   * Report what the client-modules table knows about this plugin's browser half.
   *
   * This is the one question the browser cannot answer about itself: whether the
   * page was ever offered the bundle. A missing row means the manifest or the
   * `./client` export is wrong, which looks exactly like "the button does nothing"
   * from the outside, so it is worth reporting instead of guessing.
   * @returns `{ id, url, revision, path }`, or `null` when the table has no row.
   */
  #clientBundle() {
    try {
      const modules = this.ctx.get?.('clientModules')
      if (modules === undefined) return null
      const entries = modules.graph?.()?.entries ?? []
      const row = entries.find((entry) => entry?.id === 'dsh-plugin-power-button')
      if (row === undefined) return null
      return {
        id: row.id,
        url: row.url,
        revision: row.rev,
        path: typeof modules.clientPath === 'function' ? modules.clientPath(row.id) : null,
      }
    } catch {
      return null
    }
  }

  /**
   * Perform a shutdown or restart.
   * @param action - `shutdown` or `restart`.
   * @param details - `{ pid, executable }` resolved through the trusted `describe`
   *   branch, or taken live when no nonce gates the route.
   * @returns a JSON-safe outcome; `ok: true` means the helper is armed.
   */
  async act(action, details = {}) {
    if (this.pending !== null) {
      return { ok: false, error: `已经收到过一次「${this.pending === 'restart' ? '重新启动' : '关机'}」请求，正在执行。` }
    }
    // Claim synchronously: the checks below await, so a check-then-act here would let
    // two concurrent requests arm two helpers.
    this.pending = action
    const release = () => {
      if (this.pending === action) this.pending = null
    }
    try {
      const runtime = this.#runtime()
      if (runtime.mode !== 'desktop') {
        release()
        return {
          ok: false,
          mode: runtime.mode,
          error: runtime.mode === 'web'
            ? '当前 DSH 不是桌面端（没有可关闭的桌面进程），关机/重启按钮只在 DSH 桌面端可用。'
            : `当前平台不受支持：${runtime.reason}。`,
        }
      }
      const port = runtime.port ?? (Number.isInteger(details.port) ? details.port : null)
      const shellPid = runtime.appPid ?? details.pid ?? null
      const executable = runtime.appExecutable ?? details.executable ?? null
      if (port === null || shellPid === null || executable === null) {
        release()
        return { ok: false, error: '找不到 DSH 的 Web 端口或桌面进程，无法安全地判断进程是否已退出，操作已取消。' }
      }
      if (this.token !== null && helperScriptExists() !== true) {
        release()
        return { ok: false, error: '关机助手脚本缺失（helper.mjs），请在该 profile 中重新安装插件。' }
      }

      const flushed = await withDeadline(flushLiveSessions(this.ctx), FLUSH_DEADLINE_MS, 0)
      const helper = this.spawnHelper({
        appPid: shellPid,
        hostPid: process.pid,
        appExecutable: executable,
        port,
        action,
      }, {
        // The helper is started asynchronously: a missing or refused runtime arrives
        // as an event, and the button must not stay dead because of it.
        onFailure: (error) => {
          appendHelperLog(`[host] helper failed after being armed: ${messageOf(error)}`)
          release()
        },
      })
      if (helper.ok !== true) {
        appendHelperLog(`[host] helper failed to start for ${action}: ${helper.error ?? 'unknown error'}`)
        release()
        return { ok: false, error: `无法启动关机助手进程：${helper.error ?? '未知原因'}` }
      }
      this.#armWatchdog(action, shellPid, release)
      appendHelperLog(
        `[host] ${action} accepted appPid=${String(shellPid)} port=${String(port)} helperPid=${String(helper.helperPid)} flushedSessions=${String(flushed)} command=${String(helper.command)}`,
      )
      return {
        ok: true,
        action,
        accepted: true,
        appPid: shellPid,
        helperPid: helper.helperPid,
        flushedSessions: flushed,
        logPath: helper.logPath,
        note: action === 'restart'
          ? 'DSH 即将重启；窗口会先关闭，随后自动重新启动。'
          : 'DSH 即将完全关闭；窗口和托盘图标都会消失。',
      }
    } catch (error) {
      release()
      throw error
    }
  }

  /**
   * Let a refused shutdown be retried instead of wedging the button forever.
   *
   * If the shell is still alive when the watchdog fires, the helper did not do its
   * job (a blocked runtime, a refused termination, a crash after start). Nothing is
   * lost by releasing the claim: a user who really wants to quit can click again.
   * @param action - the action that was accepted.
   * @param appPid - the shell pid the helper was told to terminate.
   * @param release - releases the pending claim.
   */
  #armWatchdog(action, appPid, release) {
    const timer = setTimeout(() => {
      if (this.pending !== action) return
      if (!isAlive(appPid)) return
      appendHelperLog(`[host] ${action} did not complete within the watchdog window; the shell is still running`)
      release()
    }, SHUTDOWN_WATCHDOG_MS)
    timer.unref?.()
  }
}

/**
 * Register one exact route on the web carrier.
 *
 * Two spellings are attempted because the carrier's own table is keyed by
 * `(kind, path)` and a duplicate throws:
 *
 *  1. the plain `webServer.register(...)` call;
 *  2. the same call on `ctx.connection.operator.ctx`, which mounts the route on
 *     the connection's own Cordis scope — the surface the desktop shell's shared
 *     fetch handler consults.
 *
 * @param ctx - plugin context.
 * @param routePath - exact path to claim.
 * @param handler - full response owner.
 * @returns a disposer removing whichever registration succeeded.
 */
function registerRoute(ctx, routePath, handler) {
  const attempts = []
  let webServer
  try {
    webServer = ctx.get('webServer')
  } catch {
    webServer = undefined
  }
  if (webServer !== undefined && typeof webServer.register === 'function') {
    attempts.push(() => webServer.register({ kind: 'exact', path: routePath, handler }))
  }
  try {
    const operatorCtx = ctx.get('connection')?.operator?.ctx
    const operatorWeb = operatorCtx?.get?.('webServer')
    if (operatorWeb !== undefined && operatorWeb !== webServer && typeof operatorWeb.register === 'function') {
      attempts.push(() => operatorWeb.register({ kind: 'exact', path: routePath, handler }))
    }
  } catch {
    // No connection scope in this composition; the plain registration stands.
  }

  let lastError
  for (const attempt of attempts) {
    try {
      const dispose = attempt()
      return typeof dispose === 'function' ? dispose : () => {}
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error(`webserver: could not register "${routePath}"`)
}

/**
 * Register the route and build the service.
 * @param ctx - plugin context.
 * @param deps - `{ observe, spawnHelper, token }` seams forwarded to the service.
 * @returns `{ service, dispose }` — the mounted service and the route disposer.
 */
export function mountPowerRoute(ctx, deps = {}) {
  const service = new PowerButtonService(ctx, deps)
  const dispose = registerRoute(ctx, ROUTE, async (req, res) => {
    const refusal = transportRefusal(req)
    if (refusal !== null) {
      ctx.logger?.warn?.(`[dsh-plugin-power-button] refused ${req.method} ${ROUTE}: ${refusal}`)
      sendJson(res, 403, { ok: false, error: refusal })
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      sendJson(res, 400, { ok: false, error: messageOf(error) })
      return
    }
    // The nonce is injected into the page this plugin's browser half runs in, so a
    // cross-site caller can neither guess it nor read it.
    if (service.token !== null && body.token !== service.token) {
      ctx.logger?.warn?.('[dsh-plugin-power-button] refused a request without the page nonce')
      sendJson(res, 403, { ok: false, error: 'missing or stale page token; reload the page' })
      return
    }
    const action = typeof body.action === 'string' ? body.action : ''
    if (!ACTIONS.has(action)) {
      sendJson(res, 400, { ok: false, error: `unknown action: ${action}` })
      return
    }
    try {
      if (action === 'trace') {
        appendHelperLog(`[client] ${typeof body.message === 'string' ? body.message.slice(0, 500) : '(no message)'}`)
        sendJson(res, 200, { ok: true })
        return
      }
      if (action === 'describe') {
        sendJson(res, 200, await service.describe())
        return
      }
      const result = await service.act(action)
      sendJson(res, result.ok === true ? 200 : 409, result)
    } catch (error) {
      sendJson(res, 500, { ok: false, error: messageOf(error) })
    }
  })
  return {
    service,
    dispose: () => {
      try {
        dispose()
      } catch {
        // already withdrawn
      }
    },
  }
}

/**
 * Cordis entry: mount the power service behind its own HTTP route.
 *
 * The route is registered as soon as a web carrier is available: immediately
 * when `webServer` is already there, otherwise through `ctx.inject` the moment
 * it appears. The nonce is injected into every served index while this plugin is
 * active, using the same `webserver/index-inject` hook the client module system
 * uses for `window.__DSH_BOOT__`.
 * @param ctx - plugin context.
 */
export function apply(ctx) {
  const token = randomUUID()
  try {
    ctx.on('webserver/index-inject', (table) => {
      // The injection table is structured, not raw markup: `global` renders as
      // `<script>globalThis["<name>"] = <json></script>` in <head>, which is exactly
      // how `window.__DSH_BOOT__` reaches the page.
      table.push({ kind: 'global', name: TOKEN_GLOBAL, value: token })
    })
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-plugin-power-button] could not inject the page token: ${messageOf(error)}`)
  }

  const register = (hostCtx) => {
    let webServer
    try {
      webServer = hostCtx.get('webServer')
    } catch {
      webServer = undefined
    }
    if (webServer === undefined) {
      hostCtx.logger?.warn?.('[dsh-plugin-power-button] webServer is unavailable; the power route was not registered.')
      return
    }
    const mounted = mountPowerRoute(hostCtx, { token })
    hostCtx.logger?.info?.(`[dsh-plugin-power-button] power route registered: ${ROUTE}`)
    hostCtx.effect(() => mounted.dispose, 'dsh-plugin-power-button: routes')
  }

  let hasWebServer = false
  try {
    hasWebServer = ctx.get('webServer') !== undefined
  } catch {
    hasWebServer = false
  }
  if (hasWebServer) {
    register(ctx)
    return
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (hostCtx) => register(hostCtx))
  }
}

export { ROUTE, TOKEN_GLOBAL, flushLiveSessions, inspectWork, isAlive, transportRefusal, withDeadline }
