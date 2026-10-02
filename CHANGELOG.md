# Changelog

All notable changes to this plugin are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — 2026-10-03

### Fixed

- **「重新启动」在关机后不会把 DSH 拉起来。** The relaunch inherited the helper's own
  `ELECTRON_RUN_AS_NODE=1`: the helper *is* a Node script, and a plain `spawn` hands that variable
  to the application, which then starts in **Node mode**, finds no script, and exits in ~60 ms —
  no window, no web port, and no error (measured on the machine this was built against: 63 ms with
  the marker, 562 ms without it, the latter being a real boot stopped by the single-instance lock).
  The launched app now gets a cleaned environment plus its own working directory, and an
  early-death detector reports it; a launch that dies at once is retried once through
  `explorer.exe`, which starts it the way a double-click does (Explorer's environment, outside
  this process's job). The verification window was raised from 20 s to 45 s for headroom: a warm
  restart was measured at about 5 s and the first one after a while takes considerably longer.
- **A false-positive relaunch report.** Verification watched the port alone, so starting DSH
  manually inside the window made the helper claim success. It now also watches the process it
  started and reports `the launched application exited immediately` or `not listening within N s`
  rather than a success it did not cause.
- The log now says which launch route worked (`(via spawn)` / `(via explorer)`).

## [0.1.0] — 2026-10-03

First release. Verified against DSH desktop `0.2.0-rc.2` on Windows.

### Added

- **Power button at the right of the sidebar account button.** The browser half registers into
  the `sidebar.footer.action` slot and, when the shell's `[data-slot="sidebar.settings"]` row
  anchor exists, portals the button into that row with `createPortal` so it shares the row with
  the account button and takes its right-hand end. Missing anchor ⇒ the button degrades to the
  footer action row instead of disappearing.
- **Two-item menu, nothing else**: 关机 / Shut down and 重新启动 / Restart, each with one line of
  explanation, in `shell.overlay`.
- **Real shutdown**: the host half terminates the Electron shell (the only way to avoid the
  Windows "hide to tray" behaviour of a window close), which also ends the Cordis host child and
  therefore the whole desktop application, tray icon included.
- **Restart**: a detached helper waits for the web port to be released and then starts the
  application again, so the new instance never hits the "another DSH instance" refusal.
- **Confirmation only when it matters**: the host mirrors the shipped quit inspection (running
  agents, queued inbox messages, running/stopping jobs) and the dialog only appears when stopping
  now would interrupt work.
- **Best-effort session flush** before the process tree is torn down.
- **Graceful degradation**: unsupported platforms and `dsh web` hide the button and make the route
  refuse with an explanation instead of failing.
- **Diagnostics**: `%USERPROFILE%\.dsh\dsh-plugin-power-button.log` records the helper's steps,
  browser-side traces, and every accepted/refused request.
- **Self-test**: `node verify/verify.mjs` — no DSH required, and no process is ever started or
  terminated (the helper sequence is driven entirely through injected fakes).

### Hardened after an independent adversarial review

The first complete revision was reviewed against the installed 0.2.0-rc.2 sources. These are the
changes that came out of it; the review's own two "do not re-report" items (the confirm dialog that
captured `mousedown` before `click`, and the portal that overflowed the row) had already been fixed
by then.

- **The route is no longer callable by anything that can reach loopback.** It previously accepted a
  bare POST, so a cross-site page (a CORS-simple `text/plain` request needs no preflight) or any
  local process could terminate DSH. It now requires `application/json`, refuses a foreign
  `http(s)` `Origin`, and requires a **per-boot nonce** injected into the page's HTML through
  `webserver/index-inject`'s `global` row — the same channel that delivers `window.__DSH_BOOT__`.
- **The helper is a Node script instead of encoded PowerShell.** `powershell -ExecutionPolicy
  Bypass -EncodedCommand …` is a malware signature that endpoint protection may block, which turned
  "shut down" into "nothing happens, forever". `src/helper.mjs` runs on the same executable with
  `ELECTRON_RUN_AS_NODE=1`; it has no shell dependency, and the self-test now asserts that.
- **The confirmation is as strict as the shipped one.** The armed-reminder probe
  (`workspace/session-activity`) was missing, and an unavailable inspection silently counted as
  "idle". Now reminders are counted, and an inspection that cannot be completed reports
  `activeTasks: true` with `unknown: true`, so the dialog asks — matching the shell's own rule.
- **A stuck dependency can no longer hang the action.** The pre-shutdown session flush now runs
  under a 2 s deadline, and the flush is genuinely best-effort as documented.
- **The `pending` guard is atomic.** It was checked before an `await` and assigned after it, so two
  concurrent requests could arm two helpers; it is now claimed synchronously and released on every
  failure path.
- **A failed helper releases the claim.** An asynchronous spawn failure (or a helper that never
  finishes) previously left the button permanently refusing with an undismissable "shutting down"
  notice. The spawn now takes an `onFailure` hook, the client's notice has a 20 s timeout, and the
  host has a watchdog.
- **A dismissed menu can no longer quit the app.** `choose()` captured the session before awaiting
  the host and now aborts if the menu was dismissed in the meantime.
- **Restart is verified.** The helper waits for the port to be free, relaunches only then (a
  relaunch over a live port would just meet the shell's single-instance lock), and waits for the
  port to come back — logging `relaunch verified` or an explicit `FAILED`.
- **The locale snapshot is read correctly.** `getLocale()` returns `{ active, locales, revision }`;
  the previous `id`/`locale` probes never matched, so the dictionary always fell back to the browser
  language. The dictionary is also registered inside `ctx.effect` now.
- **Accessibility**: the confirmation dialog takes focus, and the trigger reports `aria-expanded`.
- **The button no longer latches hidden** on a transient `describe` failure; it retries twice.
- **The DOM observer is cheap in steady state** (no `document.querySelector` per mutation, and the
  layout probe reports once per page instead of on every mount), so a streaming conversation cannot
  make it a hot path.
- **Fixed a real bug the new tests caught**: `unref()`'d timers in the helper and in the flush
  deadline could let a process with nothing else pending exit early — the helper could have died
  between two port probes.
- **Docs corrected**: the Windows collapsed sidebar hides the whole footer (the button does not
  "follow the account button into its centred layout"), shutdown terminates the shell plus the host
  rather than "the whole process tree", restart is verified rather than guaranteed, and the
  remaining trade-offs (PID-reuse window, dependency on shell internals, interrupted replies) are
  now stated in the README instead of omitted.

### Notes

- **The row needed three CSS overrides, not one.** Measured in the running shell (0.2.0-rc.2), the
  account row's occupant is an inner `triggerRow` wrapper with `flex: 0 0 auto`,
  `min-width: auto` and `margin: 0 -2px`. Making the row a flex container alone left the account
  button unshrinkable, so the new button landed **on top of it** (logged as
  `beside=false`); cancelling the negative margin alone was not enough either. The shipped rule
  lets the existing occupant shrink, keeps the new button at its natural size, and zeroes the
  horizontal margins — verified live as
  `layout trigger=32x32@223,971 row=243x52@12 account=211x44@12 beside=true`.
- **Detached-helper survival was measured, not assumed.** A `detached` child does not die with its
  terminated parent unless the parent owns a `KILL_ON_JOB_CLOSE` job; the shell, the host and
  unrelated desktop apps (Explorer, the security-centre tray, OneNote) all share one
  **session-level** job that neither DSH nor the shell owns, so that job never fires on the shell's
  death.
- Shutdown is necessarily abrupt at the window level, so an in-flight reply is interrupted. This
  is documented in the README along with the reason no graceful IPC request exists.
- The plugin never sends a custom message over the shell↔host IPC channel (that channel's
  whitelist is strict and an unknown message makes the shell kill the host), and it imports no
  Harness Client package. Both invariants are asserted by the self-test.
