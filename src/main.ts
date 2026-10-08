// Total Football Studio desktop shell. P0 spike: a window on the live studio with
// just enough of the shell (UA, Edit menu, mic permission, Save dialog, navigation
// guard) to run the four checks in docs/DESKTOP.md §9. Every check event is logged
// to the terminal and to spike.log in userData, so a Windows run can be sent back.
import {
  app, BrowserWindow, Menu, dialog, ipcMain, session, shell, systemPreferences,
  type MenuItemConstructorOptions, type WebContents,
} from 'electron'
import { appendFileSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

const LIVE = 'https://totalfootballstudio.com/studio/portal/'
const START_URL = process.env.TF_START_URL || LIVE
const PROBE = process.argv.includes('--probe')
const IS_MAC = process.platform === 'darwin'

// Our own pages stay in the window. localhost only when pointed at a dev server.
const OWN_HOSTS = new Set(['totalfootballstudio.com', 'www.totalfootballstudio.com'])
const devHost = new URL(START_URL).host
const isOwn = (u: URL) =>
  OWN_HOSTS.has(u.hostname) || (u.host === devHost && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))
// Stripe runs in iframes inside our page; a 3-D Secure or bank step may navigate
// the top frame to Stripe and back to our return_url. Logged so P0 shows whether it happens.
const isStripe = (u: URL) => u.hostname === 'stripe.com' || u.hostname.endsWith('.stripe.com') || u.hostname.endsWith('.stripe.network')

const logFile = () => join(app.getPath('userData'), 'spike.log')
function log(...parts: unknown[]) {
  const line = `${new Date().toISOString()} ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}`
  console.log(line)
  try { appendFileSync(logFile(), line + '\n') } catch { /* userData not ready yet */ }
}

/** Chrome's UA without the Electron and app tokens, plus ours (the web reads it for attribution). */
function userAgent(): string {
  const base = session.defaultSession.getUserAgent()
    .replace(/\sElectron\/\S+/, '')
    // Electron also inserts `<AppName without spaces>/<version>`.
    .replace(new RegExp(`\\s${app.getName().replace(/\s/g, '')}\\/\\S+`), '')
  return `${base} TotalFootballDesktop/${app.getVersion()}`
}

function menu() {
  const template: MenuItemConstructorOptions[] = [
    ...(IS_MAC ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : [{ role: 'fileMenu' } as MenuItemConstructorOptions]),
    // macOS needs an Edit menu or Cmd+C/V/Z silently do nothing.
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
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
        { label: 'Contact us', click: () => shell.openExternal('https://totalfootballstudio.com/contact/') },
        { type: 'separator' },
        { label: 'Run P0 check', click: () => void runProbe(false) },
        { label: 'Show P0 log', click: () => shell.showItemInFolder(logFile()) },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function guard(wc: WebContents) {
  wc.on('will-navigate', (e, url) => {
    let u: URL
    try { u = new URL(url) } catch { e.preventDefault(); return }
    if (u.protocol === 'file:' && PROBE) return
    if (isOwn(u)) return
    if (isStripe(u)) { log('nav stripe (allowed in window)', u.origin + u.pathname); return }
    e.preventDefault()
    log('nav external -> browser', u.origin + u.pathname)
    if (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:') shell.openExternal(url)
  })
  wc.setWindowOpenHandler(({ url }) => {
    let u: URL
    try { u = new URL(url) } catch { return { action: 'deny' } }
    if (isOwn(u)) return { action: 'allow' }
    log('popup -> browser', u.origin + u.pathname)
    if (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:') shell.openExternal(url)
    return { action: 'deny' }
  })
  wc.on('did-fail-load', (_e, code, desc, url, isMain) => { if (isMain) log('load failed', code, desc, url) })
}

function permissions() {
  const ses = session.defaultSession
  ses.setPermissionRequestHandler(async (wc, permission, callback, details) => {
    let own = false
    try { own = isOwn(new URL(details.requestingUrl)) } catch { /* bad url */ }
    const media = permission === 'media' && (details as { mediaTypes?: string[] }).mediaTypes?.every((t) => t === 'audio')
    if (own && (permission === 'clipboard-sanitized-write' || permission === 'fullscreen')) return callback(true)
    if (!own || !media) {
      log('permission denied', permission, details.requestingUrl)
      return callback(false)
    }
    // macOS asks once per app; the answer lives in System Settings > Privacy > Microphone.
    const ok = IS_MAC ? await systemPreferences.askForMediaAccess('microphone') : true
    log('permission mic', ok ? 'granted' : 'refused by the OS', details.requestingUrl)
    callback(ok)
  })
  ses.setPermissionCheckHandler((_wc, permission, origin) => {
    try { return isOwn(new URL(origin)) && (permission === 'media' || permission === 'clipboard-sanitized-write' || permission === 'fullscreen') } catch { return false }
  })
}

function downloads() {
  session.defaultSession.on('will-download', (_e, item) => {
    const name = item.getFilename()
    const ext = extname(name).toLowerCase()
    log('download', name, item.getMimeType(), `${item.getTotalBytes()} bytes`, ext === '.webm' ? 'WARNING: WebM, H.264 fell back' : '')
    if (PROBE || probing) {
      item.setSavePath(join(app.getPath('downloads'), name))
    } else {
      item.setSaveDialogOptions({ defaultPath: join(app.getPath('downloads'), name) })
    }
    item.once('done', (_ev, state) => log('download', state, item.getSavePath()))
  })
}

// P0 encoder check: the questions videoRender.ts asks before an export, plus a real
// 2 s MP4 saved to Downloads. Runs from Help > Run P0 check or with --probe.
let probing = false
async function runProbe(quit: boolean) {
  if (quit) writeFileSync(logFile(), '')
  probing = true
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } })
  await win.loadFile(join(__dirname, 'probe', 'probe.html'))
  const report = await win.webContents.executeJavaScript(
    `new Promise((r) => { const t = setInterval(() => { if (window.__report) { clearInterval(t); r(window.__report) } }, 100) })`,
  )
  await new Promise((r) => setTimeout(r, 1500)) // let the download land
  probing = false
  win.destroy()
  log('PROBE', report)
  if (quit) { console.log(`\nprobe report: ${logFile()}`); app.quit(); return }
  const r = report as { video: Record<string, string | null>; audio: Record<string, string | null>; recorder: Record<string, boolean>; file: unknown; error: string | null }
  const mp4 = Object.values(r.video).every((c) => c === 'avc') && Object.values(r.audio).every((c) => c === 'aac')
  const mic = Object.entries(r.recorder).find(([, ok]) => ok)?.[0] ?? 'none'
  await dialog.showMessageBox({
    type: mp4 && !r.error ? 'info' : 'warning',
    message: mp4 && !r.error ? 'Encoder check passed: exports will be MP4 (H.264 + AAC)' : 'Encoder check FAILED: exports would fall back to WebM or fail',
    detail: `Video: ${JSON.stringify(r.video)}\nAudio: ${JSON.stringify(r.audio)}\nTeam Talk recorder: ${mic}\n${r.error ? 'Error: ' + r.error + '\n' : ''}\nA test file tf-desktop-probe.mp4 is in Downloads: open it in your video player.\nFull log: ${logFile()}`,
  })
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: 'Total Football Studio',
    backgroundColor: '#0b0f14',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  guard(win.webContents)
  win.loadURL(START_URL)
  return win
}

ipcMain.on('tf:info', (e) => {
  e.returnValue = { version: app.getVersion(), platform: IS_MAC ? 'mac' : 'windows' }
})

app.whenReady().then(() => {
  session.defaultSession.setUserAgent(userAgent())
  log('start', { version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, url: START_URL, ua: session.defaultSession.getUserAgent() })
  // Packaged builds get the icon from electron-builder; this covers `npm start`.
  if (IS_MAC && !app.isPackaged) app.dock?.setIcon(join(__dirname, '..', 'build', 'icon.png'))
  menu()
  permissions()
  downloads()
  if (PROBE) return runProbe(true)
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (!IS_MAC || PROBE) app.quit() })
