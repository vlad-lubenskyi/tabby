# Gotcha Registry

<!-- Agents: append new entries here per the rules in CLAUDE.md. Do not edit existing entries. -->

## `@electron/remote` will break when contextIsolation is enabled

**Discovered:** 2026-07-01
**File(s):** `app/webpack.config.mjs:74`, `app/lib/window.ts:67–72`
**Description:** `@electron/remote` is listed as an external and is used by renderer-side plugin code. Enabling `contextIsolation: true` (Task 1) will break every `getGlobal()` and `require('@electron/remote')` call in the renderer without a prior audit and migration.
**How to avoid:** Before enabling `contextIsolation`, grep for `@electron/remote` across all `tabby-*/src` directories and replace each usage with an explicit IPC channel or contextBridge-exposed helper.

---

## Only one preload script can be registered per BrowserWindow

**Discovered:** 2026-07-01
**File(s):** `app/lib/window.ts:69`
**Description:** The current preload is `sentry.js`. Electron's `webPreferences.preload` accepts a single file path. Adding a contextBridge preload naively will silently displace the Sentry preload unless they are merged into one file.
**How to avoid:** Consolidate `sentry.js` and the new contextBridge setup into a single `preload.ts` entry point before switching `contextIsolation` to `true`.

---

## `ipcMain.handle` throws on duplicate channel registration

**Discovered:** 2026-07-01
**File(s):** `app/lib/pty.ts:144–173`
**Description:** Calling `ipcMain.handle('pty:spawn', ...)` a second time (e.g., on window reload or app re-initialisation) throws an uncaught error: "Attempted to register a second handler for 'pty:spawn'". The current `ipcMain.on` pattern silently stacks handlers instead.
**How to avoid:** Call `ipcMain.removeHandler(channel)` before each `ipcMain.handle(channel, ...)` registration, or guard with a flag so `init()` only runs once per process lifetime.

---

## `getPID()` is awaited inside an async Promise constructor — making it async can cause silent hangs

**Discovered:** 2026-07-01
**File(s):** `tabby-electron/src/pty.ts:39–57`
**Description:** `ElectronPTYProxy.truePID` is initialised in `new Promise(async (resolve) => { let pid = await this.getPID() ... })`. If `getPID()` becomes a real async IPC call that itself awaits the Promise that is still being constructed, it will deadlock silently.
**How to avoid:** When converting `getPID()` to async invoke, ensure the `truePID` promise chain does not transitively depend on `truePID` itself. Restructure the constructor to await `ipcRenderer.invoke('pty:get-pid', ...)` directly without going through `this.getPID()` during initialisation.

---

## Web Crypto vault migration must preserve hex-encoded stored secrets

**Discovered:** 2026-07-01
**File(s):** `tabby-core/src/services/vault.service.ts`
**Description:** The current vault stores `keySalt` and `iv` as hex strings in the user's config file. The Web Crypto `subtle` API works with `ArrayBuffer`/`Uint8Array`, not hex strings. A naive migration that changes the storage format will silently fail to decrypt vaults created by earlier versions of the app.
**How to avoid:** Add hex↔Uint8Array conversion helpers and keep the on-disk format unchanged. Read stored hex strings, convert to `Uint8Array` before passing to `subtle`, and convert derived bytes back to hex before writing. Add a `version` field to `StoredVault` if the format ever must change.

---

## `target: 'web'` externalises Node built-ins but transitive deps still pull them in — add ALL to externals

**Discovered:** 2026-07-01
**File(s):** `app/webpack.config.mjs`
**Description:** Switching the renderer bundle to `target: 'web'` causes webpack to error on any Node built-in not in `resolve.fallback` or `externals`. Third-party packages (`@sentry/node`, `graceful-fs`, `agent-base`, `https-proxy-agent`, `thenify`) each import different Node modules. Must add `assert`, `buffer`, `constants`, `crypto`, `dns`, `domain`, `http`, `https`, `net`, `os`, `stream`, `tls`, `tty`, `url`, `util`, `zlib` to `externals`, not just the ones your own code uses.
**How to avoid:** When adding `target: 'web'`, run the build immediately to collect the full list of "Can't resolve" errors. Add all missing modules to `externals` in one pass before moving on.

---

## ElectronService is a deep wrapper around @electron/remote — contextIsolation cannot be flipped without migrating it first

**Discovered:** 2026-07-01
**File(s):** `tabby-electron/src/services/electron.service.ts:3,35–46`
**Description:** `ElectronService` exposes `remote.app`, `remote.screen`, `remote.dialog`, `remote.globalShortcut`, `remote.autoUpdater`, `remote.powerSaveBlocker`, `remote.TouchBar`, `remote.BrowserWindow`, `remote.Menu`, `remote.MenuItem`, `remote.nativeTheme` — all from `@electron/remote`. Every other service in `tabby-electron` and several in `tabby-core` depend on `ElectronService`. Enabling `contextIsolation: true` will immediately break the whole app because `@electron/remote` requires `nodeIntegration: true` to function in its current form.
**How to avoid:** Before flipping `contextIsolation`, replace every `ElectronService` field that wraps `@electron/remote` with an explicit IPC channel pair (invoke on renderer, handle on main). This is a large migration — scope it as its own PR. Only flip `contextIsolation: true` after all `@electron/remote` usages in the renderer are replaced.

---

## CRITICAL: Never write a file that runs in both main process and renderer/preload

**Discovered:** 2026-07-01
**File(s):** `app/lib/sentry.ts` (violating example)
**Description:** A file like `sentry.ts` that uses `if (String(process.type) !== 'main')` guards to conditionally run renderer vs. main code is an anti-pattern. Main process code and renderer/preload code must live in completely separate files. The ONLY code permitted to be shared between processes is IPC DTO type definitions. Dual-context files hide renderer APIs (e.g. `contextBridge`, `ipcRenderer`) inside the main process module graph, cause hard-to-debug crashes (e.g. `ipcRenderer` is `undefined` in main), and make the security boundary invisible.
**How to avoid:** Never write a `process.type` guard to split behavior inside a single file. Split the file: e.g. `sentry-main.ts` (imported by `index.ts`) and `sentry.ts` (the preload, loaded by webpack as a separate entry). Audit the project with `grep -r "process.type" app/lib/` to find violations.

---

## TypeScript does not narrow reassigned optional parameters past their declaration type

**Discovered:** 2026-07-01
**File(s):** `tabby-electron/src/services/platform.service.ts:263,288,304`
**Description:** When a method parameter is declared as `paths?: string[]` and later assigned inside an `if (!paths)` block (`paths = result.filePaths ?? []`), TypeScript still considers `paths` to be `string[] | undefined` after the block — it does not narrow to `string[]` even though all early-return and assignment paths guarantee it is defined. Same applies to `filePath?: string`.
**How to avoid:** Use non-null assertion (`paths!`) or introduce a local `const resolved = paths ?? []` immediately after the if-block. Avoid relying on TypeScript narrowing for reassigned optional parameters.

---

## `crypto: false` webpack fallback will fail if any transitive dependency imports Node `crypto`

**Discovered:** 2026-07-01
**File(s):** `web/webpack.config.mjs:48–53`
**Description:** Setting `resolve.fallback: { crypto: false }` causes a build-time error for every module in the entire dependency graph that imports Node's `crypto` — not just first-party code. This includes common packages like `uuid`, `bcrypt`, or SSH libraries.
**How to avoid:** Before setting `crypto: false`, run `webpack --profile --json > stats.json && npx webpack-bundle-analyzer stats.json` to identify all transitive importers of `crypto` in the web bundle. Migrate or exclude each one before enabling the hard block.

---

## Electron sandbox layer blocks `@electron/remote` in preload even when module is in `app/node_modules/`

**Discovered:** 2026-07-01
**File(s):** `app/lib/sentry.ts`, `app/dist/sentry.js`
**Description:** After correctly externalizing `@electron/remote` in the sentry webpack bundle (so `dist/sentry.js` generates `require("@electron/remote")`), the preload script still fails at runtime with `Error: module not found: @electron/remote` from `sandbox_bundle:2`. The module IS present in `app/node_modules/@electron/remote`. Electron's preload sandbox layer (`sandbox_bundle`) has a different module resolution path than the main process and may refuse to load native Electron modules that were not bundled inline.
**How to avoid:** If using `contextIsolation: true` with a preload, avoid externalizing packages that must be `require()`-d in the preload — bundle them inline, OR explicitly set `sandbox: false` in `webPreferences` so the preload runs in Node.js context with full module resolution. Note: `sandbox: true` (default since Electron 20) restricts preload to a limited set of allowed modules.

---

## `global['require']` is `undefined` in a `target: 'web'` webpack bundle — do NOT use it to detect Node.js

**Discovered:** 2026-07-01
**File(s):** `app/src/plugins.ts:6`
**Description:** In a `target: 'web'` webpack bundle, `global['require']` is `undefined` — webpack does not inject its own `__webpack_require__` as `global.require`. Code like `const nr = (global as any)['require'] ?? window?.tabbyAPI?.nodeRequire` will fall through to `nodeRequire`. However, if `nodeRequire` itself (exposed via contextBridge) somehow returns a value that webpack's module registry interprets as `null`, the next `__webpack_require__(moduleId)` call will throw `Cannot find module 'null'`. This happened in `plugins.ts` after the `_require()` helper was wired to `tabbyAPI.nodeRequire` — the require call returned a result that was treated as a module identifier `'null'` by the webpack runtime.
**How to avoid:** Never mix webpack's bundled `require` calls (for bundled modules like Angular) with runtime Node.js `require` calls (for filesystem plugins) in the same file without careful isolation. Webpack's `__webpack_require__` and Node's `require` are entirely separate call chains. If a function that accepts `require` as an argument might receive either, add a runtime check: verify the function is Node's `require` (e.g., `typeof nr.resolve === 'function'`) before passing dynamic plugin paths to it.

---

## `ModuleConcatenationPlugin` causes null module IDs for `@sentry/utils` ESM files in `target: 'web'` bundles

**Discovered:** 2026-07-01
**File(s):** `app/webpack.config.mjs`
**Description:** When `wp.optimize.ModuleConcatenationPlugin` is used together with `target: 'web'` and Sentry ESM packages (`@sentry/utils/esm/*.js`), some modules (e.g. `dsn.js`, `memo.js`) get assigned a `null` module ID in the webpack module registry. At runtime, `__webpack_require__(null)` throws "Cannot find module 'null'", crashing the preload script before `contextBridge.exposeInMainWorld` executes.
**How to avoid:** Remove `ModuleConcatenationPlugin` from the renderer webpack config. Scope hoisting is already enabled automatically by webpack 5 in production mode for eligible modules; the explicit plugin is redundant and causes conflicts with ESM files that have non-standard export patterns.

---

## Do not bake `process.platform` or env vars into the renderer at build time via `DefinePlugin` — use IPC or the preload instead

**Discovered:** 2026-07-01
**File(s):** `app/webpack.config.mjs`, `app/lib/sentry.ts`
**Description:** Using `DefinePlugin` with `'process.platform': JSON.stringify(process.platform)` bakes the BUILD HOST's platform into the bundle. If you build on macOS and deploy on Linux, the value is wrong. More importantly, it leaves a lexical dependency on `process` that is confusing, is not updated at runtime, and can break if `process` is not in scope. Similarly, `process.env.TABBY_DEV` baked at build time is only correct if the build and run environments always match.
**How to avoid:** Expose runtime values (platform, arch, env flags, resourcesPath) from the preload via `contextBridge.exposeInMainWorld('tabbyAPI', { platform: process.platform, ... })`. Read them from `window.tabbyAPI.*` in the renderer. Keep `DefinePlugin` only for build-time constants like `process.type` (which is architecturally always `"renderer"` for this entry).

---

## Pre-compiled tabby-\* UMD bundles call `require("os")`, `require("net")`, etc. WITHOUT try-catch in their factory — they cannot be re-bundled with webpack `target: 'web'` using `externals`

**Discovered:** 2026-07-01
**File(s):** `node_modules/tabby-core/dist/index.js`, `node_modules/tabby-terminal/dist/index.js`, `node_modules/tabby-local/dist/index.js`, `node_modules/tabby-settings/dist/index.js`
**Description:** Each pre-compiled tabby-\* package is a webpack UMD bundle. Its factory function calls `require("os")`, `require("net")`, `require("path")`, `require("stream")`, etc. as arguments — without wrapping them in try-catch. When re-bundled by the app webpack (target: web), those become `__webpack_require__(externalId)` calls to externals that generate `module.exports = require("os")`. In the sandboxed renderer with no native `require`, this throws "require is not defined" at module init time, before any Angular code runs.
**How to avoid:** Move all Node.js built-in externals (`os`, `net`, `path`, `stream`, `fs`, `readline`, `url`, `util`, etc.) from the `externals` object to `resolve.fallback: { name: false }`. This makes webpack bundle an empty `{}` stub for each built-in — no `require()` call at runtime, so the UMD factories succeed. The modules load with stub values; runtime errors only appear when specific Node.js APIs are actually called (which is expected and caught separately). Alternatively, import tabby-\* from their TypeScript source (not `dist/`) to avoid the UMD entirely.

---

## Monorepo Electron hardening: mixed renderer/Node.js packages cannot be sandboxed without splitting the IPC boundary first

**Discovered:** 2026-07-01
**File(s):** `tabby-core/src/`, `tabby-terminal/src/`, `tabby-local/src/`, `tabby-electron/src/`
**Description:** In an Electron monorepo where packages predate `contextIsolation: true`, individual packages typically mix Angular/renderer code and Node.js code in the same compilation unit. This means:
1. Pre-compiled UMD dist files contain inner webpack runtimes that call `require("node:url")`, `__filename`, etc. at init time — crashing immediately in the sandboxed renderer.
2. Importing from TypeScript source (via `resolve.alias`) fails because the Angular Ivy linker (`@ngtools/webpack`) scans `node_modules` adjacent to any source directory it compiles, and finds transitive Angular entry-points (e.g. `ngx-translate-messageformat-compiler`) whose peer dependencies aren't resolvable from the app's compilation context — causing "Failed to initialize Angular compilation".
3. Providing global shims (`ProvidePlugin` for `process`, `Buffer`) partially works, but breaks down for module-scope Node.js calls (e.g. `Buffer.from()`, `os.release()`, `process.platform`) that are in files that should never run in the renderer.

The root cause is not the build tooling — it is that the package boundary does not reflect the process boundary.

**How to avoid:** Before attempting any renderer webpack hardening in a mixed monorepo:
1. **Identify which packages already have the right abstraction.** Look for an existing "platform adapter" package (the Electron-specific one) that is supposed to own all Node.js capabilities. In Tabby this is `tabby-electron`.
2. **Move Node.js code to the adapter package, not into a new package.** Creating `tabby-local-node` adds scaffolding; moving `fs`/PTY code from `tabby-local` into `tabby-electron` (behind the existing `PTYInterface`/`HostAppService` abstractions) enforces the boundary without new infrastructure.
3. **Replace module-scope Node.js calls in shared packages with browser-native equivalents.** `Buffer` → `Uint8Array`, Node `crypto` → `globalThis.crypto` (Web Crypto API), `process.platform` → injected at bootstrap from `contextBridge`. These are one-file changes that are independently mergeable.
4. **Only after the above**, attempt `resolve.alias` to TypeScript source or adjust webpack build settings. At that point, the renderer-facing packages are genuinely browser-safe and the Ivy linker will only scan `node_modules` that contain proper Angular peer dependencies.
5. **`node:*` prefix imports (e.g. `node:url`, `node:fs`) must be in `resolve.fallback`, not `externals`.** Externals generate `module.exports = require("node:url")` — a native `require()` call that throws in the sandboxed renderer. Fallback generates an inline `{}` stub with no runtime `require()`.
**Applies to:** Any Electron monorepo (nx, turborepo, yarn workspaces) where pre-sandbox packages share renderer and main-process code inside a single npm package.

---

## ⚠️ VERY IMPORTANT: How to fully remove Electron and Node.js types from the renderer type graph

**Discovered:** 2026-07-01
**File(s):** `tabby-electron/tsconfig.json`, `tabby-electron/src/services/docking.service.ts`, `.eslintrc.yml`
**Description:** Adding `"types": []` to a plugin's `tsconfig.json` is NOT sufficient to remove `@types/node` globals (including `process`, `Buffer`, `setImmediate`, `__dirname`) from the TypeScript type graph. There are three independent chains that re-introduce them, all of which must be cut:

1. **`import ... from 'electron'`** — `electron/electron.d.ts` contains `/// <reference types="node" />`, which forces `@types/node` globals into scope for the entire compilation. Even a `import type { Display } from 'electron'` is enough. Fix: replace all electron type imports with local interface definitions (e.g. `interface DisplayInfo { id: number; bounds: {...}; workArea: {...} }`).

2. **Dependency `.d.ts` files with `/// <reference types="node" />`** — packages like `winston`, `@types/glob`, and `typings/*.d.ts` generated from node-using code all carry this triple-slash directive. TypeScript always resolves it regardless of `types: []`, because `types: []` only blocks *automatic* @types discovery — not directives embedded in imported `.d.ts` files. Fix: (a) exclude directories containing these files from the tsconfig (`"exclude": ["typings", "src/sshImporters.ts", ...]`); (b) make node-only packages (`winston`, `glob`, etc.) externals in the plugin webpack so they are never imported in the renderer.

3. **`typings/` directory** — if the package has a `typings/` folder with generated `.d.ts` files from node-using source (e.g. compiled `pty.d.ts`), those files contain `/// <reference types="node" />` and are auto-included by TypeScript. Fix: add `"typings"` to the `exclude` array.

Once all three chains are cut, `"types": []` becomes effective and `tsc` will error with `TS2591: Cannot find name 'process'` on any direct `process.*` reference. This is the desired compile-time enforcement. The ESLint `no-restricted-globals` rule (see `.eslintrc.yml`) provides additional enforcement during `yarn lint`.

**How to avoid:** When applying `"types": []` to a plugin tsconfig:
1. Run `npx tsc --noEmit --traceResolution 2>&1 | grep "Resolving type reference directive 'node'"` to find all remaining chains.
2. For each source file listed, trace which import triggered the `/// <reference types="node" />` and either exclude the file or replace the import.
3. Run again until the output is empty — only then is the graph clean.
4. Smoke-test: append `const x = process.platform` to any src file, run `tsc --noEmit`, confirm error TS2591, then revert.

---

## `window.tabbyAPI.osRelease` must be exposed via contextBridge for `getWindows10Build()` to work

**Discovered:** 2026-07-01
**File(s):** `tabby-core/src/utils.ts:12`, `app/lib/sentry.ts`
**Description:** The `getWindows10Build()` function in `tabby-core/src/utils.ts` was rewritten to read `window.tabbyAPI?.osRelease` (replacing `os.release()`). This field must be exposed by the preload/contextBridge setup. If it is missing, `getWindows10Build()` returns `undefined` for all builds, silently disabling Windows 10+ feature detection.
**How to avoid:** When adding new fields to `window.tabbyAPI`, also add them to the `contextBridge.exposeInMainWorld('tabbyAPI', { ... })` call in the preload (or `app/lib/sentry.ts`). Add `osRelease: require('os').release()` alongside the existing `platform` field.

---

## `tabbyAPI.env` exposes only 10 specific env vars — not the full `process.env`

**Discovered:** 2026-07-01
**File(s):** `app/lib/sentry.ts:47–58`, `tabby-local/src/environment.ts`
**Description:** `window.tabbyAPI.env` only exposes: `HOME`, `LOGNAME`, `USERNAME`, `USERPROFILE`, `SystemRoot`, `windir`, `ProgramFiles`, `ProgramFiles(x86)`, `CMDER_ROOT`, `PATHEXT`. Code in `tabby-local/src/environment.ts` previously spread all of `process.env` to build the PTY base environment. After migration, only these 10 vars are available in the renderer. The PTY spawner (`app/lib/pty.ts`) runs in the main process and inherits the full environment; the env object passed via IPC augments it with Tabby-specific overrides. Missing vars (e.g. `LC_CTYPE`, `WINDIR`) silently become undefined in renderer-side env construction logic.
**How to avoid:** When renderer-side code needs additional env vars beyond the 10 exposed, either: (a) add them to the `contextBridge.exposeInMainWorld` call in `app/lib/sentry.ts`, OR (b) pass env-sensitive logic to the main process via IPC. Do NOT attempt to read `process.env.ANYTHING_ELSE` in the renderer — it will be `undefined` and TypeScript with `"types": []` will error.

---

## `declare const require` in renderer TypeScript is safe ONLY because webpack rewrites it — do not confuse with Node.js `require`

**Discovered:** 2026-07-01
**File(s):** `tabby-core/src/commands.ts`, `tabby-core/src/config.ts`, `tabby-core/src/theme.ts`, etc.
**Description:** Adding `declare const require: (module: string) => any` at the top of a renderer TypeScript file tells the compiler that `require` is a valid global. This is correct for webpack-bundled code where webpack replaces `require()` calls with `__webpack_require__()`. However, if the file is ever moved outside a webpack bundle (e.g., loaded as a plain script or in Jest tests without the webpack transform), `require` will be undefined and the file will throw at runtime. The declaration is a type-only workaround, not a true polyfill.
**How to avoid:** Only add `declare const require` to files that are always built through webpack. Never add it to shared utility files that might be imported in a Node.js context without webpack. For Jest, configure `moduleNameMapper` or a transform that handles the asset requires.

---

## IPC file handle map in `bridge.ts` is process-global — leaks if renderer reloads without closing handles

**Discovered:** 2026-07-01
**File(s):** `app/lib/bridge.ts` (bridge:fs:open / bridge:fs:close handlers)
**Description:** The `_fileHandles` map and `_fileHandleCounter` are declared inside `initBridge()` and are NOT cleared when a renderer window closes or reloads. If a renderer opens a file handle via `bridge:fs:open` but crashes before calling `bridge:fs:close`, the `fs.promises.FileHandle` stays open forever (until the main process exits). The counter also keeps incrementing across reloads, so handle IDs never collide but the map grows.
**How to avoid:** Add a `webContents.on('destroyed', ...)` listener inside the `bridge:fs:open` handler (capture `event.sender`) and close all handles that were opened by that sender's window. Alternatively, scope the handle map per-sender using the webContents id as a key prefix.

---

## `getOSRelease()` returns empty string until the async IPC call resolves — race on first use

**Discovered:** 2026-07-01
**File(s):** `tabby-electron/src/services/platform.service.ts:35`
**Description:** `ElectronPlatformService._osRelease` is initialised to `''` and populated asynchronously in the constructor via `this.electron.ipc.invoke('bridge:os:release').then(...)`. Any caller of `getOSRelease()` that runs synchronously before the IPC round-trip completes (including Angular's DI initialisation) will receive an empty string.
**How to avoid:** Expose `os.release()` as a synchronous pre-loaded value via `contextBridge.exposeInMainWorld('tabbyAPI', { osRelease: os.release(), ... })` in the preload script (same pattern as `arch`, `platform`, `exePath`). Then read it synchronously in the constructor without an IPC call.

---

## Node.js `stream`/`readline` in renderer: use local interface + runtime `require()`, not ES module imports

**Discovered:** 2026-07-01
**File(s):** `tabby-terminal/src/middleware/streamProcessing.ts`
**Description:** `streamProcessing.ts` uses `PassThrough` from `'stream'` and `createInterface`/`clearLine` from `'readline'`. These are Node.js-only APIs. With `"types": []` in tsconfig, importing from `'stream'` or `'readline'` causes TS2307 "Cannot find module" errors. The correct compile-time fix is: (1) define minimal local TypeScript interfaces for the types you need, (2) declare `const require: (module: string) => any`, (3) replace the ES imports with `const { PassThrough } = require('stream') as { ... }` and `const { createInterface, clearLine } = require('readline') as { ... }`. This compiles cleanly and at runtime the `require()` calls are resolved by the Electron renderer's Node.js module system (available when `nodeIntegration: true`).
**How to avoid:** Never use `import ... from 'stream'` or `import ... from 'readline'` in any renderer-side TypeScript file compiled with `"types": []`. Always substitute local interface definitions + runtime `require()` casts.

---

## Lazy `require('winston')` in bridge.ts must be in webpack `externals` — bundling fails otherwise

**Discovered:** 2026-07-01
**File(s):** `app/lib/bridge.ts`, `app/webpack.config.main.mjs`
**Description:** `bridge.ts` uses a lazy `require('winston')` inside a function (`getWinstonLogger()`) to avoid eagerly importing the module. However, webpack's static analysis still resolves the `require()` call at bundle time and tries to include `winston` in the output. Because `winston` is not installed in `app/node_modules/` (it lives in `tabby-electron/node_modules/`), the main-process webpack build fails with "module not found: winston". The lazy pattern does NOT bypass webpack's bundling.
**How to avoid:** Any package that is `require()`-d — even lazily — inside a main-process file must be added to `externals` in `webpack.config.main.mjs`. Add both `'winston': 'commonjs winston'` and `'winston-transport': 'commonjs winston-transport'` to the externals map so webpack emits `require('winston')` instead of trying to inline the module.

---

## IPC listeners exposed via contextBridge must NOT include `_event` as first parameter

**Discovered:** 2026-07-02
**File(s):** `app/lib/sentry.ts`, `tabby-electron/src/services/hostApp.service.ts`, `tabby-electron/src/services/platform.service.ts`
**Description:** The `ipc.on` wrapper in `sentry.ts` (contextBridge preload) strips the Electron `IpcRendererEvent` before calling the listener: `const wrapped = (_event, ...a) => listener(...a)`. This means the listener is called with `(arg1, arg2, ...)` — NOT `(event, arg1, arg2, ...)`. Any code ported from the old `ipcRenderer.on` pattern that includes `_$event` or `_event` as the first listener argument will receive shifted arguments: what was `arg1` becomes `_$event`, `arg2` becomes `arg1`, and so on. The actual args are all `undefined`. This caused silent breakage in at least three places: the `cli` handler received `argv=cwd`, the `uncaughtException` handler received `err=undefined`, and any multi-arg listener similarly shifts.
**How to avoid:** When writing `electron.ipc.on(channel, listener)` calls in renderer code, the listener signature must start directly with the payload args — no event parameter. Grep for `ipc.on.*_\$event\|ipc.on.*_event` after any IPC migration to catch stale signatures.

---

## mobrowser/ IPC Migration: Electron string channels → MoBrowser Protobuf RPC (full plan)

**Discovered:** 2026-07-02
**File(s):** `mobrowser/docs/plan-ipc-migration.md`, `app/lib/bridge.ts`, `app/lib/pty.ts`, `app/lib/window.ts`, `app/lib/app.ts`
**Description:**

### 1. Comparative Analysis

#### Electron IPC Model (current)

**Transport layer:** String-keyed channels over Chromium IPC.
**API surface exposed to renderer:** `window.tabbyAPI.ipc` (set up by `app/lib/sentry.ts` preload via `contextBridge`):
```typescript
window.tabbyAPI.ipc = {
  invoke(channel, ...args): Promise<any>    // renderer → main, request-response
  send(channel, ...args): void              // renderer → main, fire-and-forget
  on(channel, listener): void              // main → renderer, event subscription
}
```
**Characteristics:**
- Completely untyped — string channels, `any` payloads, no schema
- Three patterns: request-response (`handle`/`invoke`), fire-and-forget (`on`/`send`), M→R events (`event.sender.send()`)
- ~120 channels across 5 namespaces: `bridge:`, `pty:`, `host:`/`window-`, `app:`, `updater:`
- M→R streams simulated by main calling `event.sender.send()` repeatedly — no backpressure, no lifecycle management
- One synchronous call: `app:get-paths` via `ipcRenderer.sendSync` in the preload, before Angular boots

#### MoBrowser IPC Model

**Transport layer:** Protobuf-encoded binary messages over the MoBrowser runtime IPC bus.
**API surface in renderer:** Generated typed client from `src/renderer/gen/ipc.ts`:
```typescript
await ipc.fs.Exists({ path: '/tmp/foo' })                      // Promise<ExistsResponse>
for await (const data of ipc.pty.ReadData({ ptyId })) { ... } // Stream<PtyData>
ipc.pty.ReadData({ ptyId }).subscribe({ next: handler })       // Observable-compatible
```
**Main process registers services** via generated descriptors:
```typescript
ipc.registerService(FsServiceDescriptor, {
  async Exists({ path }) { return { exists: fs.existsSync(path) } }
})
```
**Streaming — two modes:**
- **Pub/sub fan-out:** `ipc.registerService(Descriptor)` with no impl; call `service.Method(msg)` to publish to all subscribers
- **Async generator:** `async *Method(req, ctx) { yield ... }` — per-subscription resource, `ctx.signal` fires on disconnect

**`Stream<T>`** satisfies TC39 Observable, `[Symbol.asyncIterator]`, and Angular `async` pipe. RxJS: `from(stream)` converts directly.

**Key constraint:** No fire-and-forget (use unary + ignore Promise). No synchronous IPC. No spontaneous M→R push — renderer must subscribe first.

#### Model Differences

| Dimension | Electron | MoBrowser |
|-----------|----------|-----------|
| Schema | None (`any`) | Protobuf, compile-time checked |
| Call direction | Bidirectional | R→M only — renderer always initiates |
| Streaming | Ad-hoc `event.sender.send()` loop | First-class `stream<T>` in proto |
| Fire-and-forget | `ipc.send()` | Unary + ignore Promise |
| Sync call | `ipcRenderer.sendSync()` | Does not exist |
| Backpressure | None | Built-in per subscription |
| Cancellation | Manual | Automatic via `ctx.signal` |
| Preload/contextBridge | Required | Does not exist |
| Error model | Unstructured rejection | `IpcError` with `.code` + `.details` |

**Critical shift:** In Electron, main pushes events spontaneously. In MoBrowser, renderer must subscribe first. Affects ALL M→R event channels.

---

### 2. Complete Channel Inventory & Mapping (~120 channels → 13 proto files, ~70 RPC methods)

#### `bridge:fs:*` → `FsService`

| Electron channel | MoBrowser method | Pattern |
|-----------------|-----------------|---------|
| `bridge:file:read` | `FsService.ReadFile` | unary → `{data: bytes}` |
| `bridge:file:write` | `FsService.WriteFile` | unary → `Empty` |
| `bridge:fs:stat` | `FsService.Stat` | unary → `StatResult` |
| `bridge:fs:exists` | `FsService.Exists` | unary → `{exists: bool}` |
| `bridge:fs:readdir` | `FsService.ReadDir` | unary → `{entries: string[]}` |
| `bridge:fs:mkdir` | `FsService.Mkdir` | unary → `Empty` |
| `bridge:fs:open` | `FsService.OpenHandle` | unary → `{handleId: int32}` |
| `bridge:fs:read-chunk` | `FsService.ReadChunk` | unary → `{data: bytes, eof: bool}` |
| `bridge:fs:write-chunk` | `FsService.WriteChunk` | unary → `Empty` |
| `bridge:fs:close` | `FsService.CloseHandle` | unary → `Empty` |

File handle leak (existing gotcha) fixed: `ctx.signal.addEventListener('abort', ...)` closes all handles for that renderer on disconnect.

#### `bridge:path:*` → `PlatformService` or static in `GetBootstrapData`

| Electron channel | MoBrowser |
|-----------------|-----------|
| `bridge:path:basename` | `PlatformService.PathBasename` |
| `bridge:path:dirname` | `PlatformService.PathDirname` |
| `bridge:path:join` | `PlatformService.PathJoin` |
| `bridge:path:sep` | Static field in `AppService.GetBootstrapData` |
| `bridge:path:posix-sep` | Static field in `AppService.GetBootstrapData` |

Audit each call site — many can be inlined as string operations.

#### `bridge:app:*` + `app:*` → `AppService`

| Electron channel | Direction | MoBrowser method | Pattern |
|-----------------|-----------|-----------------|---------|
| `app:get-paths` (sendSync) | R→M sync | `AppService.GetBootstrapData` | unary, called via `APP_INITIALIZER` |
| `bridge:app:get-version` | R→M | Part of `GetBootstrapData` | static |
| `bridge:app:get-path` | R→M | `AppService.GetPath` | unary |
| `bridge:app:get-app-path` | R→M | Part of `GetBootstrapData` | static |
| `bridge:app:relaunch` | R→M | `AppService.Relaunch` | unary → `Empty` |
| `bridge:app:exit` | R→M | `AppService.Exit` | unary → `Empty` |
| `bridge:app:quit` | R→M | `AppService.Quit` | unary → `Empty` |
| `bridge:app:set-jump-list` | R→M | `AppService.SetJumpList` | unary → `Empty` |
| `app:save-config` | R→M | `AppService.SaveConfig` | unary → `Empty` |
| `host:config-change` | M→R event | `AppService.OnConfigChange` | **streaming** pub/sub |
| `app:register-global-hotkey` | R→M | `AppService.RegisterGlobalHotkey` | unary → `Empty` |
| `app:new-window` | R→M | `AppService.NewWindow` | unary → `Empty` |
| `plugin-manager:install` | R→M | `AppService.InstallPlugin` | unary → `Empty` |
| `plugin-manager:uninstall` | R→M | `AppService.UninstallPlugin` | unary → `Empty` |
| `app:ready` + `start` | both | Replaced by `GetBootstrapData` | — |
| `cli` | M→R event | `AppService.OnCliInvocation` | **streaming** pub/sub |
| `uncaughtException` | M→R event | `AppService.OnUncaughtException` | **streaming** pub/sub |
| `host:preferences-menu` | M→R event | `AppService.OnPreferencesRequested` | **streaming** pub/sub |

`GetBootstrapData` returns: `appVersion`, `appPath`, `userDataPath`, `exePath`, `platform`, `arch`, `osRelease`, `pathSep`, `posixPathSep`, `devMode`, `resourcesPath`, `userPluginsPath`, `installedPlugins`.

#### `pty:*` → `PtyService`

```protobuf
service PtyService {
  rpc Spawn(SpawnRequest) returns (SpawnResponse);
  rpc Exists(PtyId) returns (google.protobuf.BoolValue);
  rpc GetPid(PtyId) returns (google.protobuf.Int32Value);
  rpc Resize(ResizeRequest) returns (google.protobuf.Empty);
  rpc Write(WriteRequest) returns (google.protobuf.Empty);
  rpc Kill(KillRequest) returns (google.protobuf.Empty);
  rpc GetChildProcesses(google.protobuf.Int32Value) returns (ChildProcessList);
  rpc GetWorkingDirectory(google.protobuf.Int32Value) returns (google.protobuf.StringValue);
  rpc ReadData(PtyId) returns (stream PtyDataChunk);  // async generator, per-subscription
}
```

`ReadData` async generator implementation:
```typescript
async *ReadData({ ptyId }, ctx) {
  const pty = ptyMap.get(ptyId)
  if (!pty) throw new IpcError({ code: 'NOT_FOUND', message: `PTY ${ptyId} not found` })
  const queue = new AsyncQueue<PtyDataChunk>()
  const onData = (data: Buffer) => queue.push({ data })
  const onExit = () => queue.close()
  pty.on('data', onData); pty.on('exit', onExit)
  ctx.signal.addEventListener('abort', () => {
    pty.off('data', onData); pty.off('exit', onExit); queue.close()
  })
  yield* queue
}
```

- Dynamic `pty:{id}:data` channels → `ReadData({ ptyId })` request field
- Manual `pty:ack-data` backpressure → **eliminated** (async generator pauses naturally)
- `pty:{id}:exit` → stream completes when generator returns
- `pty:{id}:close` → absorbed into `ReadData` lifecycle

#### Window channels → `WindowService`

```protobuf
service WindowService {
  // Controls (unary, R→M)
  rpc Minimize(Empty) returns (Empty);
  rpc ToggleMaximize(Empty) returns (Empty);
  rpc BringToFront(Empty) returns (Empty);
  rpc Close(Empty) returns (Empty);
  rpc SetBounds(WindowBounds) returns (Empty);
  rpc SetAlwaysOnTop(AlwaysOnTop) returns (Empty);
  rpc SetTitle(WindowTitle) returns (Empty);
  rpc SetOpacity(WindowOpacity) returns (Empty);
  rpc SetProgressBar(ProgressBar) returns (Empty);
  rpc SetTrafficLightPosition(TrafficLightPos) returns (Empty);
  rpc SetVibrancy(VibrancyConfig) returns (Empty);
  rpc SetDarkMode(DarkModeConfig) returns (Empty);
  rpc SetWindowControlsColor(StringValue) returns (Empty);
  rpc Reload(Empty) returns (Empty);
  rpc OpenDevTools(Empty) returns (Empty);
  rpc ToggleFullscreen(Empty) returns (Empty);
  // Events (streaming pub/sub, M→R)
  rpc OnShown(Empty) returns (stream Empty);
  rpc OnMoved(Empty) returns (stream Empty);
  rpc OnFocused(Empty) returns (stream Empty);
  rpc OnEnterFullScreen(Empty) returns (stream Empty);
  rpc OnLeaveFullScreen(Empty) returns (stream Empty);
  rpc OnMaximized(Empty) returns (stream Empty);
  rpc OnUnmaximized(Empty) returns (stream Empty);
  rpc OnCloseRequest(Empty) returns (stream Empty);
  rpc OnBecameMainWindow(Empty) returns (stream Empty);
}
```

Main-side pub/sub wiring:
```typescript
const win = ipc.registerService(WindowServiceDescriptor)
browserWindow.on('focus',    () => win.OnFocused({}))
browserWindow.on('maximize', () => win.OnMaximized({}))
browserWindow.on('close',    () => win.OnCloseRequest({}))
```

Renderer Angular usage:
```typescript
from(ipc.window.OnCloseRequest({})).subscribe(() => this.closeRequest$.next())
```

#### Remaining services (summary)

| Proto file | Channels covered | Key notes |
|-----------|-----------------|-----------|
| `screen.proto` | `bridge:screen:*`, `host:displays-changed`, `host:display-metrics-changed` | 4 unary + 2 pub/sub streams |
| `dialog.proto` | `bridge:dialog:*` | 3 unary |
| `theme.proto` | `bridge:native-theme:*` | 1 unary + 1 pub/sub stream |
| `power.proto` | `bridge:power-save-blocker:*` | 2 unary |
| `menu.proto` | `bridge:menu:popup` + `bridge:menu:click` | **Single streaming RPC**: `ShowContextMenu(items)` → `stream<MenuClickEvent>` (fires once on click, completes) |
| `shell.proto` | `bridge:shell-integration:*` | 4 unary |
| `log.proto` | `bridge:log` | 1 unary, not awaited |
| `updater.proto` | `updater:*` | 2 unary + 4 pub/sub streams |
| `platform.proto` | fonts, exec, OS, color schemes, clipboard, open-external | unary |

---

### 3. Special Migration Cases

#### Preload script elimination

MoBrowser has no preload slot. `app/lib/sentry.ts` has two jobs:

1. **contextBridge setup** (`window.tabbyAPI.*`) — fully replaced by `GetBootstrapData` + typed IPC services.
2. **Sentry renderer initialization** — `@sentry/electron/dist/renderer` runs in the preload to capture errors before any app code. No earlier hook exists in MoBrowser.

**Resolution:** Move Sentry init to the **very first lines of `src/renderer/index.ts`**, before Angular imports, using `@sentry/browser` (not `@sentry/electron/dist/renderer` — that package depends on preload session tracking). Errors during evaluation of `index.ts` itself are not captured — accepted tradeoff.

```typescript
// src/renderer/index.ts — MUST be first
import * as Sentry from '@sentry/browser'
Sentry.init({ dsn: '...', ... })
// Angular bootstrap follows
```

#### Bootstrapping flow replacement

**Current:** preload `sendSync('app:get-paths')` → renderer waits for `start` M→R event → Angular bootstraps.

**MoBrowser:** renderer loads → `APP_INITIALIZER` calls `AppService.GetBootstrapData({})` → result populates `AppConfigService` → components render.

```typescript
@Injectable({ providedIn: 'root' })
export class AppConfigService {
  data: BootstrapData
  async load() { this.data = await ipc.app.GetBootstrapData({}) }
}
// Root module providers:
{ provide: APP_INITIALIZER, useFactory: (s: AppConfigService) => () => s.load(),
  deps: [AppConfigService], multi: true }
```

#### `window.tabbyAPI` complete elimination

| `window.tabbyAPI.*` | MoBrowser replacement |
|---------------------|----------------------|
| `ipc.invoke(channel, ...args)` | `await ipc.<service>.<Method>(args)` |
| `ipc.send(channel, ...args)` | `ipc.<service>.<Method>(args)` (not awaited) |
| `ipc.on(channel, listener)` | `from(ipc.<service>.OnEvent({})).subscribe(listener)` |
| `.platform` / `.arch` / `.osRelease` / `.devMode` | `appConfigService.data.*` |
| `.env.HOME` etc. | `appConfigService.data.env.*` |
| `.shell.openExternal(url)` | `PlatformService.OpenExternal({ url })` |
| `.clipboard.readText()` | `PlatformService.ClipboardReadText({})` |
| `.clipboard.write(...)` | `PlatformService.ClipboardWrite(...)` |

#### `tabby-electron` → `tabby-mobrowser`

Full replacement. `tabby-mobrowser` is the **only** package that imports `./gen/ipc`. All other packages use abstract Angular service interfaces from `tabby-core` unchanged.

Key services rewritten:

| Service | Replaces |
|---------|----------|
| `AppConfigService` | `ElectronService` (`@electron/remote` wrapper) |
| `MoBrowserPlatformService` | `ElectronPlatformService` (50+ IPC calls) |
| `MoBrowserHostAppService` | `HostAppService` |
| `MoBrowserHostWindowService` | `HostWindowService` |
| `MoBrowserDockingService` | `DockingService` |
| `MoBrowserUpdaterService` | `UpdaterService` |
| `MoBrowserShellIntegrationService` | `ShellIntegrationService` |
| `MoBrowserLogService` | `LogService` |
| `MoBrowserFileProvider` | `ElectronFileProvider` |

Plus: all shell files, PTY proxy, SSH importers, color schemes, context menus.

---

### 4. Proto File Organization

```
src/renderer/proto/
  app.proto       screen.proto    dialog.proto
  fs.proto        theme.proto     power.proto
  pty.proto       menu.proto      shell.proto
  window.proto    log.proto       updater.proto
  platform.proto
```

After `npm run gen`:
- `src/main/gen/ipc_service.ts` — all service descriptors + interfaces
- `src/renderer/gen/ipc.ts` — all typed client methods

---

### 5. Migration Rules

1. Every Electron channel → exactly one proto RPC method. No raw string channels remain.
2. **Unary by default** for all request-response and fire-and-forget channels (`Empty` response, not awaited).
3. **Streaming for all M→R events** — pub/sub fan-out when broadcast; async generator when per-subscription (PTY data).
4. **No dynamic channel names** — `pty:{id}:data` → `ReadData({ ptyId })` request field.
5. **`ctx.signal` for all cleanup** — no explicit close channels needed.
6. **`GetBootstrapData` replaces preload** — all `window.tabbyAPI.*` static fields return from one proto call.
7. **`tabby-mobrowser` is the only IPC client importer.**

---

### 6. Open Questions (resolve before writing `.proto` files)

1. **Per-window service routing:** `ipc.registerService` registers globally. `WindowService` is per-window. Does `ctx` expose which renderer window is calling? Must confirm to correctly route `OnFocused` etc. to the right `BrowserWindow`.
2. **Cold pub/sub stream semantics:** `Stream<T>` is cold. For pub/sub fan-out, when two Angular services both subscribe to `OnConfigChange`, do both receive events? If yes — correct. If only first subscriber — need `shareReplay(1)` in Angular services.
3. **`electron-updater` equivalent:** No known MoBrowser auto-update API. May need generic HTTP version check.
4. **TouchBar (`touchbar-selection`):** macOS-only, no known MoBrowser equivalent. Defer.

**How to avoid:** Resolve open question #1 before writing `.proto` files. Full plan: `mobrowser/docs/plan-ipc-migration.md`.

---

## mobrowser/ Build System Migration: Webpack → Vite (full plan)

**Discovered:** 2026-07-02
**File(s):** `mobrowser/docs/plan-build-system.md`, `mobrowser/vite.config.ts`, `mobrowser/tsconfig.json`, `mobrowser/package.json`
**Description:**

### Core difference
Electron/Tabby uses Webpack 5 with three configs (main `electron-main`, renderer `web`, plugin template UMD). MoBrowser uses Vite 8 with one dual-mode config (`mode: "main"` / `mode: "renderer"`). Module format shifts from CommonJS/UMD → ESM throughout.

### Monorepo resolution — the hardest part
The parent repo works because:
1. `scripts/install-deps.mjs` creates **symlinks**: `node_modules/tabby-core → ../tabby-core/`
2. Webpack's `modules` array searches `['.', 'src', '../app/node_modules', '../node_modules']`
3. Each `tabby-*/src/` compiles to `tabby-*/dist/index.js` (UMD) via the shared plugin webpack template
4. `plugins.ts` has module-scope `require('tabby-core')` etc. — webpack statically bundles all of them

In MoBrowser none of this exists. Resolution: **copy every `tabby-*/src/` directory into `mobrowser/src/renderer/packages/tabby-{name}/`**, then map via Vite `resolve.alias` + `tsconfig.json` `paths`:
```typescript
// vite.config.ts — renderer mode
resolve: {
  alias: {
    'tabby-core':     path.resolve(__dirname, 'src/renderer/packages/tabby-core'),
    'tabby-settings': path.resolve(__dirname, 'src/renderer/packages/tabby-settings'),
    'tabby-terminal': path.resolve(__dirname, 'src/renderer/packages/tabby-terminal'),
    'tabby-local':    path.resolve(__dirname, 'src/renderer/packages/tabby-local'),
    'tabby-electron': path.resolve(__dirname, 'src/renderer/packages/tabby-electron'),
    'tabby-ssh':      path.resolve(__dirname, 'src/renderer/packages/tabby-ssh'),
    'tabby-serial':   path.resolve(__dirname, 'src/renderer/packages/tabby-serial'),
    'tabby-telnet':   path.resolve(__dirname, 'src/renderer/packages/tabby-telnet'),
    'tabby-plugin-manager': path.resolve(__dirname, 'src/renderer/packages/tabby-plugin-manager'),
    'tabby-linkifier': path.resolve(__dirname, 'src/renderer/packages/tabby-linkifier'),
    'tabby-community-color-schemes': path.resolve(__dirname, 'src/renderer/packages/tabby-community-color-schemes'),
  }
}
```
No UMD compilation step. No symlinks. No dynamic `require()`.

### Incompatibility map and resolutions

| Area | Electron | MoBrowser resolution |
|------|----------|----------------------|
| Angular compilation | `@ngtools/webpack` (JIT) | `@analogjs/vite-plugin-angular` |
| Pug templates | `pug-loader` | `vite-plugin-pug` |
| SCSS → string | `@tabby-gang/to-string-loader` | Handled natively by Angular Vite plugin |
| SVG inline | `svg-inline-loader` | `?raw` query at each import site |
| YAML | `yaml-loader` | `@rollup/plugin-yaml` |
| PO gettext | `po-gettext-loader` | Pre-convert to JSON during copy step (`gettext-parser`) |
| Dynamic plugin loading | Runtime `require()` scan | Static imports in `src/renderer/index.ts` |
| `contextBridge` / preload | `app/lib/sentry.ts` | Does not exist — all `window.tabbyAPI.*` → MoBrowser Protobuf IPC |
| `tabby-electron` platform adapter | Wraps `@electron/remote` + Electron APIs | Replaced by new `tabby-mobrowser` package using `@mobrowser/api` IPC client |

### tsconfig.json changes required
```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "jsx": "preserve",
    "paths": {
      "tabby-core":       ["./src/renderer/packages/tabby-core/index.ts"],
      "tabby-core/*":     ["./src/renderer/packages/tabby-core/*"],
      "tabby-settings":   ["./src/renderer/packages/tabby-settings/index.ts"],
      "tabby-settings/*": ["./src/renderer/packages/tabby-settings/*"],
      "tabby-terminal":   ["./src/renderer/packages/tabby-terminal/index.ts"],
      "tabby-terminal/*": ["./src/renderer/packages/tabby-terminal/*"],
      "tabby-local":      ["./src/renderer/packages/tabby-local/index.ts"],
      "tabby-local/*":    ["./src/renderer/packages/tabby-local/*"]
    }
  }
}
```
Remove `"jsx": "react-jsx"` from scaffold. Add `experimentalDecorators` and `emitDecoratorMetadata` for Angular DI.

### New dependencies to add to `mobrowser/package.json`
- `@analogjs/vite-plugin-angular` — Angular compilation in Vite
- `@angular/core@^15` + all other `@angular/*` from parent `package.json`
- `@rollup/plugin-yaml` — YAML loader
- `vite-plugin-pug` — Pug template support
- `gettext-parser` (devDep) — PO → JSON conversion at copy time
- `zone.js` — required by Angular
- `rxjs` — required by Angular
- All runtime deps merged from each `tabby-*/package.json`

### Plugin loading change
Replace `plugins.ts` webpack module-scope `require()` calls + runtime filesystem discovery with direct static imports in `src/renderer/index.ts`:
```typescript
import TabbyCoreModule from 'tabby-core'
import TabbySettingsModule from 'tabby-settings'
// ...
platformBrowserDynamic().bootstrapModule(getRootModule([TabbyCoreModule, ...]))
```

### Main process entry
`src/main/index.ts` is net-new (not copied). Replaces `app/lib/index.ts` structurally but uses `@mobrowser/api` (`app`, `BrowserWindow`) instead of Electron. All `app/lib/bridge.ts` IPC handlers become Protobuf service registrations.

### Renderer entry
`src/renderer/index.ts` replaces `app/src/entry.ts`. Needs `src/renderer/index.html` (static Angular shell with `<app-root>`). The Vite renderer root must have an `index.html` — the parent's `index.pug` cannot be used directly.

### Native modules
All native Node.js addons (`node-pty`, `keytar`, `fontmanager-redux`, `macos-native-processlist`, `native-process-working-directory`, `@tabby-gang/windows-process-tree`, `glasstron`, `@serialport/bindings-cpp`) run in the main process only. They are listed as `dependencies` in `mobrowser/package.json` and imported in `src/main/`. No MoBrowser C++ native module slot is used.

### Open questions before implementation
1. **Angular 15 + `@analogjs/vite-plugin-angular`**: AnalogJS targets Angular 16+. May need Angular upgrade or alternative (e.g., `@angular/build` with Vite support added in Angular 17). Must resolve first.
2. **Pug in Angular Vite plugin**: Does `@analogjs/vite-plugin-angular` forward `templateUrl: 'foo.pug'` through `vite-plugin-pug`, or does it need a pre-processing step? Plugin ordering matters.
3. **`zone.js`**: Must be imported before Angular bootstraps — via explicit import in `index.html` or at the top of the renderer entry.
4. **`index.html` entry**: New file, not copied. Vite requires a static HTML root.

**How to avoid:** Before writing any build configuration or copying any source, resolve open question #1 (Angular 15 + Vite plugin compatibility). Everything else in this plan is blocked on that answer. Full plan: `mobrowser/docs/plan-build-system.md`.


## tabby-core `readClipboard()` is declared synchronous but MoBrowser clipboard is async

**Discovered:** 2026-07-02
**File(s):** `mobrowser/src/renderer/packages/tabby-mobrowser/src/services/platform.service.ts`
**Description:** `PlatformService.readClipboard()` in tabby-core has return type `string` (synchronous). The MoBrowser IPC `ipc.platform.ClipboardReadText({})` is async. The MoBrowserPlatformService caches the last clipboard text and updates it asynchronously; callers receive a slightly stale value on the first call after a copy from another app.
**How to avoid:** Accept the stale-cache pattern for now. If precise clipboard timing matters (e.g., paste into terminal), consider patching tabby-core's `readClipboard()` to be async, or proactively refresh the cache on window focus events.

## MoBrowser `from()` on a Stream requires AsyncIterable protocol

**Discovered:** 2026-07-02
**File(s):** `mobrowser/src/renderer/packages/tabby-mobrowser/src/services/hostApp.service.ts`, `hostWindow.service.ts`
**Description:** RxJS `from()` works with AsyncIterable objects. MoBrowser streams returned by `ipc.*.On*()` methods must implement `[Symbol.asyncIterator]`. The generated `createStream()` helper in `@mobrowser/api/internal/rpc` is expected to return such an object. If it doesn't (e.g., it returns a custom object with `.subscribe()` only), `from()` will throw at runtime.
**How to avoid:** Verify `createStream` return type from `@mobrowser/api/internal/rpc` before running. If it returns a custom stream with `.subscribe()` but not `[Symbol.asyncIterator]`, wrap it with a custom `fromMoBrowserStream(stream)` helper instead of bare `from()`.

## PTY `subscribe()` event names differ from tabby-local expectations

**Discovered:** 2026-07-02
**File(s):** `mobrowser/src/renderer/packages/tabby-mobrowser/src/pty.ts`
**Description:** `tabby-local`'s `PTYProxy.subscribe()` is called with event names like `'data'`, `'exit'`, `'error'`. The MoBrowserPTYProxy stores these in a Map and fires them from the `ReadData` stream subscription. If tabby-local uses different event names than expected, handlers will silently not fire.
**How to avoid:** Check `tabby-local`'s usage of `PTYProxy.subscribe()` in `session.ts` and `tabby-local/src/pty.ts` to verify the exact event names before testing.

## SWC `decoratorMetadata` erases interface re-exports before Rolldown validates them

**Discovered:** 2026-07-02
**File(s):** `mobrowser/src/renderer/packages/tabby-core/api/index.ts`, and all consumer files importing `HotkeyDescription`, `ToolbarButton`, `TerminalColorScheme`, `BootstrapData`
**Description:** When SWC compiles Angular TypeScript with `decoratorMetadata: true`, it strips TypeScript interfaces from re-exports during the metadata-emission pass. Rolldown then fails to find these identifiers in the re-export barrel (`tabby-core/api/index.ts`). The error appears as a Rolldown validation failure, not a TypeScript error, and only surfaces at bundle time — `tsc --noEmit` passes fine. Affected types: any TypeScript `interface` (not `class`) that is re-exported through a barrel and consumed in a file that SWC processes with `decoratorMetadata`.
**How to avoid:** Mark every import of a pure TypeScript interface with the `type` keyword — either `import type { Foo }` (if the whole import is type-only) or inline `import { type Foo, SomeClass }` (if mixed). This ensures SWC never tries to preserve the identifier at runtime. Apply this to all four affected types and any future interfaces added to the `tabby-core/api/index.ts` barrel.

---

## `getRootModule` must be imported from the local package copy, not a package import

**Discovered:** 2026-07-02
**File(s):** `mobrowser/src/renderer/index.ts`
**Description:** `getRootModule` lives in `app/src/app.module.ts` in the parent project — it is not exported from `tabby-core`. In the MoBrowser renderer, it must be imported from the local copied package path `./packages/tabby-core/src/app.module`. There is no `tabby-core/app.module` package export.
**How to avoid:** Always import `getRootModule` from `./packages/tabby-core/src/app.module` in the renderer entry point, not from the `tabby-core` package alias.

## SWC isolatedModules + Rolldown MISSING_EXPORT for TypeScript interfaces

**Discovered:** 2026-07-02
**File(s):** mobrowser/vite.config.ts, mobrowser/src/renderer/packages/tabby-core/api/index.ts and ~90 other files
**Description:** With SWC `decoratorMetadata: true`, SWC cannot determine in isolation whether an imported identifier is type-only. It keeps `import { SomeInterface }` in the output even when the interface is only used in type positions. Rolldown then validates exports after SWC transforms and reports `MISSING_EXPORT` for every TypeScript interface that crosses module boundaries via `export { Interface }` / `import { Interface }`.
**How to avoid:** Every TypeScript interface or type alias that is re-exported through barrel files must use `export type { Interface }`. Every consumer that imports it must use `import type { Interface }` or `import { type Interface }`. When adding new interfaces to the tabby-core/api package or any tabby-* package, always add them with the `type` keyword in both export and import sites. If `MISSING_EXPORT` appears for a new symbol, check: is it an interface? Add `type` to its import and all re-exports in the chain.

## ngx-translate and ngx-toastr Angular version compatibility

**Discovered:** 2026-07-02
**File(s):** mobrowser/package.json
**Description:** `@ngx-translate/core@18` uses `@angular/core/rxjs-interop` (Angular 17+). `ngx-toastr@20` uses Angular signals API (Angular 17+). The project uses Angular 15.
**How to avoid:** Pin `@ngx-translate/core` to `^15.0.0` and `ngx-toastr` to `^16.2.0` in package.json. Do not upgrade these without upgrading Angular first.

## `rollupOptions.onwarn` cannot suppress Rolldown hard errors

**Discovered:** 2026-07-02
**File(s):** `mobrowser/vite.config.ts`
**Description:** In Vite 8 / Rolldown, `build.rollupOptions.onwarn` only intercepts log-level warnings, not hard errors. `MISSING_EXPORT` is classified as a hard error — it does not pass through `onwarn` and cannot be silenced that way. Adding an `onwarn` handler that returns early for `MISSING_EXPORT` has no effect; the build still fails.
**How to avoid:** Do not try to suppress `MISSING_EXPORT` via `onwarn`. The only fix is to correct the TypeScript exports at the source: use `export type { }` for interfaces in re-export files and `import type { }` in consumer files.

## ngx-toastr SCSS file blocked by package `exports` field — bypass with custom Sass importer

**Discovered:** 2026-07-02
**File(s):** `mobrowser/vite.config.ts`, `mobrowser/src/renderer/packages/tabby-core/theme.vendor.scss`
**Description:** `ngx-toastr@16+` restricts SCSS file access via the package `exports` field. It exports `./toastr-bs5-alert` with only a `"default"` condition, not a `"sass"` condition. Dart Sass (used by Vite's SCSS pipeline) checks the exports field and refuses to load the file, reporting it as "not exported under the conditions [sass, style, ...]".
**How to avoid:** Add a custom Sass `importers` entry in `vite.config.ts` under `css.preprocessorOptions.scss.importers` that intercepts any URL starting with `ngx-toastr/` and resolves it directly to the filesystem path, bypassing the exports field check. See `defineRendererConfig()` in `mobrowser/vite.config.ts` for the implementation.

## Copied tabby-* packages do not carry their npm dependencies — must be installed in mobrowser/

**Discovered:** 2026-07-02
**File(s):** `mobrowser/package.json`
**Description:** When source files from the parent project's `tabby-*` packages are copied into `mobrowser/src/renderer/packages/`, their npm dependencies are NOT automatically present. The parent project's `node_modules/` is not accessible from within `mobrowser/` (isolation rule). Each package's `package.json` dependency list must be manually inspected and every transitive runtime dependency installed into `mobrowser/package.json`. Missing packages only surface as Rolldown resolve errors at build time, one package at a time.
**How to avoid:** Before running the first renderer build, grep all `.ts` files in `src/renderer/packages/` for bare-specifier imports (`import ... from 'some-package'`) and cross-check against `mobrowser/node_modules/`. Install any missing packages with `npm install --save --legacy-peer-deps`. Packages found missing in this session: hexer, binstring, buffer-replace, zmodem.js, cli-spinner, deep-equal, mz, ngx-filesize, shell-quote, slugify, thenby, tmp-promise, utils-decorators, mixpanel-browser, axios, untildify, fuzzy-search, @luminati-io/socksv5, @xterm/addon-ligatures, ngx-colors, ngx-infinite-scroll, ngx-translate-messageformat-compiler, @messageformat/core.

---

## `bridge:file:write` IPC handler passes content directly to `fs.writeFile` — string vs Buffer matters

**Discovered:** 2026-07-03
**File(s):** `app/lib/bridge.ts` (`bridge:file:write` handler), `tabby-ssh/src/services/ssh.service.ts`
**Description:** The `bridge:file:write` IPC handler in `app/lib/bridge.ts` calls `fs.writeFile(path, content)` where `content` is whatever arrives from the renderer via IPC. Electron's structured-clone serialisation converts `Buffer`/`Uint8Array` to plain arrays and strings remain strings. `fs.writeFile` accepts both strings (UTF-8 by default) and Buffers. For text-format private keys (PEM/OpenSSH) this works correctly — the SSH service passes a string produced by `new TextDecoder().decode(buffer)`. However, if a binary (non-text) private key format were passed this way, the UTF-8 re-encoding in `TextDecoder` would corrupt the bytes before writing. The handler has no explicit encoding parameter.
**How to avoid:** When writing binary data via `bridge:file:write`, pass a `Uint8Array` (not a decoded string). Verify the main-process handler correctly handles `Uint8Array` payloads (they arrive as plain arrays after structured-clone — the handler may need `Buffer.from(content)` if the data is not already a string or Buffer). For text-format keys (all current usages) the existing string path is safe.

---

## ssh.ts auth challenge response channels are one-shot ipcMain.once — duplicate connect calls will deadlock

**Discovered:** 2026-07-03
**File(s):** `app/lib/ssh.ts` (`waitForResponse`, `connectSession`, `runAuthLoop`)
**Description:** `waitForResponse<T>(channel)` registers a `ipcMain.once` listener and returns a Promise that only resolves when the renderer sends the matching one-shot response. If the renderer sends `ssh:session:connect` for a sessionId that is already mid-connect (e.g., a UI retry before the first attempt resolves), the second connect call will also register a `once` listener on e.g. `ssh:${id}:host-key-response`. The first listener consumes the response and the second connect call blocks forever. There is also no timeout — if the renderer never sends the response (e.g., window closed), the Promise hangs in the main process indefinitely.
**How to avoid:** The renderer must guarantee at most one in-flight `ssh:session:connect` per sessionId. Add a timeout wrapper around `waitForResponse` (e.g., `Promise.race([waitForResponse(...), sleep(30000).then(() => { throw new Error('timeout') })])`) to avoid permanent leaks. Alternatively, track the in-flight connect Promise per sessionId and return it for duplicate calls.

---

## ssh.ts `SSHSessionState.sftpHandles` leaks if renderer reloads without calling sftp-close

**Discovered:** 2026-07-03
**File(s):** `app/lib/ssh.ts` (`SSHSessionState.sftpHandles`, `ensureSFTP`)
**Description:** SFTP file handles opened via `ssh:session:sftp-open` are stored in `SSHSessionState.sftpHandles` and must be closed individually via `ssh:session:sftp-close`. If the renderer crashes or reloads without closing handles, or if `ssh:session:destroy` is called without the SFTP session having closed its handles, those `russh.SFTPFile` objects remain open. `cleanupSession` sets `state.sftp = null` but does not iterate and close each `sftpHandles` entry.
**How to avoid:** In `cleanupSession()`, iterate `state.sftpHandles.values()` and call `handle.close()` on each before clearing the map. Add the same cleanup to `ssh:session:destroy`.

---

## `jumpChannels` Map in ssh.ts is process-global and never pruned on session destroy

**Discovered:** 2026-07-03
**File(s):** `app/lib/ssh.ts` (`initSSH`, `ssh:session:open-jump-channel` handler)
**Description:** The `jumpChannels` Map is declared inside `initSSH` and persists for the lifetime of the main process. A jump channel ID is deleted from the map only when `connectSession` successfully consumes it. If the renderer opens a jump channel (`ssh:session:open-jump-channel`) but then never calls `ssh:session:connect` (e.g., the tab is closed before the connection completes), the `russh.NewChannel` object remains in the Map forever, leaking a live SSH channel.
**How to avoid:** Add a cleanup step: when `ssh:session:destroy` is called, also delete any `jumpChannelId` associated with that session from `jumpChannels` (requires storing the mapping). Alternatively, add a short TTL (e.g., 30 s) after which unclaimed entries are closed and removed.

---

## `SFTPSession` constructor requires a `sessionClose$` Observable — callers must pass the SSH session's close stream

**Discovered:** 2026-07-03
**File(s):** `tabby-ssh/src/session/sftp.ts:SFTPSession`, `tabby-ssh/src/session/ssh.ts:openSFTP`
**Description:** The new `SFTPSession` constructor takes `(sessionId, ipc, injector, sessionClose$: Observable<void>)`. The `sessionClose$` is fired when `ssh:{id}:close` arrives, causing the SFTP `closed$` subject to complete. If a caller constructs `SFTPSession` without providing the right `sessionClose$` (or passes a Subject that is never completed), the SFTP `closed$` will never fire and any subscribers watching `sftp.closed$` (e.g., the SFTP panel component) will leak subscriptions.
**How to avoid:** Always pass the `SSHSession.sessionClose$` observable when constructing `SFTPSession`. Do not construct `SFTPSession` directly outside of `SSHSession.openSFTP()`.

---

## `SSHSession.unsubscribers` are cleaned up in `destroy()` — if `destroy()` is called before `start()` returns, listeners may never fire

**Discovered:** 2026-07-03
**File(s):** `tabby-ssh/src/session/ssh.ts:SSHSession.start`, `tabby-ssh/src/session/ssh.ts:SSHSession.destroy`
**Description:** `start()` registers IPC listeners synchronously then calls `await ipc.invoke('ssh:session:connect', ...)`. If `destroy()` is called between listener registration and the `invoke` completing (e.g., user closes the tab), the listeners are removed but the main-process `connectSession` may still be waiting for host-key or password responses from the renderer. The main-process handlers hang indefinitely in `waitForResponse`.
**How to avoid:** The main process must have timeouts on all `waitForResponse` calls (see existing gotcha "ssh.ts auth challenge response channels are one-shot ipcMain.once"). On the renderer side, if `destroy()` is called mid-connect, send a rejection response to any pending challenge channels (e.g., send `false` to `ssh:{id}:host-key-response`) before removing the listeners.

---

## `stream`/`readline` Node.js APIs in streamProcessing.ts replaced with inline browser-compatible classes

**Discovered:** 2026-07-03
**File(s):** `tabby-terminal/src/middleware/streamProcessing.ts`
**Description:** The previous workaround for removing `import ... from 'stream'` and `import ... from 'readline'` was to use runtime `require()` calls behind local interfaces (`NodeStream`, `ReadLine`) with `declare const require`. This still depends on Node.js being present at runtime. The file now uses fully browser-compatible inline implementations: `SimplePassThrough` (EventEmitter-like write/on/emit), `SimpleReadline` (char-buffering line editor with echo and backspace), and a standalone `clearLine()` that writes ANSI `\x1b[2K\r`. The old gotcha entry ("Node.js `stream`/`readline` in renderer: use local interface + runtime `require()`") is superseded for this file.
**How to avoid:** For any renderer file that previously used `require('stream')` or `require('readline')`, use the `SimplePassThrough` / `SimpleReadline` / `clearLine` pattern from `streamProcessing.ts` instead of runtime `require()`. Do not add new `require('stream')` or `require('readline')` calls anywhere under `tabby-terminal/src/`.

---

## mobrowser tsconfig.json `@gen/*` path alias must be added manually — Vite-only alias is not enough

**Discovered:** 2026-07-05
**File(s):** `mobrowser/tsconfig.json`, `mobrowser/vite.config.ts`
**Description:** The `@gen/*` path alias (resolving to `./src/renderer/gen/*`) is defined in `vite.config.ts` but NOT in `tsconfig.json`. This means `tsc --noEmit` fails with TS2307 "Cannot find module '@gen/ipc'" on every renderer file that imports from `@gen/ipc`, even though Vite builds succeed. The alias must be explicitly added to `tsconfig.json`'s `paths` section.
**How to avoid:** Whenever adding a Vite `resolve.alias` entry for renderer code, also add a corresponding entry to `tsconfig.json` → `compilerOptions.paths`. Keep the two in sync.

---

## mobrowser/src/main/gen/ssh.ts uses `Buffer` for bytes; renderer gen uses `Uint8Array`

**Discovered:** 2026-07-05
**File(s):** `mobrowser/src/main/gen/ssh.ts`, `mobrowser/src/renderer/gen/ssh.ts`
**Description:** The two generated code trees (main vs renderer) differ in how they type binary fields. `src/main/gen/ssh.ts` types all `bytes` proto fields as `Buffer<ArrayBufferLike>`, while `src/renderer/gen/ssh.ts` types them as `Uint8Array`. Code in `src/main/ssh.ts` that pushes data into typed objects (e.g. `SshShellEvent.data`) must use `Buffer.from(uint8Array)` and `Buffer.alloc(0)`, NOT `Uint8Array` or `new Uint8Array(0)`.
**How to avoid:** When writing main-process SSH handler code, always check `src/main/gen/ssh.ts` (not the renderer gen) for the expected TypeScript types. Do not assume main and renderer generated types are identical.

---

## russh `SftpFileType` is a `const enum` — cannot use with `isolatedModules: true`

**Discovered:** 2026-07-05
**File(s):** `mobrowser/src/main/ssh.ts`, `mobrowser/node_modules/russh/lib/native.d.ts:26`
**Description:** `russh.SFTPFileType` (alias for `SftpFileType`) is declared as `export const enum SftpFileType { Directory = 0, File = 1, Symlink = 2, Other = 3 }`. Const enums are erased by tsc and their values are inlined at compile time, but this is incompatible with `"isolatedModules": true` (which is required by Vite). Using `russh.SFTPFileType.Directory` in any file compiled with isolatedModules produces TS2748: "Cannot access ambient const enums when isolatedModules is enabled."
**How to avoid:** Use numeric literals directly instead of the const enum: `0` = Directory, `1` = File, `2` = Symlink, `3` = Other. Add a comment referencing `russh.SftpFileType` for clarity.

---

## `SshSftpEntry.size` and `SshSftpStatResult.size` are `number` in proto gen — use `Number()` not `BigInt()`

**Discovered:** 2026-07-05
**File(s):** `mobrowser/src/main/gen/ssh.ts:202,213`, `mobrowser/src/main/ssh.ts`
**Description:** Despite the proto source using `uint64`/`int64` for SFTP file sizes and timestamps, the generated TypeScript in both `src/main/gen/ssh.ts` and `src/renderer/gen/ssh.ts` types these fields as `number`, not `bigint`. Passing `BigInt(value)` for these fields causes TS2322 type errors.
**How to avoid:** Always use `Number(e.metadata.size)` and `Math.floor(Number(e.metadata.mtime ?? 0))` when constructing SFTP entry/stat objects from russh metadata. Do not use `BigInt()` even though the underlying values are 64-bit integers.

---

## Web Serial cannot update baud rate or configure software flow control

**Discovered:** 2026-09-30
**File(s):** `mobrowser/src/renderer/packages/tabby-serial/api.ts`, `mobrowser/src/renderer/packages/tabby-serial/services/serial.service.ts`
**Description:** Chromium's Web Serial API only accepts baud rate while opening a port and has no xon/xoff/xany controls. It cannot exactly reproduce every option supported by `@serialport/bindings-cpp`.
**How to avoid:** Reconnect the session to change baud rate. If software flow control becomes required, add a typed main-process serial IPC service backed by the native binding rather than importing it in the renderer.

---

## MoBrowser 2.10.1/2.17 packaging misses hoisted CLI deps, N-API metadata, and peer dependencies

**Discovered:** 2026-09-30
**File(s):** `mobrowser/node_modules/@mobrowser/cli/cmake.js`, `build.js`, `mobrowser/node_modules/russh/package.json`
**Description:** `npm run dev` fails on a clean dependency tree because the CLI tests for `tar-stream` only inside its private `node_modules`, its native detector ignores `package.json#napi` and skips `.node` files larger than 1 MB, and the app packer does not include the `rxjs` peer needed by externalized `russh`. The `rxjs` omission remains reproducible after upgrading to MoBrowser 2.17.
**How to avoid:** Until fixed upstream, link the hoisted `tar-stream` into the CLI, treat `napi` metadata as native, and make `rxjs` a runtime dependency of the packaged `russh` tree. These are local `node_modules` workarounds and are lost on reinstall.

---

## Angular JIT `templateUrl` must be inlined in the MoBrowser Vite build

**Discovered:** 2026-10-01
**File(s):** `mobrowser/vite.config.ts`, copied Angular components
**Description:** Without build-time resource rewriting, Angular resolves relative Pug `templateUrl` values from the document URL. Vite then falls back to `index.html`, whose `<app-root>` recursively instantiates the root component. Pug also emits bare Angular references as `#name="#name"` and needs the legacy SVG `require()` local.
**How to avoid:** Keep component Pug compilation, SVG inlining, and template-reference normalization centralized in `angularResourcesPlugin()`; do not convert individual copied components unless they need component-specific changes.

---

## Angular JIT `styleUrls` bypass Vite's CSS pipeline

**Discovered:** 2026-10-01
**File(s):** `mobrowser/vite.config.ts`, copied Angular components
**Description:** Vite does not see SCSS/CSS paths left inside Angular JIT `styleUrls`, so Angular resolves them from the document URL and components retain browser-default layout. Webpack-era `require('*.svg')` calls also expect raw SVG markup in this codebase, not emitted asset URLs.
**How to avoid:** Keep the shared resource transform that rewrites literal `styleUrls` to `?inline` imports and SVG requires to `?raw` imports. Validate with `npm exec vite build -- --mode renderer` and MoBrowser automation rather than patching individual components.

---

## Pug bare `translate` attributes need normalization

**Discovered:** 2026-10-01
**File(s):** `mobrowser/vite.config.ts`, copied Pug templates
**Description:** Pug renders `(translate)` as `translate="translate"`. ngx-translate treats that value as an explicit key, so the UI displays `translatetranslate` instead of translating the element text.
**How to avoid:** Keep the normalization to `translate=""` in the shared Pug renderer. Also retain the standalone entry's copied preload/global SCSS and font/icon imports; component styles alone do not provide Tabby's renderer-wide layout, logo, fonts, or icons.

---

## Copied Tabby adapters must preserve their original contracts and synchronous metadata

**Discovered:** 2026-10-01
**File(s):** `mobrowser/src/renderer/packages/tabby-mobrowser/src/pty.ts`, `services/appConfig.service.ts`, copied `tabby-local` files
**Description:** `PTYInterface.spawn` is called as `(command, args, options)`; treating its first argument as an options object sends an empty executable to main. Copied renderer code also reads platform/env synchronously even though MoBrowser bootstrap data arrives asynchronously.
**How to avoid:** Preserve the three-argument PTY signature. Populate only a data-only `window.tabbyAPI` platform/arch/osRelease/env compatibility object after bootstrap; route filesystem and PTY operations through generated IPC, never through an Electron-style IPC shim.

---

## `node-pty` spawn helpers cannot execute from MoBrowser's virtual `/app`

**Discovered:** 2026-10-01
**File(s):** `mobrowser/src/main/index.ts`, `mobrowser/mobrowser.conf.json`, `mobrowser/package.json`
**Description:** `node-pty` 1.1 loads its addon from virtual `/app` and derives `/app/node_modules/node-pty/prebuilds/.../spawn-helper`. Native `posix_spawn` cannot execute that virtual path. MoBrowser 2.17's `nodeModules` packaging also omits the helper, and npm installs it without an executable bit.
**How to avoid:** Copy/sign the helper as a macOS bundle extra, restore its executable bit in postinstall, and replace the helper-path argument at the native fork boundary with the physical path below `app.getPath('appResources')`. A loaded `.node` addon does not prove its sidecar executables are usable.

---

## xterm private fields changed in xterm 6

**Discovered:** 2026-10-01
**File(s):** `mobrowser/src/renderer/packages/tabby-terminal/frontends/xtermFrontend.ts`
**Description:** The copied frontend writes `browser.isWindows/isLinux/isMac`, but xterm 6 exposes them as getter-only. Its old private `viewport` object may also be absent, making unconditional `_refresh()` calls throw during resize.
**How to avoid:** Do not overwrite xterm's platform detection. Guard optional private refresh hooks and rely on the public fit/resize behavior when the private object is absent.

---

## MoBrowser tab removal can remain stuck after its animation finishes

**Discovered:** 2026-10-02
**File(s):** `mobrowser/src/renderer/packages/tabby-core/components/appRoot.component.ts`, `appRoot.component.pug`
**Description:** Closing an active terminal starts the 250 ms `animateTab` leave transition and logs the session as `Destroying`, but the underlying Web Animation can reach `finished` while Angular keeps the header in `ng-animating`. The closing and fallback headers both remain `active`, and the closed tab's `/bin/zsh --login` process remains alive.
**How to avoid:** Do not assume a close command or a finished Web Animation proves tab cleanup. Until the Angular/MoBrowser animation-completion path is fixed, verify that the header leaves the DOM and the PTY child exits; disable the tab animation as a diagnostic/minimal fallback.

---

## MoBrowser automation references become stale across tab mutations

**Discovered:** 2026-10-02
**File(s):** `mobrowser/.mobrowser/agent.json`, Angular tab UI
**Description:** Snapshot refs can still resolve while tab enter/leave animation nodes are being retained or reordered. An orphaned app after its Vite server exits also keeps an automation endpoint but produces `ERR_CONNECTION_REFUSED` and streaming `write EPIPE` failures.
**How to avoid:** Confirm the dev server and app belong to the same live run, then take a fresh snapshot after every tab create/close/select action instead of reusing refs.

---

## MoBrowser migration advice is toolchain-version-specific

**Discovered:** 2026-10-02
**File(s):** `mobrowser/package.json`, `mobrowser/AGENTS.md`, `docs/technical/electron-to-mobrowser-migration-gotchas.md`
**Description:** The migration evidence spans MoBrowser 2.10.1 through 2.17.0, and API names, generated documentation, Node requirements, native packaging behavior, and automation support changed across those releases. A workaround or API remembered from another version can be wrong even when the architectural guidance remains valid.
**How to avoid:** Pin the MoBrowser and Node versions, consult the documentation generated into the installed `@mobrowser/api` package, label version-specific workarounds, and re-run clean-install, packaging, and runtime checks before carrying a workaround forward.

---

## Vite 8 OXC and a custom SWC pass can double-transform renderer TypeScript

**Discovered:** 2026-10-02
**File(s):** `mobrowser/vite.config.ts`
**Description:** Vite 8's built-in OXC TypeScript transform can run in addition to `unplugin-swc`. In this Angular 15 renderer, OXC strips type information before the SWC decorator-metadata and Rolldown module-analysis stages, worsening type/value import detection and export validation.
**How to avoid:** Use one TypeScript transformation path. When SWC is responsible for legacy decorators and decorator metadata, set `oxc: false` in the renderer Vite config and keep type-only imports/exports explicit. Re-evaluate this setting when changing Vite, SWC, or framework versions.

---

## Repository-local agent skill prompts are not authoritative MoBrowser documentation

**Discovered:** 2026-10-02
**File(s):** `.claude/skills/mobrowser-migration.md`, `mobrowser/node_modules/@mobrowser/api/docs/`
**Description:** The local migration prompt contains version-sensitive assertions that do not match the installed MoBrowser 2.17 documentation. For example, the installed docs expose native context-menu handling and `CheckboxMenuItem.setChecked()`, while the prompt describes those capabilities as absent. Promoting prompt text directly into engineer-facing documentation would preserve stale guidance.
**How to avoid:** Treat skill files as automation behavior, not product documentation. Validate every technical claim against the installed MoBrowser docs and current implementation before extracting it into `docs/technical`.

---

## The copied MoBrowser renderer has drifted behind browser-safe parent implementations

**Discovered:** 2026-10-02
**File(s):** `mobrowser/src/renderer/packages/tabby-terminal/middleware/streamProcessing.ts`, `tabby-terminal/src/middleware/streamProcessing.ts`, `mobrowser/src/renderer/packages/tabby-ssh/session/shell.ts`, `mobrowser/src/renderer/packages/tabby-local/environment.ts`
**Description:** The parent terminal middleware contains browser-compatible pass-through/readline classes, but the MoBrowser copy still lazily requires Node `stream` and `readline`. The renderer also retains runtime/type-level `Buffer` in SSH and dynamic `windows-native-registry` requires in Windows providers. The macOS local-shell happy path does not execute these branches, so it can pass while the renderer boundary remains incomplete.
**How to avoid:** Re-run a Node/native/global audit against the actual copied MoBrowser renderer after every parent-side migration. Port browser-safe changes into the copy, move Windows registry access behind typed main IPC, and test optional/platform-specific branches rather than inferring completeness from the default macOS path.
