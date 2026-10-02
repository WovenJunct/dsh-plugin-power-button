# dsh-plugin-power-button


[中文](README.md)


> Adds a **power button** to the DeepSeek Harness (DSH) desktop sidebar. It sits at the
> **far right of the account button** in the bottom-left corner and opens a two-item menu —
> **Shut down** and **Restart** — instead of Settings / Feedback / Sign out. Shutting down
> quits the whole DSH desktop application; it does **not** hide to the taskbar tray.

![The power menu: only "Shut down" and "Restart"](docs/demo.png)

```text
┌──────────────────────────────┐
│  … sidebar sessions …         │
│                              │
│                              │
│  [ avatar  name ]       (⏻)  │   ← new power button, right of the account button
└──────────────────────────────┘
                    ↑ clicking it offers only:
                      ⏻ Shut down   quit DSH completely (window and tray icon gone)
                      ↻ Restart     quit, then start DSH again automatically
```

---

## What it does

- **Placement**: the right-hand end of the sidebar's account-button row, in one row with it.
- **Two actions only**: a small popup with **Shut down** and **Restart**, each with one line of
  explanation. No settings, no feedback, no sign-out.
- **Shut down means quit**: the Electron shell is terminated, so the window disappears and
  **so does the taskbar tray icon** — unlike the window's × button, which on Windows only
  hides the app to the tray.
- **Restart means quit + relaunch**: DSH is fully stopped, the web port is awaited, the
  application is started again, and the helper then **verifies the port is listening** again.
- **A confirmation only when work would be outstanding**: the same rule the shipped quit uses.
  A running session, queued message, background job, **or an armed scheduled reminder** in a
  loaded session makes it ask first, and lists the counts; an inspection that cannot be completed
  also asks, because "unknown" is not "idle". When nothing is outstanding, one click is enough.
- **Hidden off the desktop**: under `dsh web` (no shell to terminate) the button does not appear
  and the host route refuses the request.
- Simplified Chinese and English, following the UI language.

---

## How it works

The DSH desktop application is two processes:

- the **Electron shell** — the window and tray icon you see, and the only owner of `app.quit()`;
- the **Host child** — the Node process that runs the Cordis profile, the web server and every
  plugin.

A plugin's host half runs in the second one, so it has no `electron` module and no `app.quit()`.
The IPC channel between them is a **strict whitelist**: an unexpected message from the Host makes
the shell treat the Host as broken and kill it. The renderer preload exposes no quit channel
either, and closing the window on Windows means "hide to tray" — exactly what this plugin must
not do.

So the plugin uses **process ownership** instead. The Host child is spawned directly by the shell,
which means

- `process.ppid` is the shell's pid, and
- `process.execPath` is the shell's executable.

On a click the host:

1. flushes live sessions' buffered appends, with a 2 s deadline so a stuck writer cannot hold the
   action open (best effort by design);
2. starts a **detached helper** with the shell pid, its own pid, the executable, the web port and
   the action;
3. answers the browser first; the helper waits 1.2 s and then **terminates the Electron shell**;
4. the shell's death closes the IPC channel, which is what makes the Host shut *itself* down
   gracefully (its own designed exit path), releasing the web port;
5. the helper waits for the port; only if the Host never releases it does it terminate the Host
   child as well. Renderer and GPU processes exit on their own when the browser process dies, so
   no process-tree sweep is needed;
6. for a restart it starts DSH again once the port is free, then waits for the port to come back
   to **verify** the new instance really started. Any step that cannot complete is logged as
   `FAILED`, never skipped silently.

Nothing in the DSH installation is modified, and no custom message is ever put on that IPC channel.

### The helper is a Node script, not PowerShell

The first implementation generated `powershell -ExecutionPolicy Bypass -EncodedCommand <base64>`,
which is a textbook malware signature: endpoint protection is entitled to block it, and a blocked
helper turns "shut down" into "nothing happens, forever". Everything the helper needs — terminate a
process, probe a loopback port, start a program — is a Node builtin, so it is now one readable
Node script (`src/helper.mjs`) run by the same executable with `ELECTRON_RUN_AS_NODE=1`, exactly
how the shell starts the Host. No encoded payload, no execution policy, no stray console window.

### Why the helper outlives the process it ends

The helper terminates its own **ancestor**, so it must outlive it. Verified on the machine this was
built against:

- a `spawn(..., { detached: true })` process does **not** die with its parent's `TerminateProcess`,
  unless that parent sits in a Job object with `KILL_ON_JOB_CLOSE`;
- so does the shell own such a job? Measured: the shell, the Host, **and Explorer plus unrelated
  desktop applications** (Explorer, the security-centre tray, OneNote) are all in one job — a
  **session-level** job that neither DSH nor the shell created or owns. The shell's death cannot
  close its last handle, so that kill-on-close never fires.

(That was measured on this machine's Windows session only; a different launch setup is worth
re-checking against the `shell terminated` / `relaunch verified` lines in the log.)

### Who can call the route

The route can terminate the application, so it is fenced three ways:

1. it must be `application/json` — a cross-site page cannot send that without a preflight;
2. a request carrying a foreign `http(s)://` `Origin` is refused outright;
3. every action must carry a **per-boot nonce** that the Host injects into the page's HTML (a
   `global` row on `webserver/index-inject`, the same channel that delivers `window.__DSH_BOOT__`),
   which a cross-site script cannot read.

A local program can always `taskkill` DSH directly — that needs no plugin. What this fence stops is
**a web page open in your browser** shutting your DSH down.

### What this fence does not cover

Stated plainly, so the security story is not oversold:

- **Any local process running as you** can already `taskkill` DSH without this plugin; the nonce does
  not (and is not meant to) stop that.
- **Anyone who can run code in the DSH page console** can read the nonce — but they can already
  drive your DSH.
- **The port is not an authentication boundary.** DSH has a single loopback web port; this plugin
  only adds fences on top of it and does not change the host's own auth layer.

Other security-relevant properties:

- **No network access**: no telemetry and no outbound requests; the only endpoint it talks to is
  DSH's own local web server.
- **Nothing in the installation is modified**: it extends through public Cordis services and official
  slots only, never `app.asar` or any DSH file.
- **Your privileges, nothing more**: the helper runs as you, does not elevate, does not write to
  system directories, and installs no service or scheduled task.
- **The log can contain local paths** (`%USERPROFILE%\.dsh\dsh-plugin-power-button.log` records the
  shell's executable path, pids and the port). Read it before pasting it into a public issue — the
  repository itself contains no log.

## Known trade-offs and risks (worth reading before use)

- **A reply being generated right now is interrupted**: only terminating the shell gets around the
  tray behaviour, so an in-flight turn is cut short and a session log can lose its last fraction of
  a second. That is why the plugin asks first whenever work is outstanding.
- **Terminating processes is the whole point**: "shut down" ends the DSH desktop processes and
  "restart" ends them and starts them again; either way an unsaved in-flight turn is interrupted.
- **A restart can, in extremes, quit without coming back**: if the helper is blocked by security
  software, or the shell is replaced by another process in that short window, DSH closes normally
  but does not return — start it manually. The log will contain an explicit `FAILED:` line; nothing
  is skipped silently.
- **A theoretical PID-reuse window**: the helper terminates the background process by pid, about
  1.2 s after the request. If the shell had already exited *and* Windows reused that pid for an
  unrelated process in that window, that process could be terminated. Windows' pid allocation makes
  this extremely unlikely, and if the shell already exited there was nothing left to do; the plugin
  does not verify the target's image path (Node cannot read another process's path). Recorded here
  rather than glossed over.
- **Placement depends on shell internals**: the official plugin guide says to pick a slot that
  already allocates space and not to rewrite another component's DOM. Neither sidebar slot offers
  "right of the account button", so, as requested, the button is **portalled** into the shell's own
  `[data-slot="sidebar.settings"]` row (the official renderer emits that anchor) and a stylesheet
  carrying **this plugin's own attribute** makes that row a flex row and asks the existing account
  button for 32 px. To keep the blast radius small:
  - every rule requires `data-dsh-power-row`, which only this plugin sets, so nothing can match
    while the plugin is not running;
  - the rules target only that row's `:first-child` and this plugin's own container;
  - when the anchor is missing the button **degrades to the official slot**
    (`sidebar.footer.action`, right end), so a shell change costs placement, never the feature.

---

## Which devices it works on

| How DSH runs | Platform | Shut down / restart | Notes |
|---|---|---|---|
| **Desktop app** | **Windows 10 / 11** | ✅ **Works** — the only verified target | Needs the Electron shell → Host child relationship and the Windows process model; verified on DSH desktop `0.2.0-rc.2` |
| Desktop app | macOS / Linux | ❌ Not supported | Button hidden, route refuses. The implementation is Windows-specific (pid semantics, the `ELECTRON_RUN_AS_NODE` launch trick, the `explorer.exe` fallback) |
| `dsh web` (terminal server, browser client) | any | ❌ Not supported | There is no desktop shell to terminate, so the button hides and the route refuses; it deliberately does not pretend to "stop the server" |

In short: **this is a button for the Windows desktop app.** Installed anywhere else it neither errors
nor crashes — it simply does not appear.

---

## Compatibility

- Implemented against **DSH desktop 0.2.0-rc.2 on Windows**, checked against the installed
  application's own sources; the manifest declares `dsh.engines.dsh: >=0.2.0-rc.1`.
- Shutdown/restart is **Windows desktop only**. On macOS/Linux and under `dsh web` the plugin
  hides its button and refuses the request — it never errors and never crashes.
- Uses only public Cordis services (`webServer`, `agents`, `jobs`, `sessions`) and official slots
  (`sidebar.footer.action`, `shell.overlay`).

---

## Install

Requires the DSH desktop app. Replace the profile name as needed (the desktop profile is usually
`desktop`), and point the path at your own clone/extraction of this plugin.
`dsh` below is DSH's own CLI — the desktop menu can put it on `PATH`, or run
`resources\runtime\cli\bin\dsh.cmd` inside your DSH installation directory directly.

```sh
# from GitHub
dsh plugin --profile desktop add github:WovenJunct/dsh-plugin-power-button

# or from a local directory (Windows path shown; use /path/to/... on Linux/macOS)
dsh plugin --profile desktop add file:D:/path/to/dsh-plugin-power-button
```

On Windows you can also use the bundled helper:

```bat
install.cmd                  rem install into the desktop profile
install.cmd web              rem install into the web profile (button stays hidden)
install.cmd desktop "D:\path\to\dsh-plugin-power-button"
```

Then:

1. **Restart DSH** (the host half registers its route at startup, and the client bundle has to be
   served into the page again);
2. hard-refresh the page (Ctrl+Shift+R);
3. look to the right of the account button in the sidebar's bottom-left corner and click ⏻.

Uninstall:

```sh
dsh plugin --profile desktop remove dsh-plugin-power-button
```

> Local development: `dsh plugin add` on a local directory usually records a `link:` (symlink)
> rather than a snapshot, so an edited source file takes effect on the **next DSH start** with no
> re-add; if it recorded `file:` (a snapshot) instead, run `dsh plugin add` again or sync the
> changed files into the profile's `node_modules/dsh-plugin-power-button/`.

### Confirm it worked from the log

The host half activates through the profile's hot reload and the client bundle is hot-swapped into
an already-open page — **but the Host module itself is loaded at boot, so a change to `src/` only
takes effect after a DSH restart**. The log lives at
`%USERPROFILE%\.dsh\dsh-plugin-power-button.log`:

```text
[client 0.1.0] describe mode=desktop supported=true port=19387
[client 0.1.0] placement=account-row
[client 0.1.0] layout trigger=32x32@223,971 row=243x52@12 account=211x44@12 beside=true
```

- `mode=desktop supported=true` — the host confirms this is the DSH desktop app and the button is live;
- `placement=account-row` — the button really is **inside the account-button row** (it found the
  shell's own `[data-slot="sidebar.settings"]` anchor);
- `placement=slot-fallback (no account row anchor)` — that row was not found, so the button
  degraded to the right end of the action row below. The feature is unaffected; only the position
  differs;
- `layout … beside=true` — the button really is on the account button's right **in the same row**
  rather than stacked on top of it.

A real action adds:

```text
[host] shutdown accepted appPid=… port=19387 helperPid=… flushedSessions=1 command=…DeepSeek Harness.exe …helper.mjs
[helper] helper start action=shutdown shellPid=… hostPid=… port=19387
[helper] port released=true
[helper] shell terminated=true
[helper] helper done
```

A restart also logs `launching …` / `launched pid=…`, and must end with
`relaunch verified: the port is listening again (via spawn)` (or `via explorer`); any `FAILED:`
line means that step did not succeed — most often `the launched application exited immediately`.

---

## Verification

Self-contained, does not need DSH, and never terminates anything:

```sh
node verify/verify.mjs
```

It covers desktop/terminal/other-platform classification, helper argument building and validation,
**the whole helper sequence** (shutdown / restart / escalation when the port is never released /
reporting a refused termination), loopback port probing, spawn options (`detached`,
`ELECTRON_RUN_AS_NODE`, `stdio: ignore`) and the asynchronous failure hook, the host's work
inspection (running sessions, queued messages, background jobs, scheduled reminders, and
"inspection unavailable counts as work"), flush degradation and its deadline, the route's transport
and nonce fences, cross-site and oversized bodies, `apply`'s injection row and `ctx.inject`
fallback, and the browser bundle's registration, both slot claims and the row stylesheet's
installation and removal.

**It does not cover** what the React components actually paint, nor "one real click really quits /
restarts" on a live app: both need the running DSH, and this README records how they were checked
and what the results were.

---

## Troubleshooting

- **Log**: `%USERPROFILE%\.dsh\dsh-plugin-power-button.log` — the helper, the browser diagnostics
  and every accepted/refused request are recorded there.
- **No button**:
  1. check the plugin is enabled in this profile (`dsh plugin --profile desktop list`, or
     Settings → Plugins);
  2. make sure DSH was **restarted** after installing;
  3. make sure this is the **desktop app**, not `dsh web` (no shell, button hidden by design);
  4. look for `describe mode=… supported=…` in the log — `mode=web` is case 3.
- **Nothing happens on click**: the log's `refused` line carries the host's original error (for
  example "no web port found").
- **DSH did not come back after a restart**: the log shows `launching …` or `launch failed: …`.
  Starting it manually is safe; a `Start-Process` failure usually means the executable moved.

---

## License

MIT — see [LICENSE](LICENSE).
