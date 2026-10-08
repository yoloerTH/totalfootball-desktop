// The only bridge between the studio page and the shell. contextIsolation is on,
// so the page sees exactly this and nothing of Node or Electron. The web side's
// type for it is TfDesktop in totalfootball-web src/lib/desktop.ts; keep the two equal.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

const info = ipcRenderer.sendSync('tf:info') as { version: string; platform: 'mac' | 'windows'; installId: string; deviceName: string }

type AuthResult = { code: string } | { error: string }
type FileHandler = (name: string, bytes: Uint8Array) => void

// One handler each; registering again replaces it. Registering also tells main
// this page is listening, so a callback or file that arrived first is handed over.
let onAuth: ((r: AuthResult) => void) | null = null
let onFile: FileHandler | null = null
ipcRenderer.on('tf:auth-callback', (_e: IpcRendererEvent, r: AuthResult) => onAuth?.(r))
ipcRenderer.on('tf:open-file', (_e: IpcRendererEvent, f: { name: string; bytes: Uint8Array }) => onFile?.(f.name, f.bytes))

contextBridge.exposeInMainWorld('tfDesktop', {
  version: info.version,
  platform: info.platform,
  installId: info.installId,
  deviceName: info.deviceName,
  signIn: (authUrl: string): Promise<void> => ipcRenderer.invoke('tf:sign-in', authUrl),
  onAuthCallback: (cb: (r: AuthResult) => void) => {
    onAuth = cb
    ipcRenderer.send('tf:listen', 'auth')
  },
  onOpenFile: (cb: FileHandler) => {
    onFile = cb
    ipcRenderer.send('tf:listen', 'files')
  },
})
