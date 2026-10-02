/**
 * dsh-plugin-power-button — detached shutdown/restart helper.
 *
 * This file is never imported by the plugin's host half; the host spawns it as a
 * separate, detached process with the same Electron executable in Node mode
 * (`ELECTRON_RUN_AS_NODE=1`), which is exactly how the desktop shell spawns the
 * host itself. It has to be a separate process because the process it terminates
 * is its ancestor: a helper that shares the host's fate could not restart anything.
 *
 * Why Node instead of PowerShell
 * ------------------------------
 * The first implementation generated an encoded PowerShell program
 * (`powershell -ExecutionPolicy Bypass -EncodedCommand <base64>`). That is a
 * textbook malware signature and endpoint protection is entitled to block it,
 * which would turn "shut down" into "nothing happens, forever". Everything the
 * helper actually needs — terminate a process, probe a loopback port, start a
 * program — is a Node builtin, so the mechanism is now one readable script with
 * no interpreter policy, no console window, and no encoded payload.
 *
 * What it does, in order:
 *   1. wait out the response grace period, so the browser's POST has landed;
 *   2. terminate the Electron shell (a window close would only hide to the tray);
 *   3. wait for the web port to be released — the shell's death closes the host
 *      child's IPC channel, which is what makes the host shut *itself* down
 *      gracefully, so this normally succeeds without any force;
 *   4. only if the port never frees, terminate the host child as well;
 *   5. on restart, wait for the port to be free and start the shell again, then
 *      verify that the new instance actually came up by watching the port return.
 *
 * Every step is guarded and logged; a step that cannot be completed is reported as
 * `FAILED` in the log rather than silently skipped, and `runHelper` never throws.
 */
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'

/** Milliseconds the helper waits before terminating anything. */
const RESPONSE_GRACE_MS = 1200
/** How long to wait for the port to be released after killing the shell. */
const PORT_RELEASE_MS = 15_000
/** How long to wait for the port to come back after a relaunch. DSH boots in 10-30 s. */
const RELAUNCH_VERIFY_MS = 45_000
/** Second chance budget when the direct launch died at once. */
const RELAUNCH_FALLBACK_MS = 30_000
/** Poll interval for every wait. */
const POLL_MS = 250

/**
 * Parse the helper's argv.
 * @param argv - `process.argv.slice(2)`.
 * @returns the validated options.
 */
export function parseHelperArgs(argv) {
  const flags = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (typeof token !== 'string' || !token.startsWith('--')) continue
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      flags.set(token.slice(2), 'true')
      continue
    }
    flags.set(token.slice(2), next)
    index += 1
  }
  const integer = (name, min, max) => {
    const value = Number(flags.get(name))
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`helper: --${name} must be an integer in [${String(min)}, ${String(max)}], got ${String(flags.get(name))}`)
    }
    return value
  }
  const action = flags.get('action') === 'restart' ? 'restart' : 'shutdown'
  return {
    shellPid: integer('shell-pid', 1, 0x7fffffff),
    hostPid: integer('host-pid', 1, 0x7fffffff),
    port: integer('port', 1, 65535),
    executable: String(flags.get('executable') ?? ''),
    logPath: String(flags.get('log') ?? ''),
    action,
  }
}

/** @returns whether a process id currently exists. */
export function isAlive(pid, kill = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** @returns a promise resolving after `ms` milliseconds. */
function delay(ms) {
  // Deliberately NOT unref'd: this helper's whole job is to wait, and an unref'd
  // timer would let the process exit between two port probes while nothing else
  // keeps the event loop alive.
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Probe a loopback port.
 * @param port - port to probe.
 * @param timeoutMs - connect timeout.
 * @returns true when something is listening.
 */
export function probePort(port, timeoutMs = 300) {
  return new Promise((resolve) => {
    let settled = false
    const socket = net.connect({ host: '127.0.0.1', port })
    const finish = (busy) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(busy)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/**
 * Wait for the port to reach a desired state.
 * @param port - port to watch.
 * @param want - `true` to wait until it is listening, `false` until it is free.
 * @param budgetMs - total time to spend.
 * @param deps - `{ probe, sleep }` injection points.
 * @returns true when the desired state was observed.
 */
export async function waitForPort(port, want, budgetMs, deps = {}) {
  const probe = deps.probe ?? probePort
  const sleep = deps.sleep ?? delay
  const attempts = Math.ceil(budgetMs / POLL_MS)
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await probe(port) === want) return true
    await sleep(POLL_MS)
  }
  return false
}

/**
 * Environment for the relaunched application.
 *
 * This is the bug that made "restart" close DSH and never bring it back: the
 * helper itself runs as Node, which the desktop shell expresses as
 * `ELECTRON_RUN_AS_NODE=1`, and a plain `spawn` hands that variable to the app.
 * The executable then starts in **Node mode**, finds no script, and exits in about
 * 60 ms — no window, no web port, no error. Stripping the marker (and the helper's
 * own flag) is what makes the relaunched process an application again.
 * @param env - environment to sanitise.
 * @returns a copy without the Node-mode markers.
 */
export function buildRelaunchEnv(env) {
  const next = { ...env }
  delete next.ELECTRON_RUN_AS_NODE
  delete next.DSH_POWER_HELPER_RUN
  return next
}

/**
 * Start the application with a clean environment.
 *
 * The returned handle reports whether the process died immediately, which is the
 * only reliable signal that the launch was wrong: a Node-mode or
 * single-instance-blocked start exits in well under a second, while a real boot
 * stays alive and takes 10-30 s to listen.
 * @param executable - application to start.
 * @param deps - `{ spawn, env }` injection points.
 * @returns `{ pid, exited }` where `exited()` is `null` while it is still running.
 */
export function launchApplication(executable, deps = {}) {
  const launch = deps.spawn ?? spawn
  const child = launch(executable, [], {
    detached: true,
    stdio: 'ignore',
    // A double-click starts the app in its own directory; match that rather than
    // leaving it in this helper's working directory.
    cwd: deps.cwd ?? path.dirname(executable),
    env: buildRelaunchEnv(deps.env ?? process.env),
  })
  let exit = null
  child.once?.('exit', (code) => { exit = code ?? 0 })
  child.once?.('error', (error) => { exit = `error: ${error?.message ?? String(error)}` })
  child.unref?.()
  return {
    pid: typeof child.pid === 'number' ? child.pid : null,
    exited: () => exit,
  }
}

/**
 * Second-chance launch through `explorer.exe`.
 *
 * Explorer starts the application as a child of *itself*, with Explorer's own
 * environment and outside this process's Windows job, which reproduces a normal
 * double-click. Explorer returns immediately, so this handle reports no exit
 * information and the relaunch is judged by the port alone.
 * @param executable - application to start.
 * @param deps - `{ spawn }` injection point.
 * @returns a handle with an unknown exit state.
 */
export function launchViaExplorer(executable, deps = {}) {
  const launch = deps.spawn ?? spawn
  const child = launch('explorer.exe', [executable], { detached: true, stdio: 'ignore' })
  child.once?.('error', () => {})
  child.unref?.()
  return { pid: null, exited: () => null }
}

/**
 * Wait for a launched application to answer on the web port.
 * @param handle - value from {@link launchApplication} / {@link launchViaExplorer}.
 * @param port - web port to watch.
 * @param budgetMs - total time to allow.
 * @param deps - `{ probe, sleep }` injection points.
 * @returns `{ verified, reason }`; `reason` is null on success.
 */
export async function waitForRelaunch(handle, port, budgetMs, deps = {}) {
  const probe = deps.probe ?? probePort
  const sleep = deps.sleep ?? delay
  const attempts = Math.ceil(budgetMs / POLL_MS)
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const exit = handle?.exited?.()
    if (exit !== null && exit !== undefined) {
      return { verified: false, reason: `the launched application exited immediately (${String(exit)})` }
    }
    if (await probe(port) === true) return { verified: true, reason: null }
    await sleep(POLL_MS)
  }
  return { verified: false, reason: `the application was not listening within ${String(Math.round(budgetMs / 1000))} s` }
}

/**
 * Run the whole shutdown/restart sequence.
 * @param options - parsed helper options.
 * @param deps - injection points so the sequence is unit-testable:
 *   `{ kill, alive, probe, sleep, log, launch, launchExplorer }`.
 * @returns a JSON-safe summary (never throws).
 */
export async function runHelper(options, deps = {}) {
  const kill = deps.kill ?? ((pid) => process.kill(pid, 'SIGKILL'))
  const alive = deps.alive ?? isAlive
  const probe = deps.probe ?? probePort
  const sleep = deps.sleep ?? delay
  const log = deps.log ?? (() => {})
  const launch = deps.launch ?? launchApplication
  const launchExplorer = deps.launchExplorer ?? launchViaExplorer
  const summary = { action: options.action, shellTerminated: false, portReleased: false, relaunched: false, relaunchVerified: false, relaunchVia: null, escalated: false }

  log(`helper start action=${options.action} shellPid=${String(options.shellPid)} hostPid=${String(options.hostPid)} port=${String(options.port)}`)

  // 1) Let the plugin's HTTP reply reach the browser before its window dies.
  await sleep(RESPONSE_GRACE_MS)

  // 2) Terminate the shell. A window close would only hide it to the tray, and the
  //    shell is the only process that can quit the application as a whole.
  if (alive(options.shellPid)) {
    log(`terminating shell ${String(options.shellPid)}`)
    try {
      kill(options.shellPid)
    } catch (error) {
      log(`FAILED: could not terminate the shell: ${String(error?.message ?? error)}`)
    }
  } else {
    log('shell was already gone')
  }

  // 3) The host child releases the port when its IPC channel drops; wait for that,
  //    which is the graceful teardown, before considering force at all.
  summary.portReleased = await waitForPort(options.port, false, PORT_RELEASE_MS, { probe, sleep })
  log(`port released=${String(summary.portReleased)}`)

  // 4) Escalate only to the host child: it is the process that actually owns the
  //    port. Renderer and GPU processes exit on their own when the browser process
  //    dies, so sweeping the process tree is unnecessary.
  if (!summary.portReleased && alive(options.hostPid)) {
    summary.escalated = true
    log(`escalating: terminating the host child ${String(options.hostPid)}`)
    try {
      kill(options.hostPid)
    } catch (error) {
      log(`FAILED: could not terminate the host child: ${String(error?.message ?? error)}`)
    }
    summary.portReleased = await waitForPort(options.port, false, PORT_RELEASE_MS, { probe, sleep })
    log(`port released after escalation=${String(summary.portReleased)}`)
  }

  summary.shellTerminated = !alive(options.shellPid)
  log(`shell terminated=${String(summary.shellTerminated)}`)

  // 5) A restart relaunches only from a clean base: starting a second instance over
  //    a live one would just meet the shell's single-instance lock and quit again.
  if (options.action === 'restart') {
    if (!summary.portReleased) {
      log('FAILED: port still in use, not relaunching')
    } else if (options.executable === '') {
      log('FAILED: no executable to relaunch')
    } else {
      log(`launching ${options.executable}`)
      let outcome = { verified: false, reason: 'the launch could not be attempted' }
      try {
        const handle = await launch(options.executable)
        summary.relaunched = true
        summary.relaunchVia = 'spawn'
        log(`launched pid=${String(handle?.pid ?? '?')}`)
        outcome = await waitForRelaunch(handle, options.port, RELAUNCH_VERIFY_MS, { probe, sleep })
      } catch (error) {
        log(`FAILED: launch failed: ${String(error?.message ?? error)}`)
      }
      if (outcome.verified !== true) {
        log(`FAILED: ${String(outcome.reason)}`)
        // One second chance through Explorer, which starts the app with a normal
        // desktop environment and outside this process's job.
        log('retrying the launch through explorer.exe')
        try {
          const fallback = await launchExplorer(options.executable)
          summary.relaunched = true
          summary.relaunchVia = 'explorer'
          outcome = await waitForRelaunch(fallback, options.port, RELAUNCH_FALLBACK_MS, { probe, sleep })
        } catch (error) {
          log(`FAILED: explorer launch failed: ${String(error?.message ?? error)}`)
        }
      }
      summary.relaunchVerified = outcome.verified === true
      log(summary.relaunchVerified
        ? `relaunch verified: the port is listening again (via ${String(summary.relaunchVia)})`
        : `FAILED: ${String(outcome.reason)}`)
    }
  }

  log('helper done')
  return summary
}

/**
 * Entry point. The plugin host sets `DSH_POWER_HELPER_RUN=1`, so importing this
 * module from a test or a tool never runs the sequence.
 */
async function main() {
  let options
  try {
    options = parseHelperArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${String(error?.message ?? error)}\n`)
    process.exitCode = 1
    return
  }
  const logPath = options.logPath
  const log = (line) => {
    if (logPath === '') return
    try {
      appendFileSync(logPath, `${new Date().toISOString()}  [helper] ${line}\n`, 'utf8')
    } catch {
      // logging must never affect the sequence
    }
  }
  try {
    await runHelper(options, { log })
  } catch (error) {
    log(`FAILED: helper crashed: ${String(error?.message ?? error)}`)
  }
}

if (process.env.DSH_POWER_HELPER_RUN === '1') {
  await main()
}
