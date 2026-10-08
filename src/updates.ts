// Shell updates (docs/DESKTOP.md §8). The studio itself updates with every
// deploy of the site; this only replaces the shell, which should be rare.
// Feed: GitHub Releases of the public totalfootball-desktop repo (electron-builder.yml `publish`).
import { app, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'

const SIX_HOURS = 6 * 60 * 60 * 1000
type Log = (...parts: unknown[]) => void

let ready = false
let asking = false
let byHand = false

export function initUpdates(log: Log) {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null

  autoUpdater.on('error', (e) => {
    log('update error', String(e?.message ?? e))
    if (byHand) void dialog.showMessageBox({ type: 'warning', message: 'Could not check for updates', detail: 'Check your connection and try again later.' })
    byHand = false
  })
  autoUpdater.on('update-available', (u) => {
    log('update available', u.version)
    if (byHand) void dialog.showMessageBox({ type: 'info', message: `Downloading Total Football Studio ${u.version}`, detail: 'Keep working. You will be asked to restart when it is ready.' })
  })
  autoUpdater.on('update-not-available', () => {
    if (byHand) void dialog.showMessageBox({ type: 'info', message: 'You have the latest version', detail: `Total Football Studio ${app.getVersion()}` })
    byHand = false
  })
  autoUpdater.on('update-downloaded', async (u) => {
    byHand = false
    ready = true
    log('update ready', u.version)
    if (asking) return
    asking = true
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart to update', 'Later'],
      defaultId: 0,
      cancelId: 1,
      message: `Total Football Studio ${u.version} is ready`,
      detail: 'Restart now to use it, or later: it installs by itself the next time you quit.',
    })
    asking = false
    if (response === 0) autoUpdater.quitAndInstall()
  })

  const check = () => { if (!ready) autoUpdater.checkForUpdates().catch(() => { /* reported through 'error' */ }) }
  check()
  setInterval(check, SIX_HOURS)
}

export function checkForUpdatesByHand(log: Log) {
  if (!app.isPackaged) {
    void dialog.showMessageBox({ type: 'info', message: 'Updates only run in the installed app.' })
    return
  }
  if (ready) return autoUpdater.quitAndInstall()
  byHand = true
  autoUpdater.checkForUpdates().catch((e) => log('update check failed', String(e)))
}
