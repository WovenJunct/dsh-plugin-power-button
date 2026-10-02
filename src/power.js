/**
 * dsh-plugin-power-button — desktop process control.
 *
 * Why this module has to exist at all
 * -----------------------------------
 * The DSH desktop application is two processes: the Electron shell (the app you
 * see, its window, and its tray icon) and a Node "host" child that owns the
 * Cordis profile, the web server and every plugin. Plugin host halves run in that
 * child, so a plugin has no `electron` module and no `app.quit()`.
 *
 * There is also no supported request for it. The shell's IPC contract with the
 * host child is a closed whitelist and is *strict*: `DesktopHostProcess` answers
 * any unknown child message by failing the host and killing it, and the only
 * message types the shell accepts are `ready`, `platform-session`,
 * `shutdown-complete`, `fatal`, `update-tasks` and `quit-inspection`. The
 * renderer preload exposes no quit channel either. Closing the main window is not
 * an option: on Windows the shell turns a window close into "hide to tray", which
 * is exactly what this plugin must not do.
 *
 * So the only lever a plugin owns is process ownership: the host child is spawned
 * directly by the Electron shell (`spawn(process.execPath, ..., { stdio: [...,
 * 'ipc'] })`), so `process.ppid` is the shell's pid and `process.execPath` is the
 * shell's executable. On request this module starts the detached helper in
 * `helper.mjs` — spawned with the same Electron executable in Node mode, which is
 * how the shell itself starts the host — and the helper terminates the shell. The
 * shell's death closes the IPC channel, which is what makes the host child shut
 * *itself* down gracefully (`process.once('disconnect', stop)` in
 * `dsh-desktop-host`), so the backend still tears down in an orderly way and the
 * helper only force-kills the host when the port never comes back.
 *
 * Everything here is pure enough to unit-test: detection, argument building and
 * encoding take their inputs as arguments, and only {@link spawnPowerHelper}
 * touches the real process table.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Filename of the helper's own diagnostic log, inside the DSH home directory. */
export const HELPER_LOG_NAME = 'dsh-plugin-power-button.log'

/**
 * Read the live runtime facts this plugin needs.
 *
 * `ELECTRON_RUN_AS_NODE` is set by the desktop shell on the host child (see
 * `desktopNodeEnvironment`), and the child is created with an IPC channel, so
 * the trio "run-as-node + connected IPC + a parent pid" identifies the desktop
 * host precisely. A `dsh web` booted from a terminal has no IPC channel.
 * @returns {object} observation consumable by {@link classifyRuntime}.
 */
export function observeRuntime() {
  return {
    platform: process.platform,
    electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE === '1',
    connected: process.connected === true && typeof process.send === 'function',
    parentPid: process.ppid,
    execPath: process.execPath,
    version: process.versions.electron ?? null,
  }
}

/**
 * Decide which application this host belongs to, without touching anything.
 * @param observation - result of {@link observeRuntime} (or a test double).
 * @returns `{ mode, appPid, appExecutable, reason }` where `mode` is `desktop`
 *   when the full shutdown/restart capability is available, `web` for a
 *   headless/terminal boot (no shell to terminate), or `unsupported` elsewhere.
 */
export function classifyRuntime(observation) {
  const { platform, electronRunAsNode, connected, parentPid, execPath, version } = observation ?? {}
  if (platform !== 'win32') {
    return { mode: 'unsupported', reason: `platform:${String(platform)}`, appPid: null, appExecutable: null, electron: version ?? null }
  }
  if (electronRunAsNode !== true || connected !== true) {
    return { mode: 'web', reason: 'no-desktop-ipc', appPid: null, appExecutable: null, electron: null }
  }
  if (!Number.isInteger(parentPid) || parentPid <= 0) {
    return { mode: 'web', reason: 'no-parent', appPid: null, appExecutable: null, electron: version ?? null }
  }
  if (typeof execPath !== 'string' || execPath.trim() === '') {
    return { mode: 'unsupported', reason: 'no-executable', appPid: null, appExecutable: null, electron: version ?? null }
  }
  return { mode: 'desktop', reason: 'electron-ipc-child', appPid: parentPid, appExecutable: execPath, electron: version ?? null }
}

/** @returns the DSH home directory, matching the persistence backends' rule. */
export function dshHome(env = process.env, home = homedir()) {
  const configured = env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return path.resolve(configured.trim())
  return path.join(home, '.dsh')
}

/** @returns absolute path of the helper's diagnostic log. */
export function helperLogPath(env = process.env, home = homedir()) {
  return path.join(dshHome(env, home), HELPER_LOG_NAME)
}

/** @returns absolute path of the detached helper script. */
export function helperScriptPath(from = import.meta.url) {
  return fileURLToPath(new URL('./helper.mjs', from))
}

/** @returns a length-bounded positive integer, or throws. */
function requireInteger(value, label, min, max) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${label} must be an integer in [${String(min)}, ${String(max)}], got ${String(value)}`)
  }
  return number
}

/**
 * Build the detached helper's argv.
 * @param options - `{ appPid, hostPid, appExecutable, port, action, logPath }`.
 * @returns argv entries after the executable path.
 */
export function buildHelperArgs(options) {
  const appPid = requireInteger(options?.appPid, 'appPid', 1, 0x7fffffff)
  const hostPid = requireInteger(options?.hostPid, 'hostPid', 1, 0x7fffffff)
  const port = requireInteger(options?.port, 'port', 1, 65535)
  const action = options?.action === 'restart' ? 'restart' : 'shutdown'
  const executable = options?.appExecutable
  if (typeof executable !== 'string' || executable.trim() === '') throw new Error('appExecutable must be a non-empty path')
  const logPath = typeof options?.logPath === 'string' && options.logPath !== '' ? options.logPath : helperLogPath()
  return [
    helperScriptPath(options?.scriptUrl),
    '--shell-pid', String(appPid),
    '--host-pid', String(hostPid),
    '--port', String(port),
    '--executable', executable,
    '--action', action,
    '--log', logPath,
  ]
}

/**
 * Start the detached helper and return immediately.
 *
 * `detached: true` plus `unref()` is load-bearing: the helper is a descendant of
 * the process it is about to terminate, so it must outlive both that process and
 * this host. `stdio: 'ignore'` keeps it from holding a pipe to a dying parent, and
 * `ELECTRON_RUN_AS_NODE=1` turns the Electron executable into the Node runtime the
 * helper is written for — the same trick the desktop shell uses to start the host.
 * @param options - `{ appPid, hostPid, appExecutable, port, action, logPath }`.
 * @param deps - `{ spawn, env, home, execPath, onFailure }` injection points.
 *   `onFailure` is called when the helper cannot be started or dies immediately,
 *   which is the only way the caller can learn about an asynchronous spawn failure.
 * @returns `{ ok, helperPid, command, logPath, action }` (never throws; a failure
 *   to start is reported as `ok: false` with a reason).
 */
export function spawnPowerHelper(options, deps = {}) {
  const launch = deps.spawn ?? spawn
  const env = deps.env ?? process.env
  const home = deps.home ?? homedir()
  const execPath = deps.execPath ?? process.execPath
  const logPath = options?.logPath ?? helperLogPath(env, home)
  const action = options?.action === 'restart' ? 'restart' : 'shutdown'
  try {
    const args = buildHelperArgs({
      ...options,
      hostPid: options?.hostPid ?? process.pid,
      logPath,
    })
    const child = launch(execPath, args, {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...env, ELECTRON_RUN_AS_NODE: '1', DSH_POWER_HELPER_RUN: '1' },
    })
    // A missing executable does not throw at spawn time; it arrives as an async
    // 'error' event, and an unhandled one would take the whole DSH host down.
    child.on?.('error', (error) => {
      const message = error instanceof Error ? error.message : String(error)
      appendHelperLog(`[host] helper process failed to run: ${message}`, env, home)
      try {
        deps.onFailure?.(error)
      } catch {
        // the caller's failure hook must never re-break the host
      }
    })
    child.unref?.()
    return {
      ok: true,
      helperPid: typeof child.pid === 'number' ? child.pid : null,
      command: `${execPath} ${args[0] ?? ''}`,
      logPath,
      action,
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      logPath,
      action,
    }
  }
}

/**
 * Append one line to the helper log, creating the directory when needed.
 * Diagnostics must never be the reason an action fails.
 * @param line - text to record.
 * @returns true when the line was written.
 */
export function appendHelperLog(line, env = process.env, home = homedir()) {
  try {
    const file = helperLogPath(env, home)
    mkdirSync(path.dirname(file), { recursive: true })
    appendFileSync(file, `${new Date().toISOString()}  ${String(line)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * Read the tail of the helper log for the settings/verification surface.
 * @param maxBytes - how much of the file to read from the end.
 * @returns the tail text, or an empty string when the log does not exist.
 */
export function readHelperLogTail(maxBytes = 8192, env = process.env, home = homedir()) {
  try {
    const file = helperLogPath(env, home)
    const text = readFileSync(file, 'utf8')
    return text.length <= maxBytes ? text : text.slice(text.length - maxBytes)
  } catch {
    return ''
  }
}

/** @returns whether the helper script is present (a deployment sanity check). */
export function helperScriptExists(scriptPath = helperScriptPath()) {
  try {
    return existsSync(scriptPath)
  } catch {
    return false
  }
}
