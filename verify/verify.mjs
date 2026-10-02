/**
 * dsh-plugin-power-button — self-verification.
 *
 * Run with `node verify/verify.mjs` (or `npm run verify`).
 *
 * This harness exists because the feature's whole job is to terminate the
 * application it runs inside: an integration test that "really works" would kill
 * the DSH desktop session running it. So the suite proves the same behaviour one
 * layer down, with every process-touching call replaced by a fake:
 *
 *  - detection, argument building and the whole helper sequence are pure or
 *    dependency-injected, so a test observes exactly which pid, port and action
 *    would be used and no process is ever started or signalled;
 *  - the HTTP route is driven through fake request/response objects, including the
 *    transport and nonce gates that keep a web page from killing DSH;
 *  - the browser bundle is loaded against a fake module loader and a fake
 *    `document`, which proves the bundle registers, `apply` claims the two slots,
 *    and the row stylesheet is really injected and removed.
 *
 * It does NOT prove what the React components render, and it never starts a real
 * helper: those two limits are covered by the live checks documented in README.md.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

// Redirect every log write into a scratch home before importing the plugin.
const scratch = mkdtempSync(path.join(tmpdir(), 'dsh-power-verify-'))
process.env.DSH_HOME = scratch

const power = await import('../src/power.js')
const helper = await import('../src/helper.mjs')
const host = await import('../src/index.js')

/** @type {Array<{ name: string, ok: boolean, error?: string }>} */
const results = []

/**
 * Run one named check.
 * @param name - human-readable test name.
 * @param fn - test body; throws on failure (async allowed).
 */
async function test(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error: error instanceof Error ? `${error.message}` : String(error) })
  }
}

/** Build a fake plugin context with the services a test needs. */
function fakeCtx(services = {}) {
  const effects = []
  return {
    effects,
    get: (name) => services[name],
    logger: { info() {}, warn() {}, error() {} },
    effect(callback, label) {
      effects.push({ label, callback })
      return () => {}
    },
    on() {},
    inject() {},
  }
}

/** Fake `webServer` that captures the registered handler. */
function fakeWebServer() {
  const state = { handler: null, registrations: [] }
  return {
    state,
    register(request) {
      state.registrations.push(request)
      state.handler = request.handler
      return () => { state.handler = null }
    },
  }
}

/** Fake Node request emitting one body then ending (or aborting). */
function fakeRequest(method, body, options = {}) {
  const listeners = new Map()
  const request = {
    method,
    headers: options.headers ?? { 'content-type': 'application/json' },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(listener)
      return request
    },
    destroy() {},
  }
  queueMicrotask(() => {
    if (options.aborted === true) {
      for (const listener of listeners.get('close') ?? []) listener()
      return
    }
    if (body !== undefined) for (const listener of listeners.get('data') ?? []) listener(Buffer.from(body, 'utf8'))
    for (const listener of listeners.get('end') ?? []) listener()
  })
  return request
}

/** Fake Node response that records status and body. */
function fakeResponse() {
  return {
    status: null,
    headers: null,
    payload: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(payload) {
      this.payload = payload ?? ''
    },
    json() {
      return this.payload === '' ? null : JSON.parse(this.payload)
    },
  }
}

/** Drive the mounted route once and return the response. */
async function callRoute(handler, method, body, options = {}) {
  const response = fakeResponse()
  await handler(fakeRequest(method, body, options), response)
  return response
}

/** POST with a valid nonce and content type. */
async function callTokenRoute(handler, token, body) {
  return callRoute(handler, 'POST', JSON.stringify({ ...body, token }))
}

/**
 * Sentinel for every route test: reaching the real spawn helper from a self-test
 * would terminate the desktop application the test runs inside.
 */
const NO_SPAWN = () => {
  throw new Error('the self-test must never reach the real process-spawning helper')
}

const DESKTOP_OBSERVATION = {
  platform: 'win32',
  electronRunAsNode: true,
  connected: true,
  parentPid: 4242,
  execPath: 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe',
  version: '38.0.0',
}

/* ------------------------------------------------------------------ detection */

await test('classifyRuntime: a desktop shell child is fully supported', () => {
  const runtime = power.classifyRuntime(DESKTOP_OBSERVATION)
  assert.equal(runtime.mode, 'desktop')
  assert.equal(runtime.appPid, 4242)
  assert.equal(runtime.appExecutable, DESKTOP_OBSERVATION.execPath)
})

await test('classifyRuntime: a terminal `dsh web` boot has no shell to terminate', () => {
  const runtime = power.classifyRuntime({ ...DESKTOP_OBSERVATION, electronRunAsNode: false, connected: false, parentPid: 1 })
  assert.equal(runtime.mode, 'web')
  assert.equal(runtime.appPid, null)
  assert.equal(runtime.reason, 'no-desktop-ipc')
})

await test('classifyRuntime: run-as-node without an IPC channel is not the desktop host', () => {
  assert.equal(power.classifyRuntime({ ...DESKTOP_OBSERVATION, connected: false }).mode, 'web')
})

await test('classifyRuntime: a missing parent pid is refused', () => {
  const runtime = power.classifyRuntime({ ...DESKTOP_OBSERVATION, parentPid: 0 })
  assert.equal(runtime.mode, 'web')
  assert.equal(runtime.reason, 'no-parent')
})

await test('classifyRuntime: non-Windows platforms are unsupported, not broken', () => {
  const runtime = power.classifyRuntime({ ...DESKTOP_OBSERVATION, platform: 'darwin' })
  assert.equal(runtime.mode, 'unsupported')
  assert.equal(runtime.reason, 'platform:darwin')
})

/* ------------------------------------------------------------- helper argv */

await test('buildHelperArgs: carries the shell, host, port, action and log', () => {
  const args = power.buildHelperArgs({
    appPid: 4242,
    hostPid: 99,
    appExecutable: 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe',
    port: 19387,
    action: 'restart',
    logPath: 'C:\\logs\\power.log',
  })
  assert.ok(args[0].endsWith('helper.mjs'), `first argv entry must be the helper script, got ${args[0]}`)
  const value = (flag) => args[args.indexOf(flag) + 1]
  assert.equal(value('--shell-pid'), '4242')
  assert.equal(value('--host-pid'), '99')
  assert.equal(value('--port'), '19387')
  assert.equal(value('--action'), 'restart')
  assert.equal(value('--log'), 'C:\\logs\\power.log')
  assert.equal(value('--executable'), 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe')
})

await test('buildHelperArgs: invalid pids, ports and executables are refused, not guessed', () => {
  const base = { appPid: 1, hostPid: 2, appExecutable: 'C:\\dsh.exe', port: 3, action: 'shutdown' }
  assert.throws(() => power.buildHelperArgs({ ...base, appPid: 0 }), /appPid/)
  assert.throws(() => power.buildHelperArgs({ ...base, hostPid: -1 }), /hostPid/)
  assert.throws(() => power.buildHelperArgs({ ...base, port: 70000 }), /port/)
  assert.throws(() => power.buildHelperArgs({ ...base, appExecutable: '   ' }), /appExecutable/)
})

await test('parseHelperArgs: reads the flags buildHelperArgs writes', () => {
  const args = power.buildHelperArgs({ appPid: 7, hostPid: 8, appExecutable: 'C:\\dsh.exe', port: 9, action: 'restart', logPath: 'L' })
  const parsed = helper.parseHelperArgs(args.slice(1))
  assert.deepEqual(parsed, {
    shellPid: 7,
    hostPid: 8,
    port: 9,
    executable: 'C:\\dsh.exe',
    logPath: 'L',
    action: 'restart',
  })
})

await test('parseHelperArgs: a missing or malformed flag is an error, not a default', () => {
  assert.throws(() => helper.parseHelperArgs(['--shell-pid', '0', '--host-pid', '1', '--port', '2']), /shell-pid/)
  assert.throws(() => helper.parseHelperArgs(['--shell-pid', 'x', '--host-pid', '1', '--port', '2']), /shell-pid/)
  assert.throws(() => helper.parseHelperArgs(['--shell-pid', '1', '--host-pid', '1', '--port', '99999']), /port/)
})

await test('helperScriptPath: the shipped helper is present', () => {
  assert.equal(power.helperScriptExists(), true, 'src/helper.mjs must ship with the package')
  assert.ok(power.helperScriptPath().endsWith(`helper.mjs`))
})

/* ----------------------------------------------------------- helper sequence */

/**
 * Drive the whole helper sequence with every side effect faked.
 * @param overrides - per-test tweaks:
 *   `action`, `portFollowsShell`, `portFollowsHost`, `launchExited`,
 *   `launchBringsPort`, `explorerBringsPort`.
 * @returns `{ summary, killed, launched, lines }`.
 */
async function runFakeHelper(overrides = {}) {
  const killed = []
  const launched = []
  const lines = []
  // The shell dies on kill; the port follows the shell (or the override).
  const state = { shellAlive: true, hostAlive: true, portBusy: true }
  const summary = await helper.runHelper(
    {
      shellPid: 4242,
      hostPid: 99,
      port: 19387,
      executable: 'C:\\dsh.exe',
      action: overrides.action ?? 'shutdown',
      logPath: 'L',
    },
    {
      sleep: async () => {},
      alive: (pid) => (pid === 4242 ? state.shellAlive : pid === 99 ? state.hostAlive : false),
      kill: (pid) => {
        killed.push(pid)
        if (pid === 4242) {
          state.shellAlive = false
          if (overrides.portFollowsShell !== false) state.portBusy = false
        }
        if (pid === 99) {
          state.hostAlive = false
          if (overrides.portFollowsHost !== false) state.portBusy = false
        }
      },
      probe: async () => state.portBusy,
      launch: async (executable) => {
        launched.push({ via: 'spawn', executable })
        if (overrides.launchBringsPort === true) state.portBusy = true
        return { pid: 777, exited: () => (overrides.launchExited ?? null) }
      },
      launchExplorer: async (executable) => {
        launched.push({ via: 'explorer', executable })
        if (overrides.explorerBringsPort === true) state.portBusy = true
        return { pid: null, exited: () => null }
      },
      log: (line) => lines.push(line),
    },
  )
  return { summary, killed, launched, lines }
}

await test('runHelper: shutdown terminates the shell and never relaunches', async () => {
  const { summary, killed, launched, lines } = await runFakeHelper({ action: 'shutdown' })
  assert.deepEqual(killed, [4242], 'only the shell is terminated when the port frees itself')
  assert.equal(launched.length, 0)
  assert.equal(summary.shellTerminated, true)
  assert.equal(summary.portReleased, true)
  assert.equal(summary.relaunched, false)
  assert.ok(lines.some((line) => line.includes('shell terminated=true')))
  assert.ok(lines.includes('helper done'))
})

await test('runHelper: restart relaunches and verifies the new instance', async () => {
  const { summary, launched, lines } = await runFakeHelper({ action: 'restart', launchBringsPort: true })
  assert.deepEqual(launched, [{ via: 'spawn', executable: 'C:\\dsh.exe' }])
  assert.equal(summary.relaunched, true)
  assert.equal(summary.relaunchVia, 'spawn')
  assert.equal(summary.relaunchVerified, true)
  assert.ok(lines.some((line) => line.includes('relaunch verified')))
})

await test('runHelper: a launch that dies at once falls back to explorer.exe', async () => {
  // The regression this guards: a Node-mode launch exits in ~60 ms, which is how
  // "restart" used to close DSH and never bring it back.
  const { summary, launched, lines } = await runFakeHelper({
    action: 'restart',
    launchExited: 'error: ENOENT',
    explorerBringsPort: true,
  })
  assert.deepEqual(launched.map((entry) => entry.via), ['spawn', 'explorer'])
  assert.equal(summary.relaunchVia, 'explorer')
  assert.equal(summary.relaunchVerified, true)
  assert.ok(lines.some((line) => line.includes('exited immediately')))
})

await test('runHelper: an unverifiable restart is reported as FAILED', async () => {
  const { summary, lines } = await runFakeHelper({ action: 'restart' })
  assert.equal(summary.relaunchVerified, false)
  assert.equal(summary.relaunched, true)
  assert.ok(lines.some((line) => line.includes('FAILED:')), 'an unverified relaunch must not be silent')
})

await test('runHelper: restart does not relaunch while the port is still held', async () => {
  const { summary, launched, lines, killed } = await runFakeHelper({
    action: 'restart',
    portFollowsShell: false,
    portFollowsHost: false,
  })
  assert.deepEqual(launched, [], 'a relaunch over a live port would only hit the single-instance lock')
  assert.equal(summary.relaunched, false)
  assert.equal(summary.escalated, true, 'a host that never releases the port is terminated')
  assert.deepEqual(killed, [4242, 99])
  assert.ok(lines.some((line) => line.includes('FAILED: port still in use, not relaunching')))
})

await test('buildRelaunchEnv: the relaunched app must not inherit Node mode', () => {
  // The root cause of the broken restart, pinned as a unit test.
  const env = helper.buildRelaunchEnv({
    ELECTRON_RUN_AS_NODE: '1',
    DSH_POWER_HELPER_RUN: '1',
    SystemRoot: 'C:\\Windows',
    DSH_HOME: 'D:\\home',
  })
  assert.equal('ELECTRON_RUN_AS_NODE' in env, false, 'the app would otherwise start as Node and exit at once')
  assert.equal('DSH_POWER_HELPER_RUN' in env, false)
  assert.equal(env.SystemRoot, 'C:\\Windows', 'the rest of the environment must survive')
  assert.equal(env.DSH_HOME, 'D:\\home')
})

await test('launchApplication: detached, output-less, and reports an immediate death', () => {
  const calls = []
  const handlers = []
  const handle = helper.launchApplication('C:\\dsh.exe', {
    env: { ELECTRON_RUN_AS_NODE: '1', PATH: 'x' },
    spawn: (command, args, options) => {
      calls.push({ command, args, options })
      return {
        pid: 4321,
        once: (event, handler) => handlers.push({ event, handler }),
        unref() { calls.push({ unref: true }) },
      }
    },
  })
  assert.equal(calls[0].command, 'C:\\dsh.exe')
  assert.deepEqual(calls[0].args, [])
  assert.equal(calls[0].options.detached, true)
  assert.equal(calls[0].options.stdio, 'ignore')
  assert.equal(calls[0].options.cwd, 'C:\\', 'the app should start in its own directory, like a double-click')
  assert.equal('ELECTRON_RUN_AS_NODE' in calls[0].options.env, false)
  assert.equal(calls.some((entry) => entry.unref === true), true)
  assert.equal(handle.pid, 4321)
  assert.equal(handle.exited(), null, 'a live process reports no exit')
  const exitHandler = handlers.find((entry) => entry.event === 'exit')
  assert.ok(exitHandler !== undefined)
  exitHandler.handler(0)
  assert.equal(handle.exited(), 0)
})

await test('waitForRelaunch: verified by the port, refused when the app dies first', async () => {
  const listening = await helper.waitForRelaunch(
    { exited: () => null },
    19387,
    1000,
    { probe: async () => true, sleep: async () => {} },
  )
  assert.deepEqual(listening, { verified: true, reason: null })

  const died = await helper.waitForRelaunch(
    { exited: () => 0 },
    19387,
    1000,
    { probe: async () => false, sleep: async () => {} },
  )
  assert.equal(died.verified, false)
  assert.match(died.reason, /exited immediately/)

  const slow = await helper.waitForRelaunch(
    { exited: () => null },
    19387,
    5,
    { probe: async () => false, sleep: async () => {} },
  )
  assert.equal(slow.verified, false)
  assert.match(slow.reason, /not listening within/)
})

await test('launchViaExplorer: asks Explorer to start the app, with no exit signal', () => {
  const calls = []
  const handle = helper.launchViaExplorer('C:\\dsh.exe', {
    spawn: (command, args, options) => {
      calls.push({ command, args, options })
      return { pid: 5, once() {}, unref() {} }
    },
  })
  assert.equal(calls[0].command, 'explorer.exe')
  assert.deepEqual(calls[0].args, ['C:\\dsh.exe'])
  assert.equal(calls[0].options.detached, true)
  assert.equal(handle.exited(), null, 'Explorer returns at once, so its exit carries no information')
})

await test('runHelper: a failed termination is reported, never silent', async () => {
  const lines = []
  const summary = await helper.runHelper(
    { shellPid: 5, hostPid: 6, port: 7, executable: 'C:\\dsh.exe', action: 'shutdown', logPath: 'L' },
    {
      sleep: async () => {},
      alive: () => true,
      kill: () => { throw new Error('EPERM: access denied') },
      probe: async () => true,
      log: (line) => lines.push(line),
    },
  )
  assert.equal(summary.shellTerminated, false)
  assert.ok(lines.some((line) => line.includes('FAILED: could not terminate the shell')))
  assert.ok(lines.some((line) => line.includes('FAILED: port still in use, not relaunching') || line.includes('escalating')))
})

await test('runHelper: an already-dead shell is reported, not killed twice', async () => {
  const { summary, killed } = await runFakeHelper({ action: 'shutdown', portFollowsShell: true, portFollowsHost: true })
  assert.equal(summary.shellTerminated, true)
  const alreadyGone = await helper.runHelper(
    { shellPid: 4242, hostPid: 99, port: 19387, executable: 'C:\\dsh.exe', action: 'shutdown', logPath: 'L' },
    { sleep: async () => {}, alive: () => false, kill: () => killed.push('unexpected'), probe: async () => false, log: () => {} },
  )
  assert.equal(alreadyGone.shellTerminated, true)
  assert.ok(!killed.includes('unexpected'))
})

await test('waitForPort: succeeds only when the desired state is observed', async () => {
  let busy = true
  const probe = async () => busy
  const sleep = async () => { busy = false }
  assert.equal(await helper.waitForPort(1, false, 1000, { probe, sleep }), true)
  // Never satisfied: the budget runs out and the answer is false, not a hang.
  assert.equal(await helper.waitForPort(1, true, 5, { probe: async () => false, sleep: async () => {} }), false)
})

await test('probePort: a live loopback listener is busy, a closed port is free', async () => {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    assert.equal(await helper.probePort(port), true)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
  assert.equal(await helper.probePort(port), false)
})

/* --------------------------------------------------------------- helper spawn */

await test('spawnPowerHelper: starts the helper detached, headless and error-guarded', () => {
  const calls = []
  const events = []
  const result = power.spawnPowerHelper(
    { appPid: 4242, appExecutable: 'C:\\dsh.exe', port: 19387, action: 'shutdown' },
    {
      spawn: (command, args, options) => {
        calls.push({ command, args, options })
        return {
          pid: 99,
          on(event, handler) { events.push({ event, handler }) },
          unref() { calls.push({ unref: true }) },
        }
      },
      execPath: 'C:\\DeepSeek Harness.exe',
      env: { SystemRoot: 'C:\\Windows', DSH_HOME: scratch },
    },
  )
  assert.equal(result.ok, true)
  assert.equal(result.helperPid, 99)
  assert.equal(calls.length, 2, 'one spawn plus one unref')
  assert.equal(calls[0].command, 'C:\\DeepSeek Harness.exe')
  assert.equal(calls[0].options.detached, true, 'the helper must outlive the process it kills')
  assert.equal(calls[0].options.stdio, 'ignore')
  assert.equal(calls[0].options.windowsHide, true)
  assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, '1', 'the shell executable must run the helper as Node')
  assert.equal(calls[0].options.env.DSH_POWER_HELPER_RUN, '1', 'the helper must know it was really launched')
  assert.ok(calls[0].args[0].endsWith('helper.mjs'))
  assert.ok(calls[0].args.includes('--shell-pid'))
  assert.equal(calls[1].unref, true)
  // An unhandled async spawn error would take the DSH host down with it.
  assert.equal(events.length, 1)
  assert.equal(events[0].event, 'error')
  assert.equal(typeof events[0].handler, 'function')
})

await test('spawnPowerHelper: a failing spawn is reported, and the hook fires later', () => {
  const failures = []
  const result = power.spawnPowerHelper(
    { appPid: 1, appExecutable: 'C:\\dsh.exe', port: 1, action: 'shutdown' },
    { spawn: () => { throw new Error('EPERM: spawn refused') }, env: { DSH_HOME: scratch }, onFailure: (error) => failures.push(error) },
  )
  assert.equal(result.ok, false)
  assert.match(result.error, /EPERM/)

  let asyncHandler = null
  const armed = power.spawnPowerHelper(
    { appPid: 1, appExecutable: 'C:\\dsh.exe', port: 1, action: 'shutdown' },
    {
      spawn: () => ({ pid: 1, on: (event, handler) => { if (event === 'error') asyncHandler = handler }, unref() {} }),
      env: { DSH_HOME: scratch },
      onFailure: (error) => failures.push(error),
    },
  )
  assert.equal(armed.ok, true)
  assert.equal(typeof asyncHandler, 'function')
  asyncHandler(new Error('ENOENT: powershell gone'))
  assert.equal(failures.length, 1, 'an asynchronous failure must reach the caller')
})

await test('dshHome/helperLogPath: DSH_HOME wins over the conventional home', () => {
  assert.equal(power.dshHome({ DSH_HOME: 'D:\\custom' }, 'C:\\Users\\x'), 'D:\\custom')
  assert.equal(power.dshHome({}, 'C:\\Users\\x'), path.join('C:\\Users\\x', '.dsh'))
  assert.equal(power.helperLogPath({ DSH_HOME: 'D:\\custom' }, 'C:\\Users\\x'), path.join('D:\\custom', power.HELPER_LOG_NAME))
})

/* ------------------------------------------------------------ host behaviour */

await test('inspectWork: counts running agents, queued messages and jobs', async () => {
  const ctx = fakeCtx({
    agents: {
      list: () => [
        { id: 'a', status: 'running', inbox: { nextTurn: [], nextStep: [] } },
        { id: 'b', status: 'idle', inbox: { nextTurn: [1], nextStep: [] } },
        { id: 'c', status: 'idle', inbox: { nextTurn: [], nextStep: [] } },
      ],
    },
    jobs: { list: (id) => (id === undefined ? [] : id === 'c' ? [{ status: 'running' }] : []) },
  })
  const work = await host.inspectWork(ctx)
  assert.equal(work.activeTasks, true)
  assert.equal(work.agents, 1)
  assert.equal(work.queuedAgents, 1)
  assert.equal(work.jobs, 1)
  assert.equal(work.unknown, false)
})

await test('inspectWork: an idle host reports no active work', async () => {
  const ctx = fakeCtx({
    agents: { list: () => [{ id: 'a', status: 'idle', inbox: { nextTurn: [], nextStep: [] } }] },
    jobs: { list: () => [] },
  })
  const work = await host.inspectWork(ctx)
  assert.equal(work.activeTasks, false)
  assert.equal(work.unknown, false)
})

await test('inspectWork: an armed scheduled reminder counts as outstanding work', async () => {
  const ctx = fakeCtx({
    agents: { list: () => [{ id: 'a', status: 'idle', inbox: { nextTurn: [], nextStep: [] } }] },
    jobs: { list: () => [] },
  })
  ctx.waterfall = async () => [{ kind: 'schedule' }]
  const work = await host.inspectWork(ctx)
  assert.equal(work.scheduled, 1)
  assert.equal(work.activeTasks, true)
})

await test('inspectWork: an unavailable inspection fails safe and asks', async () => {
  // The shipped rule is "when the answer is unknown, ask before quitting".
  const missing = await host.inspectWork(fakeCtx())
  assert.equal(missing.activeTasks, true)
  assert.equal(missing.unknown, true)
  assert.equal(missing.reason, 'inspection-unavailable')

  const broken = fakeCtx({
    agents: { list: () => { throw new Error('roster unavailable') } },
    jobs: { list: () => [] },
  })
  const failed = await host.inspectWork(broken)
  assert.equal(failed.activeTasks, true)
  assert.equal(failed.reason, 'agent-roster-failed')

  const noReminders = fakeCtx({
    agents: { list: () => [{ id: 'a', status: 'idle', inbox: {} }] },
    jobs: { list: () => [] },
  })
  noReminders.waterfall = async () => { throw new Error('waterfall unavailable') }
  const reminderFailure = await host.inspectWork(noReminders)
  assert.equal(reminderFailure.activeTasks, true)
  assert.equal(reminderFailure.reason, 'reminder-inspection-failed')
})

await test('flushLiveSessions: flushes every live session and tolerates a refusal', async () => {
  const flushed = []
  const ctx = fakeCtx({
    sessions: {
      list: () => [{ id: 'a' }, { id: 'b' }],
      flush: async (session) => {
        if (session?.id === 'b') throw new Error('writer busy')
        flushed.push(session?.id)
      },
    },
  })
  assert.equal(await host.flushLiveSessions(ctx), 1)
  assert.deepEqual(flushed, ['a'])
  assert.equal(await host.flushLiveSessions(fakeCtx()), 0)
})

await test('withDeadline: a stuck dependency cannot hold the action open', async () => {
  const never = new Promise(() => {})
  assert.equal(await host.withDeadline(never, 10, 'fallback'), 'fallback')
  assert.equal(await host.withDeadline(Promise.resolve('value'), 1000, 'fallback'), 'value')
  assert.equal(await host.withDeadline(Promise.reject(new Error('boom')), 1000, 'fallback'), 'fallback')
})

await test('service.describe: a terminal host reports the button as unsupported', async () => {
  const ctx = fakeCtx({ webServer: { port: 19387 } })
  const service = new host.PowerButtonService(ctx, {
    observe: () => ({ ...DESKTOP_OBSERVATION, connected: false }),
  })
  const described = await service.describe()
  assert.equal(described.ok, true)
  assert.equal(described.supported, false)
  assert.equal(described.mode, 'web')
  assert.equal(described.logPath, null)
})

await test('service.act: an unsupported host refuses before arming anything', async () => {
  let spawned = 0
  const ctx = fakeCtx({ webServer: { port: 19387 } })
  const service = new host.PowerButtonService(ctx, {
    observe: () => ({ ...DESKTOP_OBSERVATION, platform: 'darwin' }),
    spawnHelper: () => { spawned += 1; return { ok: true } },
  })
  assert.equal((await service.act('shutdown')).ok, false)
  assert.equal(spawned, 0, 'no helper may be spawned without a desktop target')
  assert.equal((await service.describe()).pending, null, 'a refusal must not leave a claim behind')
})

await test('service.act: a desktop host arms exactly one helper with the shell pid and port', async () => {
  const armed = []
  const ctx = fakeCtx({
    webServer: { port: 19387 },
    agents: { list: () => [] },
    jobs: { list: () => [] },
    sessions: { list: () => [], flush: async () => {} },
  })
  const service = new host.PowerButtonService(ctx, {
    observe: () => DESKTOP_OBSERVATION,
    spawnHelper: (options) => { armed.push(options); return { ok: true, helperPid: 5, command: 'c', logPath: 'x' } },
  })
  const first = await service.act('restart')
  assert.equal(first.ok, true)
  assert.equal(first.action, 'restart')
  assert.equal(armed[0].appPid, 4242)
  assert.equal(armed[0].appExecutable, DESKTOP_OBSERVATION.execPath)
  assert.equal(armed[0].port, 19387)
  assert.equal(armed[0].hostPid, process.pid, 'the escalation target is this host, not a guessed pid')
  assert.equal((await service.act('shutdown')).ok, false)
  assert.equal(armed.length, 1, 'a double click must not arm a second helper')
})

await test('service.act: two concurrent requests arm exactly one helper', async () => {
  const armed = []
  const ctx = fakeCtx({
    webServer: { port: 19387 },
    agents: { list: () => [] },
    jobs: { list: () => [] },
    sessions: {
      list: () => [{ id: 'only' }],
      // A real flush awaits, which is exactly the window a check-then-act race needs.
      flush: () => new Promise((resolve) => setTimeout(resolve, 30)),
    },
  })
  const service = new host.PowerButtonService(ctx, {
    observe: () => DESKTOP_OBSERVATION,
    spawnHelper: (options) => { armed.push(options); return { ok: true, helperPid: 1, command: 'c', logPath: 'l' } },
  })
  const [first, second] = await Promise.all([service.act('shutdown'), service.act('restart')])
  assert.equal(armed.length, 1, 'exactly one helper may be armed')
  assert.equal([first, second].filter((result) => result.ok === true).length, 1)
})

await test('service.act: a helper that fails after arming releases the claim', async () => {
  const ctx = fakeCtx({ webServer: { port: 19387 }, sessions: { list: () => [] }, agents: { list: () => [] }, jobs: { list: () => [] } })
  let fail = null
  const service = new host.PowerButtonService(ctx, {
    observe: () => DESKTOP_OBSERVATION,
    spawnHelper: (_options, deps) => {
      fail = deps?.onFailure ?? null
      return { ok: true, helperPid: 7, command: 'c', logPath: 'x' }
    },
  })
  assert.equal((await service.act('shutdown')).ok, true)
  assert.equal((await service.describe()).pending, 'shutdown')
  assert.equal(typeof fail, 'function', 'the service must hand the spawn a failure hook')
  fail(new Error('EPERM: policy refused the helper'))
  assert.equal((await service.describe()).pending, null, 'a failed helper must not wedge the button forever')
  assert.equal((await service.act('shutdown')).ok, true, 'the user can try again')
})

await test('service.act: without a known port nothing is armed', async () => {
  let spawned = 0
  const ctx = fakeCtx({ webServer: { port: 'not-a-number' } })
  const service = new host.PowerButtonService(ctx, {
    observe: () => DESKTOP_OBSERVATION,
    spawnHelper: () => { spawned += 1; return { ok: true } },
  })
  const result = await service.act('shutdown')
  assert.equal(result.ok, false)
  assert.match(result.error, /Web 端口|桌面进程/)
  assert.equal(spawned, 0)
})

await test('isAlive: reports the running process, rejects impossible ids', () => {
  assert.equal(host.isAlive(process.pid), true)
  assert.equal(host.isAlive(0), false)
  assert.equal(host.isAlive(-5), false)
  assert.equal(host.isAlive(1.5), false)
})

/* ------------------------------------------------------------- transport gate */

await test('transportRefusal: only a JSON, non-foreign request is accepted', () => {
  assert.equal(host.transportRefusal({ headers: { 'content-type': 'application/json' } }), null)
  assert.equal(host.transportRefusal({ headers: { 'content-type': 'application/json; charset=utf-8' } }), null)
  // A cross-site page can send this without a preflight, which is exactly the attack.
  assert.match(host.transportRefusal({ headers: { 'content-type': 'text/plain' } }), /content-type/)
  assert.match(host.transportRefusal({ headers: {} }), /content-type/)
  assert.match(
    host.transportRefusal({ headers: { 'content-type': 'application/json', origin: 'https://evil.example' } }),
    /cross-origin/,
  )
  // The desktop renderer is not an http(s) origin, and a loopback one is fine.
  assert.equal(host.transportRefusal({ headers: { 'content-type': 'application/json', origin: 'dsh-app://app' } }), null)
  assert.equal(host.transportRefusal({ headers: { 'content-type': 'application/json', origin: 'null' } }), null)
  assert.equal(host.transportRefusal({ headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:19387' } }), null)
})

/* ---------------------------------------------------------------- HTTP route */

await test('route: registers one exact path on the web carrier', () => {
  const webServer = fakeWebServer()
  const mounted = host.mountPowerRoute(fakeCtx({ webServer }), { observe: () => DESKTOP_OBSERVATION, spawnHelper: NO_SPAWN, token: 'T' })
  assert.equal(webServer.state.registrations.length, 1)
  assert.equal(webServer.state.registrations[0].kind, 'exact')
  assert.equal(webServer.state.registrations[0].path, host.ROUTE)
  mounted.dispose()
})

await test('route: a non-JSON content type is refused before anything else', async () => {
  const webServer = fakeWebServer()
  host.mountPowerRoute(fakeCtx({ webServer }), { observe: () => DESKTOP_OBSERVATION, spawnHelper: NO_SPAWN, token: 'T' })
  const response = await callRoute(webServer.state.handler, 'POST', JSON.stringify({ action: 'shutdown', token: 'T' }), {
    headers: { 'content-type': 'text/plain' },
  })
  assert.equal(response.status, 403)
  assert.match(response.json().error, /content-type/)
})

await test('route: a foreign web origin is refused', async () => {
  const webServer = fakeWebServer()
  host.mountPowerRoute(fakeCtx({ webServer }), { observe: () => DESKTOP_OBSERVATION, spawnHelper: NO_SPAWN, token: 'T' })
  const response = await callRoute(webServer.state.handler, 'POST', JSON.stringify({ action: 'shutdown', token: 'T' }), {
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
  })
  assert.equal(response.status, 403)
  assert.match(response.json().error, /cross-origin/)
})

await test('route: an action without the page nonce is refused', async () => {
  const webServer = fakeWebServer()
  let spawned = 0
  host.mountPowerRoute(fakeCtx({ webServer }), {
    observe: () => DESKTOP_OBSERVATION,
    spawnHelper: () => { spawned += 1; return { ok: true } },
    token: 'secret',
  })
  const missing = await callRoute(webServer.state.handler, 'POST', JSON.stringify({ action: 'shutdown' }))
  assert.equal(missing.status, 403)
  const wrong = await callTokenRoute(webServer.state.handler, 'guessed', { action: 'shutdown' })
  assert.equal(wrong.status, 403)
  const stale = await callTokenRoute(webServer.state.handler, 'secret', { action: 'describe' })
  assert.equal(stale.status, 200)
  assert.equal(spawned, 0)
})

await test('route: GET is refused, unknown actions are refused', async () => {
  const webServer = fakeWebServer()
  host.mountPowerRoute(fakeCtx({ webServer }), { observe: () => DESKTOP_OBSERVATION, spawnHelper: NO_SPAWN, token: null })
  assert.equal((await callRoute(webServer.state.handler, 'GET')).status, 405)
  const unknown = await callRoute(webServer.state.handler, 'POST', JSON.stringify({ action: 'nuke' }))
  assert.equal(unknown.status, 400)
  assert.match(unknown.json().error, /unknown action/)
})

await test('route: malformed JSON is a 400, not a crash', async () => {
  const webServer = fakeWebServer()
  host.mountPowerRoute(fakeCtx({ webServer }), { observe: () => DESKTOP_OBSERVATION, spawnHelper: NO_SPAWN, token: null })
  const response = await callRoute(webServer.state.handler, 'POST', '{not json')
  assert.equal(response.status, 400)
  assert.equal(response.json().ok, false)
})

await test('route: a body abandoned mid-read answers instead of hanging', async () => {
  const webServer = fakeWebServer()
  host.mountPowerRoute(fakeCtx({ webServer }), { observe: () => DESKTOP_OBSERVATION, spawnHelper: NO_SPAWN, token: null })
  const response = await Promise.race([
    callRoute(webServer.state.handler, 'POST', undefined, { aborted: true }),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('the handler never answered')), 2000)),
  ])
  assert.equal(response.status, 400)
  assert.equal(response.json().ok, false)
})

await test('route: an oversized body is refused, not buffered forever', async () => {
  const webServer = fakeWebServer()
  host.mountPowerRoute(fakeCtx({ webServer }), { observe: () => DESKTOP_OBSERVATION, spawnHelper: NO_SPAWN, token: null })
  const response = await Promise.race([
    callRoute(webServer.state.handler, 'POST', `{"action":"${'x'.repeat(20 * 1024)}"}`),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('the handler never answered')), 2000)),
  ])
  assert.equal(response.status, 400)
  assert.match(response.json().error, /too large/)
})

await test('route: describe answers with the capability report', async () => {
  const webServer = fakeWebServer()
  host.mountPowerRoute(fakeCtx({ webServer, agents: { list: () => [] }, jobs: { list: () => [] } }), {
    observe: () => DESKTOP_OBSERVATION,
    spawnHelper: NO_SPAWN,
    token: 'T',
  })
  const response = await callTokenRoute(webServer.state.handler, 'T', { action: 'describe' })
  assert.equal(response.status, 200)
  const payload = response.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.supported, true)
  assert.equal(payload.appPid, 4242)
})

await test('route: an unsupported host answers 409 and arms nothing', async () => {
  const webServer = fakeWebServer()
  let spawned = 0
  host.mountPowerRoute(fakeCtx({ webServer }), {
    observe: () => ({ ...DESKTOP_OBSERVATION, connected: false }),
    spawnHelper: () => { spawned += 1; return { ok: true } },
    token: 'T',
  })
  const response = await callTokenRoute(webServer.state.handler, 'T', { action: 'shutdown' })
  assert.equal(response.status, 409)
  assert.equal(response.json().ok, false)
  assert.equal(spawned, 0)
})

await test('route: a trace line is accepted and recorded', async () => {
  const webServer = fakeWebServer()
  host.mountPowerRoute(fakeCtx({ webServer }), { observe: () => DESKTOP_OBSERVATION, spawnHelper: NO_SPAWN, token: 'T' })
  const response = await callTokenRoute(webServer.state.handler, 'T', { action: 'trace', message: 'hello' })
  assert.equal(response.status, 200)
  assert.match(readFileSync(power.helperLogPath(), 'utf8'), /\[client\] hello/)
})

/* ------------------------------------------------------------------- apply() */

await test('apply: injects the page nonce and registers the route', () => {
  const webServer = fakeWebServer()
  const injections = []
  const listeners = []
  const ctx = fakeCtx({ webServer })
  ctx.on = (event, handler) => { listeners.push({ event, handler }) }
  host.apply(ctx)

  assert.equal(listeners.length, 1)
  assert.equal(listeners[0].event, 'webserver/index-inject')
  listeners[0].handler(injections)
  assert.equal(injections.length, 1)
  // The table is structured (`kind: 'global'`, exactly like `__DSH_BOOT__`); a raw
  // markup string here would break the served index.
  const row = injections[0]
  assert.equal(row.kind, 'global')
  assert.equal(row.name, host.TOKEN_GLOBAL)
  assert.equal(typeof row.value, 'string')
  assert.ok(row.value.length >= 16, 'the nonce must actually be unguessable')
  assert.equal(webServer.state.registrations.length, 1, 'the route is registered immediately when webServer exists')
  assert.equal(ctx.effects.length, 1, 'the route disposer is owned by an effect')
})

await test('apply: the injected nonce matches the one the route requires', async () => {
  const webServer = fakeWebServer()
  const injections = []
  const ctx = fakeCtx({ webServer })
  ctx.on = (_event, handler) => handler(injections)
  host.apply(ctx)
  const token = injections[0].value
  const accepted = await callTokenRoute(webServer.state.handler, token, { action: 'describe' })
  assert.equal(accepted.status, 200, 'the page that received the nonce must be able to use it')
  const guessed = await callTokenRoute(webServer.state.handler, 'not-the-nonce', { action: 'describe' })
  assert.equal(guessed.status, 403)
})

await test('apply: waits through ctx.inject when the web server is not there yet', () => {
  const webServer = fakeWebServer()
  const injected = []
  const ctx = fakeCtx({})
  ctx.get = (name) => (name === 'webServer' && injected.length > 0 ? webServer : undefined)
  ctx.on = () => {}
  let deferred = null
  ctx.inject = (services, callback) => { deferred = { services, callback } }
  host.apply(ctx)
  assert.equal(webServer.state.registrations.length, 0)
  assert.deepEqual(deferred.services, ['webServer'])
  injected.push(true)
  deferred.callback({ get: () => webServer, logger: ctx.logger, effect: ctx.effect })
  assert.equal(webServer.state.registrations.length, 1)
})

/* -------------------------------------------------------------- the invariants */

await test('invariant: the plugin never writes to the shell IPC channel', () => {
  for (const file of ['src/index.js', 'src/power.js', 'src/helper.mjs']) {
    const source = readFileSync(path.join(root, file), 'utf8')
    assert.ok(!/process\.send\s*\(/u.test(source), `${file} must not call process.send (the shell kills an unknown IPC event)`)
  }
})

await test('invariant: no Harness Client package is imported anywhere', () => {
  for (const file of ['lib/client.js', 'src/index.js', 'src/power.js', 'src/helper.mjs']) {
    const source = readFileSync(path.join(root, file), 'utf8')
    assert.ok(!/require\(['"]@deepseek-ai\//u.test(source), `${file} must not require a Harness Client package`)
  }
  assert.ok(!/document\.body\.appendChild/u.test(readFileSync(path.join(root, 'lib/client.js'), 'utf8')))
})

await test('invariant: the helper needs no shell interpreter', () => {
  // Comments explain why PowerShell was dropped; only code may not depend on it.
  const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
  for (const file of ['src/index.js', 'src/power.js', 'src/helper.mjs']) {
    const code = stripComments(readFileSync(path.join(root, file), 'utf8'))
    assert.ok(
      !/powershell|ExecutionPolicy|EncodedCommand|taskkill/u.test(code),
      `${file} must not depend on an encoded shell payload`,
    )
  }
})

/* ------------------------------------------------------------ browser bundle */

/** Minimal DOM stand-in good enough for the stylesheet installer. */
function fakeDocument() {
  const appended = []
  const head = { appendChild: (node) => { appended.push(node); node.isConnected = true } }
  return {
    appended,
    head,
    querySelectorAll: () => [],
    createElement: () => ({
      dataset: {},
      textContent: '',
      isConnected: false,
      remove() { this.isConnected = false },
    }),
  }
}

await test('client bundle: registers, claims both slots and installs the row stylesheet', async () => {
  const originalWindow = globalThis.window
  const originalDocument = globalThis.document
  const registrations = []
  const effects = []
  let captured = null
  globalThis.window = {
    __ModuleLoader__: { load(spec) { captured = spec } },
    __DSH_POWER_TOKEN__: 'page-token',
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    innerHeight: 900,
    innerWidth: 1440,
  }
  const document = fakeDocument()
  globalThis.document = document
  try {
    await import(`../lib/client.js?verify=${String(Date.now())}`)
    assert.ok(captured !== null, 'the bundle must call __ModuleLoader__.load')
    assert.equal(captured.id, 'dsh-plugin-power-button')
    assert.equal(typeof captured.factory, 'function')

    const fakeReact = {
      createElement: (type, props, ...children) => ({ type, props, children }),
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
      useEffect: () => {},
      useRef: (initial) => ({ current: initial }),
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
    }
    const require = (id) => {
      if (id === 'react') return fakeReact
      if (id === 'react-dom') return { createPortal: (node) => node }
      throw new Error(`unexpected require(${id})`)
    }
    const plugin = captured.factory(require)
    assert.equal(typeof plugin.apply, 'function')
    assert.deepEqual(plugin.inject, ['slots'])

    const ctx = {
      get: (name) => {
        if (name === 'slots') {
          return {
            inject(slot, register) { registrations.push({ slot, entries: register() }) },
            register(options) { return options },
          }
        }
        if (name === 'locale') return { register() {}, subscribe() {}, getLocale: () => ({ active: 'en', locales: [], revision: 1 }) }
        return undefined
      },
      effect(callback, label) { effects.push({ callback, label }) },
    }
    plugin.apply(ctx)

    assert.deepEqual(registrations.map((entry) => entry.slot), ['sidebar.footer.action', 'shell.overlay'])
    assert.equal(registrations[0].entries.name, 'sidebar.footer.action')
    assert.equal(registrations[0].entries.id, 'dsh-plugin-power-button')
    assert.equal(registrations[1].entries.id, 'dsh-plugin-power-button-overlay')

    // The stylesheet must really reach the document, not merely exist as a string.
    const styles = effects.filter((entry) => String(entry.label).includes('row styles'))
    assert.equal(styles.length, 1)
    const dispose = styles[0].callback()
    assert.equal(document.appended.length, 1, 'the stylesheet must be appended to <head>')
    const css = document.appended[0].textContent
    assert.match(css, /\[data-slot="sidebar\.settings"\]\[data-dsh-power-row\]\{[\s\S]*display:flex!important/)
    assert.match(css, /margin-left:0!important/)
    assert.match(css, /margin-right:0!important/)
    assert.match(css, /flex:none!important/)
    assert.ok(css.includes('> :first-child'), 'the shrink override must be scoped to the existing occupant')
    assert.equal(document.appended[0].dataset.pluginCss, '@deepseek-ai/dsh-plugin-power-button/sidebar-row.css')
    assert.equal(typeof dispose, 'function')
    dispose()
    assert.equal(document.appended[0].isConnected, false, 'the stylesheet must be removed on dispose')
  } finally {
    globalThis.window = originalWindow
    globalThis.document = originalDocument
  }
})

/* ------------------------------------------------------------------ reporting */

rmSync(scratch, { recursive: true, force: true })

const failed = results.filter((result) => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'ok  ' : 'FAIL'}  ${result.name}`)
  if (!result.ok) console.log(`      ${result.error}`)
}
console.log(`\n${String(results.length - failed.length)}/${String(results.length)} checks passed`)
process.exitCode = failed.length === 0 ? 0 : 1
