/**
 * dsh-plugin-power-button — browser half.
 *
 * Two registrations, both in slots the shell already owns:
 *
 *  - `sidebar.footer.action` (a list slot inside the sidebar foot) carries the
 *    power button. The shell's own slot anchor — `[data-slot="sidebar.settings"]`
 *    — is the row that holds the account button, so when that anchor exists the
 *    button is portalled into it and labelled with our own attribute
 *    (`data-dsh-power-row`) to share the row and sit at the account button's
 *    right. When the anchor is missing the button degrades to the slot itself,
 *    right-aligned in the foot's action row, so a shell change costs placement,
 *    never the feature.
 *  - `shell.overlay` (the frame-wide floating layer) carries the menu and the
 *    confirmation dialog, exactly like a shipped modal: they are fixed-position
 *    and never touch another component's DOM.
 *
 * The button only reports intent: every action goes to the host route, which owns
 * process control. Bundle format is the client-modules protocol
 * (`window.__ModuleLoader__.load`), so `react` comes from the shell's own module
 * table and nothing is bundled twice.
 */
/* eslint-disable no-undef -- browser bundle: React and the shell loader are globals here. */
if (typeof window !== 'undefined' && window.__ModuleLoader__ !== undefined) {
  window.__ModuleLoader__.load({
    id: 'dsh-plugin-power-button',
    factory: (require) => {
      const React = require('react')

      /** `createPortal` is optional: without it the button stays in its slot. */
      let createPortal = null
      try {
        const ReactDOM = require('react-dom')
        if (typeof ReactDOM?.createPortal === 'function') createPortal = ReactDOM.createPortal
      } catch {
        createPortal = null
      }

      const SLOT = 'sidebar.footer.action'
      const OVERLAY_SLOT = 'shell.overlay'
      const ENTRY_ID = 'dsh-plugin-power-button'
      const DIALOG_ID = 'dsh-plugin-power-button-overlay'
      const SLOT_ORDER = 500
      const OVERLAY_ORDER = 215
      /** The shell's slot anchor that holds the sidebar account button. */
      const ACCOUNT_SLOT = 'sidebar.settings'
      /** Attribute we put on the account row so our stylesheet may claim it. */
      const ROW_ATTRIBUTE = 'data-dsh-power-row'
      /** Bumped on every client-side change; the first trace line reports it. */
      const CLIENT_REVISION = '0.1.0'
      /** Host route registered by src/index.js. */
      const POWER_PATH = '/plugins/dsh-plugin-power-button/power'
      const OPEN_EVENT = 'dsh-power-button:open'
      /** Broadcast by the overlay so the trigger can report `aria-expanded`. */
      const STATE_EVENT = 'dsh-power-button:state'
      const NS = 'dsh-power-button'
      /** Per-boot nonce injected into the page by the host half. */
      const TOKEN_GLOBAL = '__DSH_POWER_TOKEN__'
      /** Identifies our injected stylesheet so a reload never doubles it. */
      const STYLE_ID = '@deepseek-ai/dsh-plugin-power-button/sidebar-row.css'

      const zh = {
        'button.label': '电源',
        'button.title': '关机 / 重新启动',
        'menu.shutdown': '关机',
        'menu.shutdown.hint': '完全退出 DSH，窗口和托盘图标都会消失',
        'menu.restart': '重新启动',
        'menu.restart.hint': '关闭后自动重新启动 DSH',
        'menu.checking': '正在检查是否有任务在运行…',
        'confirm.title.shutdown': '现在关机？',
        'confirm.title.restart': '现在重新启动？',
        'confirm.body.shutdown': 'DSH 会被完全关闭：窗口和任务栏托盘图标都会消失，不会缩到托盘。',
        'confirm.body.restart': 'DSH 会被完全关闭，然后自动重新启动。',
        'confirm.running': '当前仍有未完成的工作（{agents} 个运行中会话、{queued} 条排队消息、{jobs} 个后台任务、{scheduled} 个定时提醒），关机/重启会中断正在运行的任务，关闭期间定时提醒也不会触发。',
        'confirm.cancel': '取消',
        'confirm.unknown': '无法确认当前是否有任务在运行（检查超时或服务不可用），为安全起见先请你确认。',        'confirm.ok.shutdown': '关机',
        'confirm.ok.restart': '重新启动',
        'working.shutdown': '正在关机，DSH 即将关闭…',
        'working.restart': '正在重启，DSH 即将重新启动…',
        'error.title': '操作失败',
        'error.close': '知道了',
        'error.unreachable': '无法联系 DSH 主机：请确认插件已在当前 profile 中启用并重启过 DSH。',
        'error.timeout': '主机接受了请求，但 DSH 没有在预期时间内退出。请重试，或查看 .dsh\\dsh-plugin-power-button.log。',
      }

      const en = {
        'button.label': 'Power',
        'button.title': 'Shut down / Restart',
        'menu.shutdown': 'Shut down',
        'menu.shutdown.hint': 'Quit DSH completely — window and tray icon go away',
        'menu.restart': 'Restart',
        'menu.restart.hint': 'Quit and start DSH again automatically',
        'menu.checking': 'Checking whether work is running…',
        'confirm.title.shutdown': 'Shut down now?',
        'confirm.title.restart': 'Restart now?',
        'confirm.body.shutdown': 'DSH will quit completely: its window and its taskbar tray icon disappear, and it will not hide to the tray.',
        'confirm.body.restart': 'DSH will quit completely and then start again automatically.',
        'confirm.running': 'Work is still outstanding ({agents} running session(s), {queued} queued message(s), {jobs} background job(s), {scheduled} scheduled reminder(s)); shutting down interrupts the running work, and scheduled reminders will not fire while DSH is closed.',
        'confirm.cancel': 'Cancel',
        'confirm.unknown': 'Whether work is running could not be determined (the check timed out or the service is unavailable); confirming first is the safe default.',
        'confirm.ok.shutdown': 'Shut down',
        'confirm.ok.restart': 'Restart',
        'working.shutdown': 'Shutting down — DSH is about to close…',
        'working.restart': 'Restarting — DSH is about to come back…',
        'error.title': 'Action failed',
        'error.close': 'Dismiss',
        'error.unreachable': 'The DSH host could not be reached. Check that the plugin is enabled in this profile and that DSH was restarted after installing it.',
        'error.timeout': 'The host accepted the request, but DSH did not exit within the expected time. Try again, or read .dsh\\dsh-plugin-power-button.log.',
      }

      let localeService = null
      /** One layout report per page load (see the trigger's layout effect). */
      let layoutReported = false

      /** @returns the active locale id ('zh' fallback). */
      function activeLocale() {
        try {
          const snapshot = localeService?.getLocale?.()
          // `getLocale()` returns `{ active, locales, revision }`; `active` is the
          // resolved locale id. The other spellings are tolerated so a renamed field
          // degrades to the browser language instead of breaking.
          const id = snapshot?.active ?? snapshot?.locale ?? snapshot?.id
          const tag = typeof id === 'string' ? id : typeof id?.id === 'string' ? id.id : undefined
          if (typeof tag === 'string' && tag !== '') return tag.toLowerCase().startsWith('en') ? 'en' : 'zh'
        } catch {
          // fall through to the browser language
        }
        const browser = typeof navigator !== 'undefined' ? navigator.language : 'zh'
        return typeof browser === 'string' && browser.toLowerCase().startsWith('en') ? 'en' : 'zh'
      }

      /**
       * Translate one key.
       * @param key - dictionary key.
       * @param params - `{ name }` placeholders.
       * @returns localized text, falling back to zh and then the key.
       */
      function text(key, params) {
        const dictionary = activeLocale() === 'en' ? en : zh
        const template = dictionary[key] ?? zh[key] ?? key
        if (params === undefined) return template
        return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
      }

      /** Re-render on locale switches so an open menu follows the UI language. */
      function useLocaleRevision() {
        const [revision, setRevision] = React.useState(0)
        React.useEffect(() => {
          if (typeof localeService?.subscribe !== 'function') return undefined
          const unsubscribe = localeService.subscribe(() => setRevision((value) => value + 1))
          return typeof unsubscribe === 'function' ? unsubscribe : undefined
        }, [])
        return revision
      }

      /** Hover/focus state for one interactive surface, without a CSS dependency. */
      function useHover() {
        const [hovered, setHovered] = React.useState(false)
        return {
          hovered,
          handlers: {
            onMouseEnter: () => setHovered(true),
            onMouseLeave: () => setHovered(false),
            onFocus: () => setHovered(true),
            onBlur: () => setHovered(false),
          },
        }
      }

      const tokens = {
        labelPrimary: 'var(--dsw-alias-label-primary, inherit)',
        labelSecondary: 'var(--dsw-alias-label-secondary, #8a8a8e)',
        labelTertiary: 'var(--dsw-alias-label-tertiary, #9a9a9f)',
        hover: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.14))',
        surface: 'var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, #ffffff))',
        layer: 'var(--dsw-alias-bg-layer-2, transparent)',
        borderL1: 'var(--dsw-alias-border-l1, rgba(128,128,128,0.2))',
        borderL2: 'var(--dsw-alias-border-l2, rgba(128,128,128,0.32))',
        danger: 'var(--dsw-alias-state-error-primary, #e5484d)',
        radius: 'var(--dsw-radius-md, 8px)',
      }

      const styles = {
        trigger: {
          flex: 'none',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 0,
          border: 0,
          background: 'transparent',
          color: tokens.labelSecondary,
          cursor: 'pointer',
          font: 'inherit',
          borderRadius: tokens.radius,
        },
        menu: {
          position: 'fixed',
          zIndex: 2100,
          minWidth: 210,
          maxWidth: 'min(300px, calc(100vw - 16px))',
          boxSizing: 'border-box',
          padding: 4,
          borderRadius: 10,
          border: `1px solid ${tokens.borderL2}`,
          background: tokens.surface,
          color: tokens.labelPrimary,
          boxShadow: '0 12px 32px rgba(0, 0, 0, 0.24)',
          fontSize: 14,
          lineHeight: '20px',
        },
        menuItem: {
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          width: '100%',
          boxSizing: 'border-box',
          padding: '8px 10px',
          border: 0,
          borderRadius: tokens.radius,
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
        },
        menuIcon: { flex: 'none', display: 'inline-flex', marginTop: 2, color: tokens.labelSecondary },
        menuLabel: { display: 'block', fontWeight: 500 },
        menuHint: { display: 'block', fontSize: 12, lineHeight: '18px', color: tokens.labelTertiary, marginTop: 2 },
        overlayLayer: {
          position: 'fixed',
          inset: 0,
          zIndex: 2050,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(0, 0, 0, 0.42)',
        },
        dialog: {
          width: 'min(440px, calc(100vw - 48px))',
          boxSizing: 'border-box',
          borderRadius: 12,
          border: `1px solid ${tokens.borderL2}`,
          background: tokens.surface,
          color: tokens.labelPrimary,
          boxShadow: '0 18px 48px rgba(0, 0, 0, 0.28)',
          padding: '18px 20px 16px',
          fontSize: 14,
          lineHeight: '22px',
        },
        dialogTitle: { fontSize: 16, fontWeight: 600, lineHeight: '24px', margin: '0 0 10px' },
        dialogBody: { color: tokens.labelSecondary, fontSize: 13, margin: '0 0 12px' },
        dialogWarning: { color: tokens.danger, fontSize: 13, margin: '0 0 12px' },
        dialogError: { color: tokens.danger, fontSize: 13, margin: '0 0 12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
        footer: { display: 'flex', justifyContent: 'flex-end', gap: 8 },
        button: {
          font: 'inherit',
          fontSize: 13,
          lineHeight: '20px',
          padding: '6px 14px',
          borderRadius: tokens.radius,
          cursor: 'pointer',
          border: `1px solid ${tokens.borderL2}`,
          background: 'transparent',
          color: tokens.labelPrimary,
        },
        buttonDanger: {
          border: `1px solid ${tokens.danger}`,
          background: tokens.danger,
          color: '#ffffff',
        },
        buttonDisabled: { opacity: 0.55, cursor: 'default' },
        card: {
          border: `1px solid ${tokens.borderL1}`,
          borderRadius: tokens.radius,
          padding: '8px 10px',
          margin: '0 0 12px',
          background: tokens.layer,
          fontSize: 12,
          lineHeight: '18px',
          color: tokens.labelTertiary,
          wordBreak: 'break-all',
        },
      }

      /**
       * The stylesheet that lets the account row host one more control.
       *
       * The row's own occupant is authored for a block container: measured in the
       * running shell (0.2.0-rc.2) it is an inner `triggerRow` wrapper with
       * `flex: 0 0 auto`, `min-width: auto` and `margin: 0 -2px`, so simply turning
       * the row into a flex container makes it overflow and the new button lands
       * *on top of* the account button. All three overrides are therefore
       * load-bearing: let the existing occupant shrink, keep our own button at its
       * natural size, and cancel the negative margin that the flex algorithm counts
       * as shrinkable space but the eye sees as button. The account label already
       * ellipsises, so it degrades the way the shell's own layout does. Only
       * elements carrying our own attribute are matched, so none of this can apply
       * before this plugin ran.
       */
      const ROW_CSS = [
        `[data-slot="${ACCOUNT_SLOT}"][${ROW_ATTRIBUTE}]{`,
        '  display:flex!important;',
        '  align-items:center;',
        '  min-width:0;',
        '}',
        `[data-slot="${ACCOUNT_SLOT}"][${ROW_ATTRIBUTE}] > :first-child{`,
        '  min-width:0!important;',
        '  flex:1 1 auto!important;',
        '  margin-left:0!important;',
        '  margin-right:0!important;',
        '}',
        `[data-slot="${ACCOUNT_SLOT}"][${ROW_ATTRIBUTE}] > [data-dsh-power-anchor]{`,
        '  flex:none!important;',
        '}',
      ].join('\n')

      /** Inline power glyph (no dependency on a shipped icon export). */
      function PowerIcon({ size = 16 }) {
        return React.createElement('svg', {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block' },
        },
        React.createElement('path', {
          d: 'M8 1.25a.75.75 0 0 1 .75.75v5.5a.75.75 0 0 1-1.5 0V2A.75.75 0 0 1 8 1.25Z',
          fill: 'currentColor',
        }),
        React.createElement('path', {
          d: 'M4.4 3.42a.75.75 0 0 1 .06 1.06 5 5 0 1 0 7.08 0 .75.75 0 1 1 1-1.12 6.5 6.5 0 1 1-9.2 0 .75.75 0 0 1 1.06-.06Z',
          fill: 'currentColor',
        }))
      }

      /** Inline restart glyph. */
      function RestartIcon({ size = 16 }) {
        return React.createElement('svg', {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block' },
        },
        React.createElement('path', {
          d: 'M8 2.25c-2.4 0-4.4 1.5-5.16 3.6a.75.75 0 1 1-1.41-.5A6.75 6.75 0 0 1 13.6 6.3V4.2a.75.75 0 0 1 1.5 0v3.55a.75.75 0 0 1-.75.75H10.8a.75.75 0 0 1 0-1.5h1.36A5.25 5.25 0 0 0 8 3.75v-1.5Z',
          fill: 'currentColor',
        }),
        React.createElement('path', {
          d: 'M8 13.75c2.4 0 4.4-1.5 5.16-3.6a.75.75 0 0 1 1.41.5A6.75 6.75 0 0 1 2.4 9.7v2.1a.75.75 0 0 1-1.5 0V8.25c0-.41.34-.75.75-.75h3.55a.75.75 0 0 1 0 1.5H3.84A5.25 5.25 0 0 0 8 12.25v1.5Z',
          fill: 'currentColor',
        }))
      }

      /** The per-boot nonce the host injects into the page's HTML. */
      function pageToken() {
        try {
          const value = window[TOKEN_GLOBAL]
          return typeof value === 'string' && value !== '' ? value : null
        } catch {
          return null
        }
      }

      /**
       * POST one action to the host route (registered by src/index.js).
       * @param body - `{ action, message? }`; the page nonce is added here.
       * @returns the parsed JSON result (never throws).
       */
      async function request(body) {
        try {
          const token = pageToken()
          const response = await fetch(POWER_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(token === null ? body : { ...body, token }),
          })
          let payload = null
          try {
            payload = await response.json()
          } catch {
            payload = null
          }
          if (payload === null || typeof payload !== 'object') {
            return { ok: false, error: `主机未返回有效响应（HTTP ${response.status}）。` }
          }
          return payload
        } catch (error) {
          return { ok: false, error: text('error.unreachable'), cause: String(error?.message ?? error) }
        }
      }

      /**
       * Send one diagnostic line to the host's plugin log. Fire and forget.
       * @param message - text to record.
       */
      function trace(message) {
        void request({ action: 'trace', message: `[client ${CLIENT_REVISION}] ${String(message)}` }).catch(() => {})
      }

      /**
       * Resolve the DOM node the power button should live in.
       *
       * The account row is located through the shell's own slot anchor rather than
       * through hashed class names. Our own container is kept last in that row, so
       * the button always renders at the account button's right even if React
       * re-renders the row around it.
       * @param enabled - whether to look for the anchor at all.
       * @returns `{ mode: 'row', node }`, `{ mode: 'slot' }`, or null while unresolved.
       */
      function useAccountRow(enabled) {
        const [target, setTarget] = React.useState(null)
        React.useEffect(() => {
          if (!enabled) return undefined
          if (createPortal === null || typeof document === 'undefined') {
            setTarget({ mode: 'slot' })
            return undefined
          }
          let anchor = null
          let container = null
          let pending = null
          let lastPlacement = null

          /** Record a placement change once, so the log answers "where did it land?". */
          const notePlacement = (placement) => {
            if (placement === lastPlacement) return
            lastPlacement = placement
            trace(`placement=${placement}`)
          }

          const release = () => {
            if (container !== null && container.isConnected) container.remove()
            container = null
            if (anchor !== null && anchor.isConnected) anchor.removeAttribute(ROW_ATTRIBUTE)
            anchor = null
          }

          const search = () => {
            pending = null
            const next = document.querySelector(`[data-slot="${ACCOUNT_SLOT}"]`)
            if (next === null) {
              if (anchor !== null) release()
              notePlacement('slot-fallback (no account row anchor)')
              setTarget((current) => (current?.mode === 'slot' ? current : { mode: 'slot' }))
              return
            }
            if (next === anchor && container !== null && container.isConnected) {
              if (anchor.lastElementChild !== container) anchor.appendChild(container)
              return
            }
            release()
            anchor = next
            anchor.setAttribute(ROW_ATTRIBUTE, '1')
            container = document.createElement('div')
            container.setAttribute('data-dsh-power-anchor', '1')
            container.style.cssText = 'display:flex;align-items:center;flex:none'
            anchor.appendChild(container)
            notePlacement('account-row')
            setTarget({ mode: 'row', node: container })
          }

          /** Coalesce bursts of DOM mutations into one lookup. */
          const schedule = () => {
            if (pending !== null) return
            pending = setTimeout(search, 120)
          }

          search()
          // A streaming conversation mutates the DOM constantly, so the steady state
          // must stay cheap: while our own node is still in place this only keeps it
          // last in the row, and the expensive lookup runs only after we lose it.
          const observer = new MutationObserver(() => {
            if (anchor !== null && anchor.isConnected && container !== null && container.isConnected) {
              if (anchor.lastElementChild !== container) anchor.appendChild(container)
              return
            }
            schedule()
          })
          observer.observe(document.body, { childList: true, subtree: true })
          return () => {
            observer.disconnect()
            if (pending !== null) clearTimeout(pending)
            release()
          }
        }, [enabled])
        return target
      }

      /**
       * The power button itself. It only reports the click upward: the overlay owns
       * the menu, so the button never has to know what the actions are.
       */
      function PowerTrigger({ wide, supported, expanded }) {
        useLocaleRevision()
        const { hovered, handlers } = useHover()
        const buttonRef = React.useRef(null)
        const size = wide === false ? 36 : 32

        // One layout report per page: it is the only way to tell "the button is in
        // the account row" from "the row rejected the extra child and it stacked
        // below", which looks identical in the DOM tree but not on screen. It runs
        // once per page load rather than on every mount, so the log cannot grow
        // without bound in a long-lived session.
        React.useEffect(() => {
          const node = buttonRef.current
          if (node === null || layoutReported === true) return undefined
          layoutReported = true
          const timer = setTimeout(() => {
            try {
              const box = node.getBoundingClientRect()
              const row = node.closest(`[data-slot="${ACCOUNT_SLOT}"]`) ?? node.parentElement
              const round = (value) => String(Math.round(value))
              // Measure the account button itself, not its wrapper: the wrapper also
              // carries the connection indicator, so its right edge is not the answer.
              const account = row?.querySelector('button[aria-haspopup="menu"]') ?? row?.firstElementChild ?? null
              const accountBox = account === null ? null : account.getBoundingClientRect()
              const rowBox = row === null ? null : row.getBoundingClientRect()
              const beside = accountBox === null
                ? 'n/a'
                : String(box.left + 1 >= accountBox.right && Math.abs(box.top - accountBox.top) < 24)
              trace(`layout trigger=${round(box.width)}x${round(box.height)}@${round(box.left)},${round(box.top)}`
                + ` row=${rowBox === null ? 'none' : `${round(rowBox.width)}x${round(rowBox.height)}@${round(rowBox.left)}`}`
                + ` account=${accountBox === null ? 'none' : `${round(accountBox.width)}x${round(accountBox.height)}@${round(accountBox.left)}`}`
                + ` beside=${beside}`)
            } catch {
              // layout diagnostics are best effort
            }
          }, 250)
          return () => clearTimeout(timer)
        }, [])

        const onClick = React.useCallback((event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          window.dispatchEvent(new CustomEvent(OPEN_EVENT, {
            detail: {
              rect: { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left },
              trigger: event.currentTarget,
            },
          }))
        }, [])
        return React.createElement('button', {
          type: 'button',
          ref: buttonRef,
          'aria-label': text('button.label'),
          'aria-haspopup': 'menu',
          'aria-expanded': expanded === true ? 'true' : 'false',
          title: supported === false ? undefined : text('button.title'),
          'data-dsh-power-trigger': '1',
          onClick,
          ...handlers,
          style: {
            ...styles.trigger,
            width: size,
            height: size,
            background: hovered ? tokens.hover : 'transparent',
            color: hovered ? tokens.labelPrimary : tokens.labelSecondary,
          },
        }, React.createElement(PowerIcon, { size: 16 }))
      }

      /** One row of the popup menu. */
      function MenuItem({ icon, label, hint, onSelect, danger, disabled }) {
        const { hovered, handlers } = useHover()
        return React.createElement('button', {
          type: 'button',
          role: 'menuitem',
          tabIndex: -1,
          disabled: disabled === true,
          'aria-disabled': disabled === true ? 'true' : undefined,
          onClick: disabled === true ? undefined : onSelect,
          ...handlers,
          style: {
            ...styles.menuItem,
            ...(disabled === true ? styles.buttonDisabled : null),
            background: hovered && disabled !== true ? tokens.hover : 'transparent',
            color: danger === true ? tokens.danger : 'inherit',
          },
        },
        React.createElement('span', { style: { ...styles.menuIcon, color: danger === true ? tokens.danger : tokens.labelSecondary } },
          React.createElement(icon, { size: 16 })),
        React.createElement('span', { style: { minWidth: 0 } },
          React.createElement('span', { style: styles.menuLabel }, label),
          hint === undefined ? null : React.createElement('span', { style: styles.menuHint }, hint)))
      }

      /**
       * The overlay: the popup menu, the confirmation dialog and the in-flight
       * notice. It lives in `shell.overlay`, is driven by the trigger's open event,
       * and owns every host call the feature makes.
       */
      function PowerOverlay() {
        useLocaleRevision()
        const [session, setSession] = React.useState(null)
        /** `menu` (popup open) → `confirm` (dialog) → `working` (helper armed). */
        const [phase, setPhase] = React.useState('menu')
        const [action, setAction] = React.useState(null)
        const [info, setInfo] = React.useState(null)
        const [error, setError] = React.useState(null)
        const [requesting, setRequesting] = React.useState(false)
        const menuRef = React.useRef(null)
        const dialogRef = React.useRef(null)
        const sessionRef = React.useRef(null)
        const phaseRef = React.useRef('menu')
        React.useEffect(() => { sessionRef.current = session }, [session])
        React.useEffect(() => { phaseRef.current = phase }, [phase])

        /** Dismiss everything and hand focus back to the button. */
        const close = React.useCallback(() => {
          if (phaseRef.current === 'working') return
          const trigger = sessionRef.current?.trigger
          sessionRef.current = null
          setSession(null)
          setPhase('menu')
          setAction(null)
          setInfo(null)
          setError(null)
          setRequesting(false)
          if (trigger !== null && trigger !== undefined && typeof trigger.focus === 'function') {
            try {
              trigger.focus()
            } catch {
              // focus return is cosmetic
            }
          }
        }, [])
        const closeRef = React.useRef(close)
        React.useEffect(() => { closeRef.current = close }, [close])

        React.useEffect(() => {
          const onOpen = (event) => {
            const detail = event?.detail ?? {}
            const rect = detail.rect
            if (rect === null || typeof rect !== 'object') return
            // A second click on the same button closes the menu instead of restacking it.
            if (sessionRef.current !== null) {
              closeRef.current()
              return
            }
            setSession({ rect, trigger: detail.trigger ?? null })
            setPhase('menu')
            setAction(null)
            setInfo(null)
            setError(null)
            setRequesting(false)
          }
          window.addEventListener(OPEN_EVENT, onOpen)
          return () => window.removeEventListener(OPEN_EVENT, onOpen)
        }, [])

        // Click outside, Escape and a viewport resize all dismiss the popup.
        React.useEffect(() => {
          if (session === null) return undefined
          const onPointerDown = (event) => {
            if (phaseRef.current === 'working') return
            const node = menuRef.current
            if (node !== null && node.contains(event.target)) return
            const trigger = session.trigger
            if (trigger !== null && trigger !== undefined && trigger.contains?.(event.target)) return
            close()
          }
          const onKeyDown = (event) => {
            if (event.key !== 'Escape') return
            if (phaseRef.current === 'confirm') setPhase('menu')
            else close()
          }
          const onResize = () => close()
          document.addEventListener('mousedown', onPointerDown, true)
          document.addEventListener('keydown', onKeyDown, true)
          window.addEventListener('resize', onResize)
          return () => {
            document.removeEventListener('mousedown', onPointerDown, true)
            document.removeEventListener('keydown', onKeyDown, true)
            window.removeEventListener('resize', onResize)
          }
        }, [close, session])

        // Focus the first item so the keyboard walk starts inside the menu.
        React.useEffect(() => {
          if (session === null || phase !== 'menu' || requesting) return
          const node = menuRef.current
          const first = node?.querySelector('[role="menuitem"]:not([disabled])')
          first?.focus?.()
        }, [phase, requesting, session])

        // A host that accepted the action but never died would otherwise leave the
        // notice up forever; after this window the menu comes back so the user can
        // retry or dismiss. If the application really did quit, this never runs.
        React.useEffect(() => {
          if (phase !== 'working') return undefined
          const timer = setTimeout(() => {
            if (phaseRef.current !== 'working') return
            trace('working phase timed out; returning to the menu')
            setPhase('menu')
            setError(text('error.timeout'))
          }, 20_000)
          return () => clearTimeout(timer)
        }, [phase])

        // Tell the trigger whether the popup is open, for `aria-expanded`.
        React.useEffect(() => {
          try {
            window.dispatchEvent(new CustomEvent(STATE_EVENT, { detail: { open: session !== null } }))
          } catch {
            // the attribute is cosmetic
          }
        }, [session])

        // `aria-modal` without moving focus would leave a keyboard user behind the
        // dialog; the cancel button is the safe initial target.
        React.useEffect(() => {
          if (phase !== 'confirm') return
          const node = dialogRef.current
          const first = node?.querySelector('button')
          first?.focus?.()
        }, [phase])

        const move = React.useCallback((delta) => {
          const node = menuRef.current
          if (node === null) return
          const items = [...node.querySelectorAll('[role="menuitem"]:not([disabled])')]
          if (items.length === 0) return
          const index = items.indexOf(document.activeElement)
          const next = (index + delta + items.length) % items.length
          items[next]?.focus?.()
        }, [])

        const execute = React.useCallback(async (nextAction) => {
          setPhase('working')
          setAction(nextAction)
          setError(null)
          setRequesting(false)
          trace(`sending ${nextAction}`)
          const result = await request({ action: nextAction })
          // On success the application is going away: the notice stays up until it does.
          if (result?.ok === true) return
          setPhase('menu')
          setError(result?.error ?? text('error.title'))
          trace(`${nextAction} refused: ${String(result?.error ?? 'unknown')}`)
        }, [])

        const choose = React.useCallback(async (nextAction) => {
          // Remember which menu this belongs to: the popup can be dismissed while
          // the host is answering, and a dismissed menu must never quit the app.
          const owner = sessionRef.current
          setRequesting(true)
          setError(null)
          const described = await request({ action: 'describe' })
          if (owner === null || sessionRef.current !== owner) return
          setRequesting(false)
          if (described?.ok !== true) {
            setError(described?.error ?? text('error.unreachable'))
            return
          }
          if (described.supported !== true) {
            setError(described.mode === 'web'
              ? '当前 DSH 不是桌面端：没有可以关闭的桌面进程，关机/重启只在 DSH 桌面端可用。'
              : `当前环境不受支持：${String(described.reason)}`)
            return
          }
          if (described.activeTasks === true) {
            setAction(nextAction)
            setInfo(described)
            setPhase('confirm')
            return
          }
          await execute(nextAction)
        }, [execute])

        if (session === null) return null

        const rect = session.rect
        const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight
        const viewportWidth = typeof window === 'undefined' ? 0 : window.innerWidth
        const right = Math.max(8, viewportWidth - (typeof rect.right === 'number' ? rect.right : viewportWidth))
        const bottom = Math.max(8, viewportHeight - (typeof rect.top === 'number' ? rect.top : viewportHeight) + 6)

        if (phase === 'working') {
          return React.createElement('div', {
            ref: menuRef,
            style: { ...styles.menu, right, bottom, display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px' },
            role: 'status',
            'aria-live': 'polite',
          },
          React.createElement(PowerIcon, { size: 14 }),
          React.createElement('span', { style: { fontSize: 13 } }, text(`working.${action ?? 'shutdown'}`)))
        }

        if (phase === 'confirm') {
          const described = info ?? {}
          const confirmed = action ?? 'shutdown'
          return React.createElement('div', {
            // The same ref: the outside-click guard must treat the dialog and its
            // backdrop as ours, or a click on a button would dismiss before it fires.
            ref: menuRef,
            style: styles.overlayLayer,
            onMouseDown: (event) => {
              if (event.target === event.currentTarget && phaseRef.current !== 'working') setPhase('menu')
            },
          }, React.createElement('div', {
            role: 'dialog',
            'aria-modal': 'true',
            ref: dialogRef,
            'aria-label': text(`confirm.title.${confirmed}`),
            style: styles.dialog,
            onMouseDown: (event) => event.stopPropagation(),
          },
          React.createElement('div', { style: styles.dialogTitle }, text(`confirm.title.${confirmed}`)),
          React.createElement('div', { style: styles.dialogWarning }, text('confirm.running', {
            agents: described.agents ?? 0,
            queued: described.queuedAgents ?? 0,
            jobs: described.jobs ?? 0,
            scheduled: described.scheduled ?? 0,
          })),
          described.unknown === true
            ? React.createElement('div', { style: styles.dialogWarning }, text('confirm.unknown'))
            : null,
          React.createElement('div', { style: styles.dialogBody }, text(`confirm.body.${confirmed}`)),
          React.createElement('div', { style: styles.card },
            `pid ${String(described.appPid ?? '?')}`,
            React.createElement('br'),
            String(described.appExecutable ?? '')),
          error === null ? null : React.createElement('div', { style: styles.dialogError, role: 'alert' }, error),
          React.createElement('div', { style: styles.footer },
            React.createElement('button', {
              type: 'button',
              style: styles.button,
              onClick: () => setPhase('menu'),
            }, text('confirm.cancel')),
            React.createElement('button', {
              type: 'button',
              style: { ...styles.button, ...styles.buttonDanger },
              onClick: () => { void execute(confirmed) },
            }, text(`confirm.ok.${confirmed}`)))))
        }

        if (error !== null) {
          return React.createElement('div', { ref: menuRef, style: { ...styles.menu, right, bottom, maxWidth: 320 } },
            React.createElement('div', { style: { padding: '6px 8px 8px' } },
              React.createElement('div', { style: { fontWeight: 600, marginBottom: 6 } }, text('error.title')),
              React.createElement('div', { style: { fontSize: 13, color: tokens.labelSecondary, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, error)),
            React.createElement('div', { style: styles.footer },
              React.createElement('button', {
                type: 'button',
                style: styles.button,
                onClick: close,
              }, text('error.close'))))
        }

        return React.createElement('div', {
          ref: menuRef,
          role: 'menu',
          'aria-label': text('button.title'),
          style: { ...styles.menu, right, bottom },
          onKeyDown: (event) => {
            if (event.key === 'ArrowDown') { event.preventDefault(); move(1) }
            else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1) }
          },
        },
        React.createElement(MenuItem, {
          icon: PowerIcon,
          label: text('menu.shutdown'),
          hint: requesting ? text('menu.checking') : text('menu.shutdown.hint'),
          danger: true,
          disabled: requesting,
          onSelect: () => { void choose('shutdown') },
        }),
        React.createElement(MenuItem, {
          icon: RestartIcon,
          label: text('menu.restart'),
          hint: requesting ? text('menu.checking') : text('menu.restart.hint'),
          disabled: requesting,
          onSelect: () => { void choose('restart') },
        }))
      }

      /**
       * Slot occupant of `sidebar.footer.action`: it asks the host once whether the
       * desktop capability exists, then renders the trigger in the account row (or
       * in its own slot when that row cannot be found).
       */
      function PowerEntry(props) {
        useLocaleRevision()
        const [supported, setSupported] = React.useState(null)
        const [expanded, setExpanded] = React.useState(false)
        const target = useAccountRow(supported === true)

        // The overlay owns the popup, so it reports its own visibility back here for
        // the trigger's `aria-expanded`.
        React.useEffect(() => {
          const onState = (event) => setExpanded(event?.detail?.open === true)
          window.addEventListener(STATE_EVENT, onState)
          return () => window.removeEventListener(STATE_EVENT, onState)
        }, [])

        React.useEffect(() => {
          let alive = true
          /**
           * Ask the host once, then retry the transport a couple of times: a page
           * that loaded while the host was still coming up would otherwise hide the
           * button until the next reload.
           * @param remaining - retries left.
           */
          const attempt = async (remaining) => {
            const info = await request({ action: 'describe' })
            if (!alive) return
            if (info?.ok === true) {
              trace(`describe mode=${String(info.mode)} supported=${String(info.supported)} port=${String(info.port)}`)
              setSupported(info.supported === true)
              return
            }
            trace(`describe failed: ${String(info?.error ?? 'unknown')} (retries left ${String(remaining)})`)
            if (remaining <= 0) {
              setSupported(false)
              return
            }
            setTimeout(() => { if (alive) void attempt(remaining - 1) }, 1500)
          }
          void attempt(2)
          return () => { alive = false }
        }, [])

        if (supported !== true) return null

        const wide = props?.wide !== false
        const trigger = React.createElement(PowerTrigger, { wide, supported, expanded })

        if (target?.mode === 'row' && target.node !== null && createPortal !== null) {
          return createPortal(trigger, target.node)
        }
        // Fallback placement: right end of the footer action row, above the account
        // button. The feature survives a shell change; only the exact position moves.
        return React.createElement('div', { style: { display: 'flex', marginLeft: 'auto' } }, trigger)
      }

      /**
       * Adopt the shell's locale service so the dictionary follows the UI language,
       * and register our translations for slot consumers.
       * @param ctx - client plugin context.
       */
      function adoptLocale(ctx) {
        try {
          const locale = ctx.get?.('locale')
          if (locale === undefined) return
          localeService = locale
          if (typeof locale.register === 'function') {
            // Registered as an effect so the dictionary is withdrawn with the plugin,
            // exactly like the shipped sidebar does.
            if (typeof ctx.effect === 'function') ctx.effect(() => locale.register(NS, { zh, en }), 'dsh-plugin-power-button: dictionaries')
            else locale.register(NS, { zh, en })
          }
        } catch {
          // Without the service the bundle falls back to navigator.language.
        }
      }

      /** Install the row stylesheet once per document, owned by the plugin effect. */
      function installRowStyles() {
        if (typeof document === 'undefined') return () => {}
        const existing = [...document.querySelectorAll('style[data-plugin-css]')]
          .find((node) => node.dataset?.pluginCss === STYLE_ID)
        if (existing !== undefined) return () => {}
        const tag = document.createElement('style')
        tag.dataset.plugin = ENTRY_ID
        tag.dataset.pluginCss = STYLE_ID
        tag.textContent = ROW_CSS
        document.head.appendChild(tag)
        return () => { tag.remove() }
      }

      /**
       * Client plugin entry: one trigger in the sidebar foot, one overlay.
       * @param ctx - client plugin context (slots, locale).
       */
      function apply(ctx) {
        adoptLocale(ctx)
        const slots = ctx.get?.('slots')
        if (slots === undefined) return
        ctx.effect?.(installRowStyles, 'dsh-plugin-power-button: row styles')

        slots.inject(SLOT, () => slots.register({
          name: SLOT,
          id: ENTRY_ID,
          order: SLOT_ORDER,
        }, PowerEntry))

        slots.inject(OVERLAY_SLOT, () => slots.register({
          name: OVERLAY_SLOT,
          id: DIALOG_ID,
          order: OVERLAY_ORDER,
        }, PowerOverlay))
      }

      return { apply, inject: ['slots'] }
    },
  })
}
