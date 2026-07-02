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
