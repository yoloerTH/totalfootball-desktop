// Total Football Studio for Mac and Windows.
//
// A thin shell over the live web studio (totalfootball-web docs/DESKTOP.md). The
// studio is not bundled: every deploy of the site is the app's new version. What
// lives here is only what a website cannot do on its own: the window, the menu,
// sign-in through the system browser, Save dialogs, .tfs files, mic permission,
// an offline screen and shell updates.
import {
  app, BrowserWindow, Menu, clipboard, dialog, ipcMain, screen, session, shell, systemPreferences,
  type MenuItemConstructorOptions, type WebContents,
} from 'electron'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkForUpdatesByHand, initUpdates } from './updates'

const SITE = 'https://totalfootballstudio.com'
const START_URL = process.env.TF_START_URL || `${SITE}/studio/portal/`
const SCHEME = 'ai.naurra.totalfootball.desktop'
const SUPABASE_HOST = 'bewvowkkikxsjcfnkeot.supabase.co'
const IS_MAC = process.platform === 'darwin'
const PROBE = process.argv.includes('--probe')
/** A board file is a few hundred KB; a backup of a big shelf a few MB. */
const MAX_FILE_BYTES = 50 * 1024 * 1024
const FILE_EXTS = new Set(['.tfs'])

// ─── hosts ────────────────────────────────────────────────────────────────────

const OWN_HOSTS = new Set(['totalfootballstudio.com', 'www.totalfootballstudio.com'])
const start = new URL(START_URL)
const isLocal = (u: URL) => u.hostname === 'localhost' || u.hostname === '127.0.0.1'
/** Our pages stay in the window. A dev server only when TF_START_URL points at one. */
const isOwn = (u: URL) => (u.protocol === 'https:' && OWN_HOSTS.has(u.hostname)) || (isLocal(u) && u.host === start.host)
/** Stripe's frames are inside our page; its 3-D Secure and bank steps may take the top frame and come back. */
const isStripe = (u: URL) =>
  u.protocol === 'https:' && (u.hostname === 'stripe.com' || u.hostname.endsWith('.stripe.com') || u.hostname.endsWith('.stripe.network'))
const parse = (s: string): URL | null => { try { return new URL(s) } catch { return null } }
const offlinePage = () => join(__dirname, 'offline.html')

function openOutside(url: string) {
  const u = parse(url)
  if (u && (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:')) void shell.openExternal(u.toString())
}

// ─── small persistent things in userData ──────────────────────────────────────

const userFile = (name: string) => join(app.getPath('userData'), name)
const logFile = () => userFile('desktop.log')

function log(...parts: unknown[]) {
  const line = `${new Date().toISOString()} ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}`
  if (!app.isPackaged) console.log(line)
  try {
    const f = logFile()
    // Keep it small: start over past 1 MB.
    if ((statSync(f, { throwIfNoEntry: false })?.size ?? 0) > 1024 * 1024) writeFileSync(f, '')
    appendFileSync(f, line + '\n')
  } catch { /* userData not there yet */ }
}

/** A random id per install, for the device list (docs/DESKTOP.md §11). Not a fingerprint. */
function installId(): string {
  try {
    const id = readFileSync(userFile('install-id'), 'utf8').trim()
    if (/^[0-9a-f-]{36}$/.test(id)) return id
  } catch { /* first run */ }
  const id = randomUUID()
  writeFileSync(userFile('install-id'), id)
  return id
}

/** What the coach calls this computer: "Thanos's MacBook Pro", "DESKTOP-4F2K". */
function deviceName(): string {
  if (IS_MAC) {
    try { return execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2000 }).trim().slice(0, 80) } catch { /* fall through */ }
  }
  return hostname().replace(/\.local$/, '').slice(0, 80) || (IS_MAC ? 'Mac' : 'Windows PC')
}

interface Bounds { x: number; y: number; width: number; height: number; maximized?: boolean }

function savedBounds(): Bounds | null {
  try {
    const b = JSON.parse(readFileSync(userFile('window.json'), 'utf8')) as Bounds
    if (![b.x, b.y, b.width, b.height].every(Number.isFinite)) return null
    // Only if it still lands on a screen that exists (an unplugged monitor would hide it).
    const area = screen.getDisplayMatching(b).workArea
    const visible = b.x < area.x + area.width - 100 && b.x + b.width > area.x + 100 && b.y >= area.y - 10 && b.y < area.y + area.height - 100
    return visible ? b : null
  } catch { return null }
}

function keepBounds(w: BrowserWindow) {
  let t: NodeJS.Timeout | undefined
  const save = () => {
    clearTimeout(t)
    t = setTimeout(() => {
      if (w.isDestroyed() || w.isMinimized() || w.isFullScreen()) return
      try { writeFileSync(userFile('window.json'), JSON.stringify({ ...w.getNormalBounds(), maximized: w.isMaximized() })) } catch { /* read-only disk */ }
    }, 400)
  }
  w.on('resize', save)
  w.on('move', save)
  w.on('maximize', save)
  w.on('unmaximize', save)
}

// ─── the window ───────────────────────────────────────────────────────────────

let win: BrowserWindow | null = null
let info: { version: string; platform: 'mac' | 'windows'; installId: string; deviceName: string }

const webPreferences = () => ({
  preload: join(__dirname, 'preload.js'),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
  spellcheck: true,
})

function createWindow(): BrowserWindow {
  const b = savedBounds()
  const w = new BrowserWindow({
    ...(b ? { x: b.x, y: b.y, width: b.width, height: b.height } : { width: 1440, height: 900 }),
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'Total Football Studio',
    backgroundColor: '#F4F4F2',
    webPreferences: webPreferences(),
  })
  if (b?.maximized) w.maximize()
  w.once('ready-to-show', () => w.show())
  keepBounds(w)
  guard(w.webContents)
  w.on('closed', () => { if (win === w) win = null })
  void w.loadURL(START_URL)
  return w
}

function focus(): BrowserWindow {
  if (!win || win.isDestroyed()) win = createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  return win
}

/** Chromium net errors that mean "could not reach the site", not "the page said no". */
const NETWORK_ERRORS = new Set([-2, -7, -21, -100, -101, -102, -104, -105, -106, -109, -118, -130, -137, -138, -324])

function guard(wc: WebContents) {
  wc.on('will-navigate', (e, url) => {
    const u = parse(url)
    if (!u) return e.preventDefault()
    if (isOwn(u) || isStripe(u)) return
    if (u.protocol === 'file:' && url.split('?')[0] === pathToFileURL(offlinePage()).href) return
    e.preventDefault()
    openOutside(url)
  })
  // A server redirect away from us (to Google, say) gets the same rule.
  wc.on('will-redirect', (e, url, _inPlace, isMain) => {
    const u = parse(url)
    if (!isMain || !u || isOwn(u) || isStripe(u)) return
    e.preventDefault()
    openOutside(url)
  })
  wc.setWindowOpenHandler(({ url }) => {
    const u = parse(url)
    if (u && (isOwn(u) || isStripe(u))) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 1200, height: 820, backgroundColor: '#F4F4F2', webPreferences: webPreferences() } }
    }
    openOutside(url)
    return { action: 'deny' }
  })
  wc.on('did-create-window', (child) => guard(child.webContents))

  wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (!isMain || !NETWORK_ERRORS.has(code)) return
    log('offline', code, desc, url)
    const back = parse(url)
    void wc.loadFile(offlinePage(), { query: { url: back && isOwn(back) ? back.toString() : START_URL } })
  })

  // No right-click menu comes for free in Electron; this is the browser's.
  wc.on('context-menu', (_e, p) => {
    const items: MenuItemConstructorOptions[] = []
    if (p.misspelledWord) {
      for (const s of p.dictionarySuggestions.slice(0, 4)) items.push({ label: s, click: () => wc.replaceMisspelling(s) })
      if (items.length) items.push({ type: 'separator' })
    }
    if (p.isEditable) {
      items.push(
        { role: 'cut', enabled: p.editFlags.canCut }, { role: 'copy', enabled: p.editFlags.canCopy },
        { role: 'paste', enabled: p.editFlags.canPaste }, { type: 'separator' }, { role: 'selectAll' },
      )
    } else if (p.selectionText.trim()) items.push({ role: 'copy' })
    if (p.linkURL && /^https?:/.test(p.linkURL)) {
      if (items.length) items.push({ type: 'separator' })
      items.push({ label: 'Open link in browser', click: () => openOutside(p.linkURL) }, { label: 'Copy link', click: () => clipboard.writeText(p.linkURL) })
    }
    if (!app.isPackaged) items.push({ type: 'separator' }, { label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) })
    if (items.length) Menu.buildFromTemplate(items).popup()
  })
}

// ─── session: user agent, permissions, downloads ──────────────────────────────

/** Chrome's UA, minus Electron's tokens, plus ours (the site reads it for attribution). */
function userAgent(): string {
  const base = session.defaultSession.getUserAgent()
    .replace(/\sElectron\/\S+/, '')
    .replace(new RegExp(`\\s${app.getName().replace(/\s/g, '')}\\/\\S+`), '')
  return `${base} TotalFootballDesktop/${app.getVersion()}`
}

let probing = false

function sessionSetup() {
  const ses = session.defaultSession
  const ua = userAgent()
  ses.setUserAgent(ua)
  app.userAgentFallback = ua

  const ownOrigin = (s: string) => { const u = parse(s); return !!u && isOwn(u) }
  // Microphone for Team Talk, clipboard writes, fullscreen. Nothing else, for no one else.
  ses.setPermissionRequestHandler(async (_wc, permission, callback, details) => {
    if (!ownOrigin(details.requestingUrl)) return callback(false)
    if (permission === 'clipboard-sanitized-write' || permission === 'fullscreen') return callback(true)
    const types = (details as { mediaTypes?: string[] }).mediaTypes ?? []
    if (permission !== 'media' || !types.length || !types.every((t) => t === 'audio')) return callback(false)
    // macOS asks once per app; the answer then lives in System Settings > Privacy > Microphone.
    const ok = IS_MAC ? await systemPreferences.askForMediaAccess('microphone') : true
    if (!ok) log('mic refused by the OS')
    callback(ok)
  })
  ses.setPermissionCheckHandler((_wc, permission, origin) =>
    ownOrigin(origin) && (permission === 'media' || permission === 'clipboard-sanitized-write' || permission === 'fullscreen'))

  // Every download on the site is a blob + <a download> (image.ts, video.ts,
  // transfer.ts, Whiteboard.tsx); here each becomes a native Save dialog.
  ses.on('will-download', (_e, item) => {
    const name = item.getFilename()
    if (probing) item.setSavePath(join(app.getPath('downloads'), name))
    else item.setSaveDialogOptions({ defaultPath: join(app.getPath('downloads'), name) })
    item.once('done', (_ev, state) => log('download', state, extname(name), item.getMimeType()))
  })
}

// ─── sign-in callback and opened files: held until the page listens ───────────

type AuthResult = { code: string } | { error: string }
let pendingAuth: AuthResult | null = null
const pendingFiles: { name: string; bytes: Uint8Array }[] = []
const listening = { auth: new Set<number>(), files: new Set<number>() }

function flush() {
  const w = win
  if (!w || w.isDestroyed()) return
  const id = w.webContents.id
  if (pendingAuth && listening.auth.has(id)) { w.webContents.send('tf:auth-callback', pendingAuth); pendingAuth = null }
  if (pendingFiles.length && listening.files.has(id)) for (const f of pendingFiles.splice(0)) w.webContents.send('tf:open-file', f)
}

/** Only `<scheme>://auth-callback?code=…` (or Supabase's error) is accepted. */
function handleSchemeUrl(raw: string) {
  const u = parse(raw)
  if (!u || u.protocol !== `${SCHEME}:`) return
  if (u.hostname !== 'auth-callback' && u.pathname.replace(/^\/+/, '') !== 'auth-callback') return
  // PKCE codes come in the query; Supabase may put errors in either part.
  const q = new URLSearchParams(u.search)
  const h = new URLSearchParams(u.hash.replace(/^#/, ''))
  const code = q.get('code')
  const error = q.get('error_description') || q.get('error') || h.get('error_description') || h.get('error')
  if (code && /^[\w-]{8,200}$/.test(code)) pendingAuth = { code }
  else if (error) pendingAuth = { error: error.slice(0, 300) }
  else return
  focus()
  flush()
}

function handleFile(path: string) {
  if (!FILE_EXTS.has(extname(path).toLowerCase())) return
  try {
    if (statSync(path).size > MAX_FILE_BYTES) return void dialog.showErrorBox('File too big', `${basename(path)} is too large to be a board file.`)
    pendingFiles.push({ name: basename(path), bytes: new Uint8Array(readFileSync(path)) })
  } catch (e) {
    log('open-file failed', String(e))
    return
  }
  const w = focus()
  // The portal is the page that imports. Anywhere else, go there; it asks for the file when it mounts.
  if (!listening.files.has(w.webContents.id)) void w.loadURL(new URL('/studio/portal/', START_URL).toString())
  flush()
}

/** Windows passes scheme URLs and files as arguments to a new process. */
function handleArgv(argv: string[]) {
  for (const a of argv.slice(1)) {
    if (a.startsWith(`${SCHEME}:`)) handleSchemeUrl(a)
    else if (!a.startsWith('-') && FILE_EXTS.has(extname(a).toLowerCase())) handleFile(a)
  }
}

function ipc() {
  ipcMain.on('tf:info', (e) => { e.returnValue = info })
  ipcMain.on('tf:listen', (e, what: unknown) => {
    if (what !== 'auth' && what !== 'files') return
    listening[what].add(e.sender.id)
    flush()
  })
  ipcMain.handle('tf:sign-in', async (e, url: unknown) => {
    const from = parse(e.senderFrame?.url ?? '')
    const u = typeof url === 'string' ? parse(url) : null
    // Only our own page may ask, and only for our Supabase project's authorize endpoint.
    if (!from || !isOwn(from)) throw new Error('not allowed')
    if (!u || u.protocol !== 'https:' || u.hostname !== SUPABASE_HOST || u.pathname !== '/auth/v1/authorize') throw new Error('not a sign-in address')
    if (u.searchParams.get('redirect_to') !== `${SCHEME}://auth-callback`) throw new Error('wrong callback')
    await shell.openExternal(u.toString())
  })
}

// A page load starts over: whatever listened before is gone.
app.on('web-contents-created', (_e, wc) => {
  const forget = () => { listening.auth.delete(wc.id); listening.files.delete(wc.id) }
  wc.on('did-start-navigation', (d) => { if (d.isMainFrame && !d.isSameDocument) forget() })
  wc.once('destroyed', forget)
})

// ─── menu ─────────────────────────────────────────────────────────────────────

function menu() {
  const go = (path: string) => () => void focus().loadURL(new URL(path, START_URL).toString())
  const updates = { label: 'Check for Updates…', click: () => checkForUpdatesByHand(log) }
  const template: MenuItemConstructorOptions[] = [
    IS_MAC
      ? {
          label: app.name,
          submenu: [
            { role: 'about' }, updates,
            { type: 'separator' }, { label: 'Settings…', accelerator: 'Cmd+,', click: go('/studio/settings/') },
            { type: 'separator' }, { role: 'services' }, { type: 'separator' },
            { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
          ],
        }
      : { label: 'File', submenu: [{ label: 'Settings', accelerator: 'Ctrl+,', click: go('/studio/settings/') }, { type: 'separator' }, { role: 'quit' }] },
    // macOS needs an Edit menu or Cmd+C/V/Z silently do nothing.
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Your Systems', accelerator: 'CmdOrCtrl+Shift+H', click: go('/studio/portal/') },
        { label: 'Back', accelerator: IS_MAC ? 'Cmd+[' : 'Alt+Left', click: () => focus().webContents.navigationHistory.goBack() },
        { label: 'Forward', accelerator: IS_MAC ? 'Cmd+]' : 'Alt+Right', click: () => focus().webContents.navigationHistory.goForward() },
        { type: 'separator' },
        { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' } as MenuItemConstructorOptions]),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Guides', click: () => openOutside(`${SITE}/guides/`) },
        { label: 'Questions', click: () => openOutside(`${SITE}/faq/`) },
        { label: 'Contact Us', click: () => openOutside(`${SITE}/contact/`) },
        { type: 'separator' },
        ...(IS_MAC ? [] : [updates]),
        { label: 'Check Video Export', click: () => void runProbe(false) },
        { label: 'Show Log File', click: () => shell.showItemInFolder(logFile()) },
        ...(IS_MAC ? [] : [{ type: 'separator' } as MenuItemConstructorOptions, { label: `About Total Football Studio ${app.getVersion()}`, click: () => app.showAboutPanel() }]),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ─── video export check (the P0 probe, kept as a support tool) ────────────────
// Asks what videoRender.ts asks before an export and writes a real 2 s MP4 to Downloads.

interface ProbeReport { video: Record<string, string | null>; audio: Record<string, string | null>; recorder: Record<string, boolean>; error: string | null }

async function runProbe(quit: boolean) {
  probing = true
  const w = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } })
  let report: ProbeReport
  try {
    await w.loadFile(join(__dirname, 'probe', 'probe.html'))
    report = await w.webContents.executeJavaScript(
      `new Promise((r) => { const t = setInterval(() => { if (window.__report) { clearInterval(t); r(window.__report) } }, 100) })`,
    )
    await new Promise((r) => setTimeout(r, 1500)) // let the download land
  } finally {
    probing = false
    w.destroy()
  }
  log('video check', report)
  if (quit) { console.log(JSON.stringify(report, null, 2)); return app.quit() }
  const mp4 = Object.values(report.video).every((c) => c === 'avc') && Object.values(report.audio).every((c) => c === 'aac')
  const mic = Object.entries(report.recorder).find(([, ok]) => ok)?.[0] ?? 'none'
  await dialog.showMessageBox({
    type: mp4 && !report.error ? 'info' : 'warning',
    message: mp4 && !report.error ? 'Video export works: MP4 (H.264 + AAC)' : 'Video export would fall back to WebM or fail',
    detail: `Video: ${JSON.stringify(report.video)}\nAudio: ${JSON.stringify(report.audio)}\nTeam Talk recorder: ${mic}\n${report.error ? `Error: ${report.error}\n` : ''}\nA test file, tf-desktop-probe.mp4, is in Downloads.\nLog: ${logFile()}`,
  })
}

// ─── lifecycle ────────────────────────────────────────────────────────────────

// macOS hands over files and URLs through events, possibly before 'ready'.
app.on('will-finish-launching', () => {
  app.on('open-file', (e, path) => { e.preventDefault(); void app.whenReady().then(() => handleFile(path)) })
  app.on('open-url', (e, url) => { e.preventDefault(); void app.whenReady().then(() => handleSchemeUrl(url)) })
})

if (!PROBE && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => { focus(); handleArgv(argv) })

  // In development the scheme must point at this electron + this folder.
  if (process.defaultApp && process.argv[1]) app.setAsDefaultProtocolClient(SCHEME, process.execPath, [resolve(process.argv[1])])
  else app.setAsDefaultProtocolClient(SCHEME)
  if (process.platform === 'win32') app.setAppUserModelId('ai.naurra.totalfootball.desktop')

  app.setAboutPanelOptions({
    applicationName: 'Total Football Studio',
    applicationVersion: app.getVersion(),
    copyright: '© Naurra',
    website: SITE,
  })

  void app.whenReady().then(() => {
    info = { version: app.getVersion(), platform: IS_MAC ? 'mac' : 'windows', installId: installId(), deviceName: deviceName() }
    // Packaged builds get the icon from electron-builder; this covers `npm start`.
    if (IS_MAC && !app.isPackaged) app.dock?.setIcon(join(__dirname, '..', 'build', 'icon.png'))
    sessionSetup()
    ipc()
    menu()
    log('start', { version: info.version, electron: process.versions.electron, url: START_URL })
    if (PROBE) return void runProbe(true)
    win = createWindow()
    // In development argv[1] is the app folder, not a file; handleArgv skips anything that is not .tfs or our scheme.
    handleArgv(process.argv)
    initUpdates(log)
  })

  app.on('activate', () => { if (!PROBE && app.isReady()) focus() })
  app.on('window-all-closed', () => { if (!IS_MAC) app.quit() })
}
