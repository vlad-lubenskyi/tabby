# Electron Hardening Plan

## Audit Summary

Tabby's Electron renderer runs with `nodeIntegration: true` and `contextIsolation: false`, meaning the renderer has unrestricted Node.js access — there is no IPC security boundary to speak of. The webpack renderer bundle targets `node` instead of `web`, so native modules load directly in the renderer (including `.node` addons for macOS/Windows process listing). The IPC layer uses three synchronous `sendSync` calls for PTY lifecycle and passes raw `Buffer` objects across the boundary. All of these must be resolved before MoBrowser-style context isolation can be enforced. Recommended sequence: secure the window first, then migrate the webpack build, then replace synchronous IPC, then replace Node APIs in shared libs.

---

## Tasks

### Task 1: Enable Context Isolation and Disable Node Integration
**Category:** Build System
**Scope:** `app/lib/window.ts:67–72`, `app/index.pug:8`, `app/src/entry.preload.ts`

**What to do:**
1. In `window.ts` change `webPreferences` to:
   ```ts
   webPreferences: {
       nodeIntegration: false,
       contextIsolation: true,
       preload: path.join(__dirname, 'preload.js'),
       backgroundThrottling: false,
   }
   ```
2. In `index.pug` remove the line `window.nodeRequire = require` — this is a direct `require` escape hatch that defeats any sandbox.
3. Expand `app/src/entry.preload.ts` to expose via `contextBridge.exposeInMainWorld` only the exact surface the renderer needs (IPC send/on/invoke). Nothing else crosses from the preload scope into the renderer.

**Gotchas:**
- `@electron/remote` is currently listed as an external in `webpack.config.mjs` and almost certainly used in renderer plugins. Audit all `getGlobal` / `require('@electron/remote')` calls before enabling context isolation — they will all break.
- The preload is currently `sentry.js` (a Sentry script), not the entry point. Consolidate into one preload that loads Sentry and exposes the bridge, otherwise you can only register one preload.

---

### Task 2: Switch Renderer Webpack Target from `node` to `electron-renderer`
**Category:** Build System
**Scope:** `app/webpack.config.mjs:22`, `app/webpack.config.mjs:73–82`

**What to do:**
1. Change `target: 'node'` to `target: 'web'`. This is the correct and final target — `electron-renderer` is not acceptable because it still resolves Node built-ins at runtime through Electron's patched environment, defeating the boundary enforcement. `web` fails at build time on any Node import, surfacing violations immediately.
2. The existing `externals` block (`fs`, `path`, `child_process`, `mz`, `electron`, etc.) already lists known main-process modules. Under `target: 'web'` any module in that list that is accidentally imported by renderer code will produce a build error rather than silently resolving.
3. Add a `resolve.fallback` section alongside the `externals` to stub remaining Node built-ins that aren't already listed: `crypto`, `net`, `tls`, `dns`, `http`, `https`, `zlib` set to `false`.

**Gotchas:**
- `mz` is a Node.js promisify wrapper listed in `externals`. Under `target: 'web'` it will cause a build error if any renderer-side code imports it — locate and remove those usages before switching.
- Build errors after this change are intentional and desirable: each one reveals a Node dependency that was silently leaking into the renderer.

---

### Task 3: Replace Synchronous IPC for PTY Lifecycle
**Category:** IPC Boundary
**Scope:** `tabby-electron/src/pty.ts:18,23,69` (renderer), `app/lib/pty.ts:144–156` (main)

**What to do:**
1. Convert the three `sendSync` calls to async `invoke`:
   - Renderer: `ipcRenderer.sendSync('pty:spawn', ...)` → `await ipcRenderer.invoke('pty:spawn', ...)`
   - Renderer: `ipcRenderer.sendSync('pty:exists', id)` → `await ipcRenderer.invoke('pty:exists', id)`
   - Renderer: `ipcRenderer.sendSync('pty:get-pid', this.id)` → `await ipcRenderer.invoke('pty:get-pid', this.id)`
2. On the main side, replace `ipcMain.on` + `event.returnValue` with `ipcMain.handle`:
   ```ts
   ipcMain.handle('pty:spawn', (_event, ...options) => {
       const id = uuidv4().toString()
       this.ptys[id] = new PTY(id, app, ...options)
       return id
   })
   ipcMain.handle('pty:exists', (_event, id) => !!(this.ptys[id] && !this.ptys[id].exited))
   ipcMain.handle('pty:get-pid', (_event, id) => this.ptys[id]?.getPID() ?? null)
   ```
3. Update call sites in `ElectronPTYInterface.spawn()`, `ElectronPTYInterface.restore()`, and `ElectronPTYProxy.getPID()` to be `async` / `await`.

**Gotchas:**
- `getPID()` is called inside a `new Promise(async (resolve) => {...})` constructor chain in `ElectronPTYProxy`. Making it truly async means you need to ensure the outer promise chain still resolves correctly — audit the `truePID` initialization block.
- `ipcMain.handle` will throw if the same channel is registered twice (e.g., on window reload). Wrap each `handle` with a guard or call `ipcMain.removeHandler` before re-registering.

---

### Task 4: Move Native Addon Usage Out of the Renderer
**Category:** Native Addons
**Scope:** `tabby-electron/src/pty.ts:8–14` (renderer), `tabby-electron/src/pty.ts:101–134`

**What to do:**
1. Remove the two top-level `require()` calls for `macos-native-processlist` and `@tabby-gang/windows-process-tree` from the renderer file `tabby-electron/src/pty.ts`.
2. Add two new IPC channels: `pty:get-child-processes` (takes a `truePID: number`, returns `ChildProcess[]`).
3. Move `getChildProcessesInternal()` logic into `app/lib/pty.ts` (main process), registered as an `ipcMain.handle('pty:get-child-processes', ...)` handler.
4. In the renderer `ElectronPTYProxy.getChildProcessesInternal()`, replace the native calls with `await ipcRenderer.invoke('pty:get-child-processes', truePID)`.
5. Same for `getWorkingDirectoryFromPID` (imported from `native-process-working-directory` at line 4): add `pty:get-working-directory` IPC channel and move the call to main.

**Gotchas:**
- `ps-node` (used for Linux `getChildProcessesInternal`) spawns a child process. Confirm it does not need to stay in the renderer for any reason — it does not.
- The `macos-native-processlist` and `windows-process-tree` packages may not be in `app/package.json` yet (they may only be `devDependencies` or in plugin packages). Verify they are available in the main process before moving.

---

### Task 5: Replace `Buffer` and Node Crypto in `tabby-core` Shared Code
**Category:** Browser-Native Replacements
**Scope:** `tabby-core/src/utfSplitter.ts`, `tabby-core/src/services/vault.service.ts:1–2`

**What to do:**

**utfSplitter.ts:**
- Replace `Buffer.alloc(0)` with `new Uint8Array(0)`.
- Replace `Buffer.concat([a, b])` with a helper: `const concat = (a: Uint8Array, b: Uint8Array) => { const r = new Uint8Array(a.length + b.length); r.set(a); r.set(b, a.length); return r }`.
- Replace `Buffer` type annotations with `Uint8Array` throughout. Ensure callers (in `app/lib/pty.ts`) pass `Uint8Array`; `node-pty` returns `string | Buffer` — call `Buffer.from(data)` only in the main-process PTY wrapper, not in shared code.

**vault.service.ts:**
- Replace `import * as crypto from 'crypto'` with `const crypto = globalThis.crypto` (the Web Crypto API).
- Replace `promisify(crypto.pbkdf2)(...)` with `crypto.subtle.deriveBits(...)` using PBKDF2 algorithm.
- Replace `crypto.createCipheriv('aes-256-cbc', ...)` with `crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, data)`.
- Replace `import { promisify } from 'util'` — once `crypto.subtle` is used, `promisify` is no longer needed.

**Gotchas:**
- Web Crypto `subtle` API uses `ArrayBuffer` / `Uint8Array` throughout, not hex strings. The vault currently stores `keySalt` and `iv` as hex strings in the config — conversion helpers (`hex → Uint8Array` and back) will be needed to stay backwards compatible with existing stored vaults.
- Web Crypto PBKDF2 in `subtle` does not accept raw string passwords — you must `TextEncoder().encode(password)` first.
- `AES-CBC` in Web Crypto uses a non-extractable `CryptoKey` object. Key derivation and encryption must be done in a single session — you cannot serialize the `CryptoKey` between calls. The current code re-derives the key each call anyway, so this is fine.

---

### Task 6: Add `resolve.fallback` Stubs for Remaining Node Modules in Web Bundle
**Category:** Build System
**Scope:** `web/webpack.config.mjs:48–53`

**What to do:**
Extend `resolve.fallback` to explicitly set `false` for all Node built-ins that must not enter the web bundle:
```js
fallback: {
    stream: require.resolve('stream-browserify'),
    assert: require.resolve('assert/'),
    constants: require.resolve('constants-browserify'),
    util: require.resolve('util/'),
    // explicitly block — fail at build time if anything imports these:
    fs: false,
    crypto: false,
    net: false,
    tls: false,
    child_process: false,
    dns: false,
    http: false,
    https: false,
    path: false,
    zlib: false,
}
```
After Task 5 replaces `crypto` usage in `vault.service.ts`, `crypto: false` will not break the web bundle.

**Gotchas:**
- `crypto: false` will break the build if any dependency (not just tabby-core) still imports Node `crypto`. Run `webpack --profile --json | npx webpack-bundle-analyzer` to identify the import chain before enabling this.
- `http`/`https` stubs may be needed (not `false`) if any SSH or plugin code reaches them indirectly via `axios` or similar. Check the web bundle for these before setting to `false`.
