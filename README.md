# Total Football Studio for Mac and Windows

A thin Electron shell over the live web studio at
https://totalfootballstudio.com/studio/portal/. The plan, the decisions and why
are in `totalfootball-web/docs/DESKTOP.md`. This repo is public: shell code only,
no secrets.

## Run

```sh
npm install
npm start          # the live studio
npm run dev        # local `netlify dev` on :8888 (Stripe test keys)
npm run probe      # video export check, prints JSON and quits
```

`Help > Check Video Export` runs the same check in the app and saves a 2 s MP4
to Downloads. `Help > Show Log File` opens `desktop.log` in userData.

## What the shell does (src/main.ts)

- One window on the studio; size and place remembered (`window.json`).
- Navigation guard: totalfootballstudio.com and Stripe stay in the window,
  everything else opens in the default browser. Google and Apple never load here.
- Sign-in with Google/Apple: the page asks `tfDesktop.signIn(url)`, main checks it
  is our Supabase authorize URL and opens the browser; Supabase returns to
  `ai.naurra.totalfootball.desktop://auth-callback?code=…`, main hands the code to
  the page, which exchanges it (PKCE). The code (and a double-clicked .tfs) is
  kept until the page's preload says a handler took it (`tf:taken`).
- `.tfs` double-click: the bytes go to the portal's import (`tfDesktop.onOpenFile`).
- Microphone for our origin only (Team Talk); every other permission denied.
- Downloads become a native Save dialog.
- Offline screen with Try again (`src/offline.html`).
- Edit menu (macOS clipboard shortcuts need it), right-click menu, Back/Forward.
- Shell updates from GitHub Releases (`src/updates.ts`), on launch and every 6 h.
- User agent: Chrome's, plus `TotalFootballDesktop/<version>` (site attribution).

The page-facing API is `src/preload.ts`; its type on the web side is `TfDesktop`
in `totalfootball-web/src/lib/desktop.ts`. Keep the two equal.

## Release

1. Bump `version` in package.json, commit, tag `vX.Y.Z`, push the tag.
2. `.github/workflows/release.yml` builds a universal signed + notarized DMG/zip
   and an unsigned Windows NSIS installer into a draft release.
3. Publish the draft. `/desktop/` links to `releases/latest/download/…`:
   `Total-Football-Studio-mac.dmg`, `Total-Football-Studio-Setup.exe`.

Local unsigned builds: `npm run pack:mac`, `npm run pack:win` (into `release/`).

Icons: `npm run icons` rebuilds `build/icon.png` (macOS) and `build/icon.ico`
(Windows) from the iOS app's AppIcon-1024.
