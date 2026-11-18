// Gives the wallet's real screens (extension/app, the same build the desktop window runs) their way to the Astrala
// app: `window.astrala`, the object the desktop window gets from its preload. Every call goes to the app on
// 127.0.0.1 with the pairing token, and what the app tells its screens comes back down a long poll.
// Keys never come here. Calls about the recovery phrase, backups, or removing the wallet are refused by the app.
(() => {
  // Browser-wallet mode (no Astrala app on this computer). These screens run in a sandboxed frame (app/local.html,
  // inside shell.html): there is no chrome.* here and no storage. Every call is a message to the host page, which
  // passes it to the engine in the background worker; the host also asks for confirmation of payments itself.
  if (new URLSearchParams(location.search).has('local')) {
    // Refuse to run anywhere but inside the sandbox: an opaque origin, framed by the host page. Opened directly, these
    // screens would share the extension's origin and storage, which is exactly what the sandbox exists to prevent.
    if (self.origin !== 'null' || parent === window) { document.documentElement.textContent = 'Astrala: this page only runs inside the wallet window. Open Astrala from the toolbar.'; throw new Error('not sandboxed') }
    // WebRTC talks to servers of the page's choosing and the content policy does not stop it, so it is taken away here,
    // before any of the wallet's code runs: gone for good in this page (not writable, not configurable).
    for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'RTCIceCandidate', 'RTCRtpSender', 'RTCRtpReceiver']) {
      try { Object.defineProperty(window, k, { value: undefined, writable: false, configurable: false }) } catch { /* not present in this browser */ }
    }
    window.__astralaExt = new URLSearchParams(location.search).has('popup') ? 'popup' : 'tab'
    window.__astralaLocal = true
    const HOST = location.protocol + '//' + location.host // the extension's own origin: messages go there and nowhere else
    const host = (msg) => parent.postMessage(msg, HOST)
    const subs = {}, waiting = new Map()
    let seq = 0, listening = false
    addEventListener('message', (e) => {
      if (e.source !== parent || e.origin !== HOST) return
      const m = e.data
      if (!m || typeof m !== 'object') return
      if (m.t === 'event') { for (const cb of subs[m.channel] || []) { try { cb(m.data) } catch (err) { console.error(err) } } return }
      if (m.t !== 'reply') return
      const w = waiting.get(m.id); if (!w) return
      waiting.delete(m.id)
      if ('error' in m) w[1](new Error(m.error)); else w[0](m.result)
    })
    const call = (name) => (...args) => new Promise((ok, no) => { const id = ++seq; waiting.set(id, [ok, no]); host({ t: 'call', id, name, args }) })
    const ua = navigator.userAgent
    const fixed = { platform: /Mac/.test(ua) ? 'darwin' : /Win/.test(ua) ? 'win32' : 'linux',
      copy: async (t) => host({ t: 'host', do: 'copy', text: String(t) }), paste: async () => '',
      relaunch: async () => host({ t: 'host', do: 'reload' }) }
    // the two things the screens used chrome.* or the window for: opening the full wallet in a tab, and outside links
    window.chrome = { tabs: { create: ({ url }) => host({ t: 'host', do: 'open', url }) }, runtime: { getURL: (path) => 'ext:' + path } }
    window.open = (url) => { host({ t: 'host', do: 'open', url: String(url) }); return null }
    window.close = () => host({ t: 'host', do: 'close' })
    window.astrala = new Proxy(fixed, {
      get(t, k) {
        if (typeof k !== 'string' || k === 'then') return undefined
        if (k in t) return t[k]
        if (/^on[A-Z]/.test(k)) return (cb) => {
          const ch = k === 'onWindowState' ? 'winState' : k[2].toLowerCase() + k.slice(3)
          ;(subs[ch] = subs[ch] || new Set()).add(cb)
          if (!listening) { listening = true; host({ t: 'host', do: 'listen' }) }
          return () => subs[ch].delete(cb)
        }
        return (t[k] = call(k))
      }
    })
    return
  }
  const PORTS = [47821, 47822, 47823]
  const popup = new URLSearchParams(location.search).has('popup')
  let port = null, tok = null, leaving = false
  window.__astralaExt = popup ? 'popup' : 'tab'
  const token = async () => tok ?? (tok = (await chrome.storage.local.get('token')).token || null)
  // not reachable or not paired: the small gate page explains and offers to pair, then sends you back here
  const gate = () => { if (!leaving) { leaving = true; location.replace(chrome.runtime.getURL('wallet.html') + (popup ? '' : '#tab')) } return new Promise(() => {}) }
  const send = async (p, path, body) => {
    const r = await fetch(`http://127.0.0.1:${p}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` }, body: JSON.stringify(body) })
    return { status: r.status, json: await r.json().catch(() => ({})) }
  }
  async function post(path, body) {
    for (const p of port ? [port, ...PORTS.filter((x) => x !== port)] : PORTS) {
      try {
        if (p !== port && (await send(p, '/hello', {})).json.astrala !== 1) continue
        const r = await send(p, path, body)
        port = p
        if (r.status === 401) return gate()
        return r.json
      } catch { /* nothing on this port */ }
    }
    port = null
    return null
  }

  // what a call returns when the app says "do this one in the app"
  const IN_APP = { ok: false, error: 'For your safety this is only done in the Astrala app itself.' }
  const DENIED = { revealMnemonic: null, generateMnemonic: '', windowControl: { maximized: false }, discordPresence: 'off', traySummary: undefined, setBadge: undefined, notifyOs: undefined, pickBackup: null }
  const call = (name) => async (...args) => {
    const r = await post('/ipc', { name, args })
    if (!r) return gate()
    if (r.denied) return name in DENIED ? DENIED[name] : IN_APP
    if (r.error) throw new Error(r.error)
    return r.result
  }

  const subs = {}
  let seq = -1, pumping = false
  async function pump() {
    if (pumping) return
    pumping = true
    for (;;) {
      const r = await post('/events', { after: seq }).catch(() => null)
      if (leaving) return
      if (!r || !Array.isArray(r.events)) { await new Promise((ok) => setTimeout(ok, 2000)); continue }
      seq = r.seq
      for (const e of r.events) for (const cb of subs[e.channel] || []) { try { cb(...e.args) } catch (err) { console.error(err) } }
    }
  }
  const ua = navigator.userAgent
  const fixed = { platform: /Mac/.test(ua) ? 'darwin' : /Win/.test(ua) ? 'win32' : 'linux',
    copy: (t) => navigator.clipboard.writeText(String(t)).catch(() => {}), paste: () => navigator.clipboard.readText().catch(() => '') }
  window.astrala = new Proxy(fixed, {
    get(t, k) {
      if (typeof k !== 'string' || k === 'then') return undefined
      if (k in t) return t[k]
      if (/^on[A-Z]/.test(k)) return (cb) => { // onBalance → the 'balance' channel, as the desktop preload wires it
        const ch = k === 'onWindowState' ? 'winState' : k[2].toLowerCase() + k.slice(3)
        ;(subs[ch] = subs[ch] || new Set()).add(cb)
        pump()
        return () => subs[ch].delete(cb)
      }
      return (t[k] = call(k))
    }
  })
})()
