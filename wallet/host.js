// The hosted web wallet's host page (the web twin of extension/shell.js). The wallet's screens (app/local.html) run
// in a sandboxed frame with an opaque origin: no IndexedDB, no storage, no way to reach the engine except through
// this page, so even if a screen were ever tricked into running someone else's code, that code could not read the
// vault or the unlocked key. The engine itself runs in a dedicated worker (engine-worker.js) only this page holds.
//
// This page is the only bridge, and it is small on purpose: no framework, no third-party code, text set with
// textContent only. Two jobs beyond passing calls on:
//   1. It asks. Payments, and anything touching the recovery phrase, the PIN or the limit, are confirmed here, in
//      words the ENGINE writes about what it was actually asked to do.
//   2. It is where secrets are typed and shown. The PIN, the password and the recovery phrase never enter the
//      wallet's screens: the screens ask for "a payment approval" or "unlock", and this page collects what is needed
//      from you and hands it straight to the engine.
// Framed by some other page, the wallet would be drawn under someone else's buttons: refuse to run at all.
if (window.top !== window.self) { document.documentElement.textContent = 'Astrala does not run inside other pages. Open it directly.'; throw new Error('framed') }
const tab = true // a web page is always a full tab
document.body.classList.add('tab')
const el = (tag, props, ...kids) => { const n = document.createElement(tag); Object.assign(n, props || {}); n.append(...kids); return n }

// ---- the engine, in a worker of this page's own. {type:'engine', name, args, id} → {t:'reply', id, result | error}
const worker = new Worker('engine-worker.js', { name: 'astrala-engine' })
const pending = new Map()
let callSeq = 0, listening = false
worker.addEventListener('message', (e) => {
  const m = e.data
  if (!m || typeof m !== 'object') return
  if (m.t === 'event') { if (listening) post({ t: 'event', channel: m.channel, data: m.data }); return }
  if (m.t !== 'reply') return
  const done = pending.get(m.id); if (!done) return
  pending.delete(m.id)
  done('error' in m ? { error: m.error } : { result: m.result })
})
worker.addEventListener('error', () => stop('Astrala could not start its engine in this browser. Reload the page to try again.'))
const engine = (name, args) => new Promise((done) => { const id = ++callSeq; pending.set(id, done); worker.postMessage({ type: 'engine', name, args, id }) })

// ---- the frame: this page frames the sandboxed wallet page and nothing else (frame-src 'self' in index.html)
const LOCAL = new URL('app/local.html', location.href).href
// Loaded once. A second load of the same frame means it navigated or reloaded itself: stop, rather than hand answers
// to whatever is there now. A reload the screens ask for gets a brand new frame with its own count.
const rest = location.hash.replace(/^#(tab)?[#&]*/, '')
const SRC = LOCAL + '?local' + (/^[a-z0-9=&_-]{1,80}$/i.test(rest) ? '#' + rest : '')
let frame = document.getElementById('ui'), stopped = false, parked = false
const post = (msg) => { try { frame.contentWindow.postMessage(msg, '*') } catch { /* the frame is gone */ } }
const stop = (why) => { stopped = true; frame.remove(); box.hidden = true; document.body.append(el('div', { className: 'stopped', textContent: why })) }
const start = () => {
  const f = el('iframe', { id: 'ui', title: 'Astrala wallet' }); f.setAttribute('sandbox', 'allow-scripts')
  let loads = 0
  f.addEventListener('load', () => { if (f === frame && ++loads > 1) stop('Astrala stopped this window because the wallet screen tried to load something else. Close it and open Astrala again.') })
  frame.replaceWith(f); frame = f; parked = false
  f.src = SRC
}
// A frame that has the keyboard reads every key pressed, and nothing here can stop a frame taking the keyboard
// (inert and hidden frames still can: tested). So before a password or a phrase is typed, the screens are shut
// down, and started again afterwards. The PIN is never typed: its pad takes clicks only.
const TYPED = new Set(['password', 'newPassword', 'mnemonic'])
const park = () => { if (parked || stopped) return; parked = true; const d = el('div', { id: 'ui' }); frame.replaceWith(d); frame = d }

// ---- what the engine tells the screens (balances arriving, activity, lock): forwarded once they ask to listen
const listen = () => { if (!stopped) listening = true }

// ---- the secure box: one question at a time, answered only by real clicks and keys on this page
const box = document.getElementById('ask'), sheet = box.querySelector('.sheet'), body = document.getElementById('ask-body')
const yes = document.getElementById('ask-yes'), no = document.getElementById('ask-no'), errLine = document.getElementById('ask-err')
let asking = Promise.resolve()
/**
 * Show one step. kind: 'confirm' (just the words), 'pin', 'newPin', 'password', 'newPassword', 'mnemonic' (type the
 * 24 words), 'show' (display them). Resolves with what was entered (true for confirm/show), or null if cancelled.
 */
const step = (o) => (asking = asking.then(() => new Promise((done) => {
  const title = document.getElementById('ask-title')
  title.textContent = String(o.title).slice(0, 120)
  document.getElementById('ask-text').textContent = String(o.text || '').slice(0, 900)
  errLine.textContent = String(o.error || '').slice(0, 200)
  sheet.classList.toggle('danger', !!o.danger)
  body.replaceChildren()
  yes.textContent = String(o.yes || 'Continue').slice(0, 30); yes.hidden = false; yes.disabled = false
  box.hidden = false
  frame.inert = true // no clicks reach the screens while the box is up (keys are another matter: see park)
  const armed = Date.now() + 500 // a click or key already on its way must not land on the answer
  let value = () => true, focus = no, digit = null
  const end = (v) => { box.hidden = true; frame.inert = false; yes.onclick = no.onclick = null; document.removeEventListener('keydown', key); body.replaceChildren(); done(v) }
  const submit = () => { if (yes.disabled || yes.hidden) return; const v = value(); if (v != null) end(v) }
  const say = (t) => { errLine.textContent = t }
  const input = (ph) => el('input', { className: 'in', type: 'password', placeholder: ph, autocomplete: 'off', spellcheck: false })

  if (o.kind === 'pin' || o.kind === 'newPin') {
    // six digits, clicked on the pad (never typed: see park); sent when the sixth lands. A new PIN is entered twice.
    let digits = '', first = null
    const dots = el('div', { className: 'dots' }, ...Array.from({ length: 6 }, () => el('i')))
    const paint = () => [...dots.children].forEach((d, i) => d.classList.toggle('on', i < digits.length))
    digit = (c) => {
      if (Date.now() < armed) return
      digits = c === 'back' ? digits.slice(0, -1) : (digits + c).slice(0, 6); paint(); say('')
      if (digits.length < 6) return
      if (o.kind === 'pin') return end(digits)
      if (/^(\d)\1{5}$/.test(digits) || '0123456789'.includes(digits) || '9876543210'.includes(digits)) { digits = ''; paint(); return say('Too easy to guess. Avoid repeats and runs like 123456.') }
      if (first == null) { first = digits; digits = ''; paint(); title.textContent = 'Enter it once more'; return }
      if (digits !== first) { first = null; digits = ''; paint(); title.textContent = String(o.title).slice(0, 120); return say("Those didn't match. Choose your PIN again.") }
      end(digits)
    }
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'back'].map((k) => (k === '' ? el('span') : el('button', { type: 'button', className: k === 'back' ? 'quiet' : '', textContent: k === 'back' ? 'Delete' : k, onclick: (e) => { if (e.isTrusted) digit(k) } })))
    body.append(dots, el('div', { className: 'pad' }, ...keys), el('p', { className: 'hint', textContent: 'Click the numbers. Typing is off here, so nothing else can read your PIN.' })); yes.hidden = true
  } else if (o.kind === 'password') {
    const a = input('Wallet password'); body.append(a); focus = a
    value = () => (a.value ? a.value : (say('Enter your password'), null))
  } else if (o.kind === 'newPassword') {
    const a = input('Password (10 characters or more)'), b = input('The same password again')
    body.append(a, b, el('p', { className: 'hint', textContent: "It encrypts your wallet in this browser. It can't be reset: if you forget it, you restore from the recovery phrase." })); focus = a
    value = () => (a.value.length < 10 ? (say('Use at least 10 characters'), null) : a.value !== b.value ? (say("Those don't match"), null) : a.value)
  } else if (o.kind === 'mnemonic') {
    const a = el('textarea', { className: 'in', placeholder: 'Your 24 words, separated by spaces', spellcheck: false, autocomplete: 'off' }); body.append(a); focus = a
    value = () => { const w = a.value.trim().toLowerCase().split(/\s+/).filter(Boolean); return w.length === 24 ? w.join(' ') : (say(`That is ${w.length} ${w.length === 1 ? 'word' : 'words'}; a recovery phrase has 24`), null) }
  } else if (o.kind === 'show') {
    body.append(el('div', { className: 'words' }, ...o.words.slice(0, 24).map((w) => el('span', { textContent: String(w).slice(0, 12) }))))
    if (o.wait) { yes.disabled = true; setTimeout(() => { yes.disabled = false }, 4000) } // long enough to at least see them
  }
  const key = (e) => {
    if (!e.isTrusted) return
    if (e.key === 'Escape') return end(null)
    if (digit) return
    if (e.key === 'Enter' && (e.target.tagName === 'INPUT' || (e.target.tagName === 'TEXTAREA' && (e.metaKey || e.ctrlKey)))) { e.preventDefault(); if (Date.now() >= armed) submit() }
  }
  yes.onclick = (e) => { if (e.isTrusted && Date.now() >= armed) submit() }
  no.onclick = () => end(null)
  document.addEventListener('keydown', key)
  focus.focus() // Cancel has the keyboard unless there is something to type
})))

// ---- calls from the screens
/** These never go to the engine by name: the engine prepares them (says what to ask and what it needs), and runs only what it stored. */
const GATED = new Set(['verifyPin', 'setPin', 'setLimit', 'revealMnemonic', 'resetWallet', 'createVault'])
const NEVER = new Set(['prepare', 'confirmed', 'discard']) // the screens cannot take any of those steps themselves
/** What a refused or cancelled call answers, in the shape the screens expect. */
const refused = (name, why) => (name === 'revealMnemonic' ? { result: null } : name === 'resetWallet' ? { result: false } : name === 'createVault' ? { error: why } : { result: { ok: false, error: why } })
const TITLE = { pin: 'Enter your payment PIN', newPin: 'Choose a payment PIN', password: 'Enter your wallet password', newPassword: 'Set a password', mnemonic: 'Enter your recovery phrase', show: 'Write these 24 words down' }
/** Was that a wrong PIN or password that can simply be tried again here? Returns the line to show, or null. */
const retry = (name, r) => {
  if (!r || 'error' in r) return null
  const v = r.result
  if (name === 'revealMnemonic' && v === null) return 'Wrong password'
  if (name === 'resetWallet' && v === false) return 'Wrong password'
  if (v && v.ok === false && !v.lockedUntil && !v.appLocked && (v.error === 'Wrong PIN' || v.error === 'Wrong password')) return v.remaining != null && v.remaining <= 3 ? `${v.error} · ${v.remaining} ${v.remaining === 1 ? 'try' : 'tries'} left before payments pause` : v.error
  return null
}
/** What the screens may say about a guarded call: never a secret. Anything else they send is dropped, so a PIN,
 *  password or phrase can only come from this page's own boxes. */
const scrub = (name, args) => {
  const o = args[0] && typeof args[0] === 'object' ? args[0] : {}
  if (name === 'verifyPin') return ['', args[1], !!args[2]]
  if (name === 'setLimit') return [{ amount: o.amount == null ? null : Number(o.amount) }]
  if (name === 'createVault') return [{ mode: o.mode === 'restore' ? 'restore' : 'create', name: typeof o.name === 'string' ? o.name.slice(0, 40) : undefined, birthday: Number(o.birthday) > 0 ? Number(o.birthday) : undefined }]
  return name === 'setPin' ? [{}] : [] // revealMnemonic, resetWallet
}
/** One guarded call, start to finish. Returns what to answer the screens (null: nothing, the frame was replaced). */
async function guardedCall(name, args) {
  try { return await guarded1(name, args) } finally { if (parked) start() }
}
async function guarded1(name, args) {
  let error = ''
  for (;;) {
    const p = await engine('prepare', [name, scrub(name, args)])
    const d = p && !('error' in p) ? p.result : null
    if (!d || typeof d.ticket !== 'string') return refused(name, (d && d.refuse) || (p && p.error) || 'Refused') // anything but a clear go-ahead means no
    const need = Array.isArray(d.need) ? d.need.filter((k) => k in TITLE) : [], given = {}
    // a new wallet's words are shown first; then each thing the engine needs is asked for, with the question's own words on the first box
    if (need.some((k) => TYPED.has(k))) park()
    const steps = [...(Array.isArray(d.show) ? [{ kind: 'show', words: d.show, wait: true, yes: "I've written them down", text: 'In order, on paper. They are the only way back into this wallet, and anyone who has them can take everything in it.' }] : []), ...need.map((kind) => ({ kind }))]
    if (!steps.length && d.ask) steps.push({ kind: 'confirm' })
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i], first = i === 0 && d.ask ? d.ask : null
      const v = await step({ ...s, title: first ? first.title : TITLE[s.kind], text: first ? first.text : s.text, danger: !!(first && first.danger), yes: s.yes || (s.kind === 'confirm' && first ? first.yes : 'Continue'), error: i === 0 ? error : '' })
      if (v == null) { engine('discard', [d.ticket]).catch(() => {}); return refused(name, 'Cancelled') }
      if (s.kind !== 'confirm' && s.kind !== 'show') given[s.kind] = v
    }
    const r = await engine('confirmed', [d.ticket, given])
    error = retry(name, r) || ''
    if (error && need.length) continue // a wrong PIN or password: ask again, here
    if (r && !('error' in r)) {
      // the phrase is shown here; the screens only learn that it was
      if (name === 'revealMnemonic' && typeof r.result === 'string') { await step({ kind: 'show', title: 'Your recovery phrase', words: r.result.split(' '), yes: 'Done', text: 'Never type these into a website or send them to anyone.' }); return { result: true } }
      if (name === 'createVault') await guarded1('setPin', [{}]) // the new wallet's PIN, chosen here before the screens come back
    }
    return r && 'error' in r ? { error: String(r.error) } : { result: r ? r.result : undefined }
  }
}
/** Unlock: the password is asked for here, whatever the screens sent. */
async function unlockHere() {
  park()
  try { return await unlock1() } finally { start() }
}
async function unlock1() {
  let error = ''
  for (;;) {
    const pw = await step({ kind: 'password', title: 'Unlock Astrala', yes: 'Unlock', error })
    if (pw == null) return { result: false }
    const r = await engine('unlock', [pw])
    if (r && r.result === true) return { result: true }
    error = 'Wrong password. After a few wrong tries there is a short wait.'
  }
}

// Links out: block explorers only, from a fixed list. The screens cannot open an address of their choosing
// (that would be a way to send data out), and a tab opens only on a real click, at most one a second.
const EXPLORERS = ['etherscan.io', 'arbiscan.io', 'basescan.org', 'optimistic.etherscan.io', 'polygonscan.com', 'bscscan.com', 'snowtrace.io', 'solscan.io', 'mempool.space', 'litecoinspace.org', 'blockchair.com', 'tronscan.org']
let lastTab = 0
const openTab = (url) => {
  if (!navigator.userActivation || !navigator.userActivation.isActive || Date.now() - lastTab < 1000) return
  const u = String(url)
  let to = null
  if (u.startsWith('ext:app/')) return // "open the full wallet in a tab": this already is the full wallet
  const m = /^https:\/\/([a-z0-9.]+)\/(?:#\/)?(?:[a-z]+\/){1,2}([0-9A-Za-z]{20,100})$/.exec(u)
  if (m && EXPLORERS.includes(m[1])) to = u
  if (to) { lastTab = Date.now(); window.open(to, '_blank', 'noopener,noreferrer') }
}
let inFlight = 0, guarded = 0 // a flood of calls from the screens is dropped, not queued; guarded ones wait a few at a time
addEventListener('message', async (e) => {
  if (stopped || e.source !== frame.contentWindow) return // only the wallet's own frame is ever listened to
  const m = e.data
  if (!m || typeof m !== 'object') return
  if (m.t === 'host') {
    if (m.do === 'open') openTab(m.url)
    else if (m.do === 'copy') navigator.clipboard.writeText(String(m.text).slice(0, 4000)).catch(() => {})
    else if (m.do === 'reload') start()
    else if (m.do === 'listen') listen()
    else if (m.do === 'close' && !tab) window.close()
    return
  }
  if (m.t !== 'call' || typeof m.name !== 'string' || !Number.isSafeInteger(m.id)) return
  const src = e.source, reply = (r) => { if (r && src === frame.contentWindow) post({ t: 'reply', id: m.id, ...r }) }
  if (NEVER.has(m.name)) return reply({ error: 'refused' })
  if (inFlight >= 60) return reply({ error: 'Too many requests at once' })
  inFlight++
  const args = Array.isArray(m.args) ? m.args : []
  try {
    if (!GATED.has(m.name) && m.name !== 'unlock') { const r = await engine(m.name, args); return reply(r && 'error' in r ? { error: String(r.error) } : { result: r ? r.result : undefined }) }
    if (guarded >= 3) return reply(m.name === 'unlock' ? { result: false } : refused(m.name, 'Finish the question already on screen first'))
    guarded++
    try { reply(m.name === 'unlock' ? await unlockHere() : await guardedCall(m.name, args)) } finally { guarded-- }
  } catch (err) { reply({ error: String(err && err.message || err).slice(0, 200) }) }
  finally { inFlight-- }
})
start()
