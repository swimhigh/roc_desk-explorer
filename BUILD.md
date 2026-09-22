# roc_desk-explorer standalone build

Run from the repository root:

```powershell
.\build-standalone.ps1
```

The release executable is written to `bin\roc_desk-explorer.exe`. Use
`-Configuration debug` for a fast development build.

`build-standalone.ps1` only runs `cargo build` -- it does not rebuild the
frontend. `standalone/dist/` is committed to the repo as the frontend build
output, so a plain `git clone` + `build-standalone.ps1` already produces a
working exe. If you change anything under `src-web/`, rebuild the frontend
first so `standalone/dist/` picks up the change:

```powershell
cd src-web
npm install
npm run build
```

This writes straight to `standalone/dist` (see `src-web/vite.config.ts`'s
`build.outDir`), which is what `standalone/tauri.conf.json`'s
`build.frontendDist` embeds into the exe at `cargo build` time.
