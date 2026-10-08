// The only bridge between the studio page and the shell. contextIsolation is on,
// so the page sees exactly what is exposed here and nothing of Node or Electron.
// P0: version and platform only. signIn / onAuthCallback / onOpenFile arrive in P1-P2
// (docs/DESKTOP.md §5 in totalfootball-web).
import { contextBridge, ipcRenderer } from 'electron'

const info = ipcRenderer.sendSync('tf:info') as { version: string; platform: 'mac' | 'windows' }

contextBridge.exposeInMainWorld('tfDesktop', {
  version: info.version,
  platform: info.platform,
})
