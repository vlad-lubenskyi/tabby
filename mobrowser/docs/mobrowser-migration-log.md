# MoBrowser Migration Log

<!-- Format:
## YYYY-MM-DD - <short topic>

- **Area:** <subsystem or file>
  **Decision/Observation:** <what was decided or discovered>
  **Consequence:** <what this means for future work>
-->

---

## 2026-09-30 - Remove remaining renderer Node/native dependencies

- **Area:** `tabby-linkifier`, `tabby-telnet`, and `tabby-serial`
  **Decision/Observation:** File-link checks and path resolution belong behind existing typed IPC; raw Telnet TCP requires a streamed main-process service; serial can use Chromium's native Web Serial API directly instead of Node SerialPort bindings.
  **Consequence:** Add `PlatformService.ResolvePath`, `TelnetService`, and replace the serial binding stack with Web Serial. Changing baud rate reconnects because Web Serial cannot update an open port's baud rate.

## 2026-07-02 - IPC Migration Analysis

- **Area:** IPC — Electron string channels vs MoBrowser Protobuf RPC
  **Decision/Observation:** See `docs/plan-ipc-migration.md` for the full analysis and migration plan. Key decisions: every Electron channel maps to one proto RPC method; all M→R event channels become server-streaming RPCs (pub/sub fan-out); PTY data streaming uses async generator with `ctx.signal` cleanup; `app:get-paths` sendSync replaced by `AppService.GetBootstrapData` called from `APP_INITIALIZER`; `window.tabbyAPI.*` eliminated entirely; `tabby-electron` → `tabby-mobrowser` (only package that imports MoBrowser IPC client).
  **Consequence:** 13 `.proto` files, ~70 RPC methods. `tabby-mobrowser` is the only package that knows about `./gen/ipc`. All other packages continue to use abstract Angular service interfaces from `tabby-core`. Four open questions to resolve before implementation (per-window service routing, updater equivalent, cold/hot stream semantics for pub/sub, TouchBar).

## 2026-07-02 - Build System Analysis

- **Area:** Build tooling — Webpack (Electron) vs Vite (MoBrowser)
  **Decision/Observation:** See `docs/plan-build-system.md` for the full analysis and migration plan.
  **Consequence:** Angular requires `@analogjs/vite-plugin-angular`; monorepo packages require Vite path aliases; several webpack loaders need Vite equivalents or pre-processing. No shims or polyfills.

## 2026-07-02 - Phase 3: Main process entry point implemented

- **Area:** `src/main/index.ts`
  **Decision/Observation:** Replaced the scaffold stub with a full main process implementation registering all 10 IPC services (AppService, FsService, LogService, PlatformService, PtyService, WindowService, DialogService, ScreenService, MenuService, PowerService, ThemeService, UpdaterService, ShellService). Used a reusable `AsyncQueue<T>` + `PubSub<T>` pattern for all streaming/event channels. Imports all service descriptors from `./gen/ipc_service`. No imports from electron.
  **Consequence:** Several stubs are marked explicitly: OpenExternal (no MoBrowser shell equivalent confirmed in docs), ListFonts (needs native module), GetCursorPoint (needs native module), GetDisplayNearestPoint (no API in MoBrowser Displays), ProgressBar (no window progress bar API), SetWindowControlsColor (no API), power blocker, jump list, global hotkey, shell integration, and updater. These stubs must be revisited once native module bindings or additional MoBrowser APIs are confirmed. The `win.handle('close', async () => 'hide')` approach means the window only hides on close request and the renderer must call `Exit`/`Quit` to actually quit — consistent with Tabby's existing behavior.

## 2026-07-02 - Phase 1: Proto files and build system written

- **Area:** `src/renderer/proto/` — all 13 IPC proto files
  **Decision/Observation:** Wrote all 13 proto files (app, dialog, fs, log, menu, platform, power, pty, screen, shell, theme, updater, window) replacing scaffold `app.proto` and deleting `greet.proto`. `npm run gen` ran successfully and produced TypeScript stubs in `src/renderer/gen/` and `src/main/gen/`. Residual `greet.ts`/`greet_client.ts` stubs in renderer/gen are generated from `src/native/proto/greet.proto` (native scaffold) — not a problem.
  **Consequence:** All IPC service contracts are now defined. Next phase: implement service handlers in `src/main/` and Angular service wrappers in `tabby-mobrowser`.

- **Area:** `package.json` — dependencies added
  **Decision/Observation:** Added Angular 15 packages, zone.js, rxjs, node-pty, keytar, @sentry/browser, js-yaml, slug, color as runtime deps; @analogjs/vite-plugin-angular, @rollup/plugin-yaml, vite-plugin-pug, gettext-parser, sass as devDeps. Versions pinned to match parent Electron project.
  **Consequence:** `npm install` required before building. node-pty and keytar are native addons that must be built on the host platform.

- **Area:** `tsconfig.json` — compiler options and path aliases
  **Decision/Observation:** Changed `jsx` from `react-jsx` to `preserve` (required for Angular templates via @analogjs); added `experimentalDecorators: true` and `emitDecoratorMetadata: true` for Angular DI; added `paths` entries for all 11 tabby packages pointing to `src/renderer/packages/tabby-{name}/index.ts`.
  **Consequence:** TypeScript will resolve `tabby-core` etc. from local copies. Package directories must exist before compilation succeeds.

- **Area:** `vite.config.ts` — renderer config extended
  **Decision/Observation:** Added `@analogjs/vite-plugin-angular`, `@rollup/plugin-yaml`, and `vite-plugin-pug` plugins to `defineRendererConfig()`. Added `resolve.alias` for all 11 tabby packages. Main config left unchanged.
  **Consequence:** Vite will compile Angular components, load YAML files, and process Pug templates. Plugin versions must be compatible with Vite 8.

## 2026-07-02 - Phase 2: tabby-* source packages bulk-copied into renderer/packages/

- **Area:** `src/renderer/packages/` — 10 tabby source packages copied verbatim
  **Decision/Observation:** Bulk-copied `src/` contents from 10 parent tabby packages into `mobrowser/src/renderer/packages/{package-name}/`. Packages copied: tabby-core (126 files), tabby-settings (41 files), tabby-terminal (68 files), tabby-local (24 files), tabby-ssh (45 files), tabby-serial (13 files), tabby-telnet (11 files), tabby-plugin-manager (6 files), tabby-linkifier (5 files), tabby-community-color-schemes (2 files). Total: 341 files. `tabby-electron` was deliberately excluded — it will be replaced by `tabby-mobrowser` (written from scratch).
  **Consequence:** All tsconfig `paths` aliases (added in Phase 1) now resolve. Files are verbatim copies from the parent Electron project; `// Copied from:` / `// Derived from:` headers must be added when individual files are modified.

- **Area:** `src/renderer/packages/` — Electron/IPC reference audit
  **Decision/Observation:** Scanned all 341 copied TypeScript files for `window.tabbyAPI`, `ipcRenderer`, `ipcMain`, `@electron/remote`, and `electron` imports. No direct `electron` module imports were found. The only references are to `window.tabbyAPI.*` (the contextBridge shim), which is already the post-hardening pattern from the parent project. Specific files requiring adaptation for MoBrowser:

  **`window.tabbyAPI` references (must be replaced with MoBrowser IPC equivalents):**
  - `tabby-core/utils.ts` — reads `window.tabbyAPI.platform` and `window.tabbyAPI.osRelease`
  - `tabby-core/services/hotkeys.util.ts` — reads `window.tabbyAPI.platform`
  - `tabby-core/services/homeBase.service.ts` — reads `window.tabbyAPI.arch`
  - `tabby-local/environment.ts` — reads `window.tabbyAPI.platform` and `window.tabbyAPI.env`
  - `tabby-local/cli.ts` — uses `window.tabbyAPI.ipc` for IPC calls
  - `tabby-local/session.ts` — uses `window.tabbyAPI.ipc` and `window.tabbyAPI.env`
  - `tabby-local/services/terminal.service.ts` — uses `window.tabbyAPI.ipc`
  - `tabby-local/components/environmentEditor.component.ts` — reads `window.tabbyAPI.platform`
  - `tabby-terminal/middleware/oscProcessing.ts` — reads `window.tabbyAPI.env.HOME/USERPROFILE`

  **Node.js built-in imports (require shimming or IPC delegation for browser/MoBrowser context):**
  - `tabby-telnet/session.ts` — imports `Socket` from `'net'`
  - `tabby-linkifier/handlers.ts` — imports `path` from `'path'`
  - `tabby-ssh/components/sftpPanel.component.ts` — imports `posix as path` from `'path'`
  - `tabby-ssh/session/x11.ts` — imports `Socket, SocketConnectOpts` from `'net'`
  - `tabby-ssh/session/ssh.ts` — imports `Socket` from `'net'`
  - `tabby-ssh/session/sftp.ts` — imports `posixPath` from `'path'`
  - `tabby-ssh/session/forwards.ts` — imports `Server, Socket, createServer` from `'net'`

  **Consequence:** `window.tabbyAPI.*` usages must be replaced with calls to the MoBrowser `AppService.GetBootstrapData` RPC (for platform/env/arch) and the `tabby-mobrowser` IPC client (for dynamic IPC calls). Node.js `net` and `path` imports need MoBrowser-compatible equivalents — `path` can use the browser-compatible `path-browserify` shim; `net` (raw TCP sockets) will need MoBrowser native IPC delegation. These files are the primary work items for Phase 3.

## 2026-07-02 - Phase 4: tabby-mobrowser Angular package written

- **Area:** `src/renderer/packages/tabby-mobrowser/` — new Angular package replacing tabby-electron
  **Decision/Observation:** Wrote all service, shell, and utility files for the tabby-mobrowser Angular package. Key architectural decisions:
  - `AppConfigService` bootstraps via `APP_INITIALIZER` — calls `ipc.app.GetBootstrapData({})` before any Angular service is constructed. This replaces the `ipcBridge.once('start', ...)` pattern from `app/src/entry.ts`.
  - `MoBrowserHostAppService` and `MoBrowserHostWindow` subscribe to server-streaming RPCs (`ipc.app.On*`, `ipc.window.On*`) using RxJS `from()` on MoBrowser streams. The `from()` interop works because MoBrowser streams implement the AsyncIterable protocol (confirmed from gen code shape).
  - PTY streaming uses `ipc.pty.ReadData()` (server-streaming) with RxJS. The old subscribe/ackData/unsubscribeAll interface is preserved but internally event-handler callbacks are collected in a Map and fired from the stream subscription. `ackData` is a no-op (MoBrowser uses stream backpressure).
  - `readClipboard()` in PlatformService is technically async in MoBrowser but tabby-core declares it as synchronous. Resolved by returning the cached value and updating asynchronously — acceptable for UI copy usage.
  - `popupContextMenu()` maps `MenuItemOptions[]` to `MenuItemDefinition[]` with generated IDs, then subscribes to the `ShowContextMenu` stream to receive click events and dispatch back to Angular zone.
  - Shell providers that used `window.tabbyAPI.env.*` now read from `AppConfigService.data.env`. Shell providers that used `window.tabbyAPI.ipc.*` now use `ipc.fs.*` and `ipc.platform.*` directly.
  - Windows-only shells that use `windows-native-registry` retain the dynamic `require` try/catch pattern.
  - `getRootModule` in tabby-core's app.module is a local copy at `packages/tabby-core/src/app.module.ts` — not a package import.
  **Consequence:** The full tabby-mobrowser module is now writable. Next: TypeScript compilation to verify type correctness, then address `window.tabbyAPI.*` references in the copied tabby-* packages (Phase 5).

- **Area:** `src/renderer/index.ts` — Angular renderer entry point
  **Decision/Observation:** The bootstrap flow: (1) instantiate `AppConfigService` manually (before Angular DI is up), (2) call `load()` to fetch bootstrap data via IPC, (3) construct `tabbyCoreBootstrap` conforming to `tabby-core/BOOTSTRAP_DATA` token shape, (4) statically import all 11 plugin modules, (5) call `getRootModule(plugins)` from the local copy of `app/src/app.module.ts`, (6) bootstrap with `platformBrowserDynamic([{provide: BOOTSTRAP_DATA, useValue: ...}])`. Config YAML is pre-read from `userDataPath/config.yaml` and attached as `rawConfig` for `ConfigService` to consume.
  **Consequence:** No plugin discovery at runtime — all plugins are statically bundled. This is a deliberate simplification for the MoBrowser build. Plugin blacklisting and user plugin loading can be added in a later phase.

- **Area:** `src/renderer/index.html` — replaced MoBrowser scaffold
  **Decision/Observation:** Replaced the MoBrowser Vite scaffold HTML (greeting demo) with a minimal Angular shell containing `<app-root></app-root>` and a module script entry pointing to `index.ts`. The old scaffold (`main.ts`, greet demo, etc.) can be deleted in a cleanup pass.
  **Consequence:** `main.ts` (the old scaffold entry) is now orphaned — Vite will no longer load it as the entry point. It should be deleted or the Vite config `build.rollupOptions.input` updated if it is still referenced.

## 2026-07-02 - SWC isolated-modules & Rolldown MISSING_EXPORT

- **Area:** `vite.config.ts` + all `tabby-*/api/index.ts` + ~40 package files
  **Decision/Observation:** SWC in isolated-modules mode cannot determine if an imported identifier is type-only without cross-file type info. With `decoratorMetadata: true`, it's even more conservative and keeps `import { SomeInterface }` in the output. Rolldown then does post-transform export validation and reports MISSING_EXPORT for every erased TypeScript interface.
  **Consequence:** All TypeScript interfaces that cross module boundaries must use `export type { }` in re-export files and `import type { }` or `import { type X }` in consumer files. This is an ongoing fix applied across all ~40 files in `src/renderer/packages/`.

- **Area:** `vite.config.ts` renderer `rollupOptions.external`
  **Decision/Observation:** Replaced the static array of native module names with a function that also externalizes all Node.js built-in modules (`path`, `fs`, `net`, `crypto`, etc.). Renderer packages (tabby-ssh, tabby-local, tabby-serial, tabby-telnet) all import Node built-ins directly — these must not be bundled since the renderer sandbox has no Node access. They'll need IPC shims in a later phase.
  **Consequence:** The renderer build succeeds structurally, but these packages will not function at runtime until IPC shims replace the Node API calls.

- **Area:** `vite.config.ts` renderer `css.preprocessorOptions.scss.importers`
  **Decision/Observation:** `ngx-toastr@20` added package `exports` field restricting SCSS import paths. Added a custom Sass importer in Vite config to bypass the exports restriction and load `toastr-bs5-alert.scss` directly from the filesystem. Downgraded to `ngx-toastr@16.2.0` (compatible with Angular 15, no signals API, has bs5 SCSS).
  **Consequence:** `theme.vendor.scss` can import ngx-toastr SCSS without modification.

- **Area:** Main process build
  **Decision/Observation:** Main process (`src/main/index.ts`) builds successfully with 52 modules via `npx vite build --mode main`. Node built-in warnings appear but don't fail the build because the main process runs in Node context where these modules ARE available.
  **Consequence:** Main process build is complete. Renderer build is in progress (fixing MISSING_EXPORT errors).

## 2026-07-02 - Renderer build succeeds (1202 modules)

- **Area:** `vite.config.ts` + `package.json` + ~90 source files
  **Decision/Observation:** The renderer build now succeeds after: (a) comprehensive `export type`/`import type` fixes across all 11 packages for TypeScript interfaces, (b) installing 20+ missing npm dependencies (cli-spinner, deep-equal, zmodem.js, buffer-replace, etc.), (c) externalizing native modules (russh, serialport-binding-webserialapi, all @serialport/* packages), (d) downgrading ngx-toastr to v16 and @ngx-translate/core to v15 for Angular 15 compatibility.
  **Consequence:** Both `out/main/index.js` and `out/renderer/assets/index-*.js` exist. The application can now be launched. Runtime functionality still requires IPC shims for Node-API-using packages (tabby-ssh, tabby-local, tabby-serial, tabby-telnet).

## 2026-09-30 - Development app launches

- **Area:** `vite.config.ts`, `src/renderer/packages/tabby-terminal/middleware/`
  **Decision/Observation:** Replaced the renderer's `hexer` import with a browser-native `Uint8Array` formatter and added a narrow Vite transform for webpack-style literal SVG `require()` calls. The formatter has a direct Node test. `npm run dev` now builds and leaves the MoBrowser main, GPU, network, and renderer processes running.
  **Consequence:** The application window can reach the renderer in development mode. Vite still warns that the optional Windows-only `windows-native-registry` package cannot be scanned on macOS; it does not stop this launch.

- **Area:** local MoBrowser 2.10.1 toolchain under `node_modules`
  **Decision/Observation:** Launch required local workarounds for three packaging defects: the CLI checks only its private directory for hoisted `tar-stream`, does not recognize `package.json#napi` as native metadata, and does not copy `russh`'s `rxjs` peer dependency.
  **Consequence:** The workarounds are intentionally confined to `node_modules` and will disappear after reinstall. They should be fixed upstream or replaced with a project-owned install/packaging hook before launch is expected on a clean checkout.

## 2026-10-01 - Renderer bootstrap completes

- **Area:** Angular/Vite bootstrap and copied component resources
  **Decision/Observation:** Static plugins now load the core `forRoot()` providers, expose their module list to `ConfigService`, and bootstrap the explicit root component. The Vite Pug plugin inlines `templateUrl` resources, legacy SVG requires, and Angular template references; otherwise JIT resolved templates to `index.html` and recursively rendered `<app-root>`.
  **Consequence:** `npm run dev` reaches config readiness and locale initialization without renderer errors.

- **Area:** bootstrap configuration lifecycle
  **Decision/Observation:** The root injector reuses the already-loaded `AppConfigService`, and a missing first-run `~/.tabby/config.yaml` is treated as an empty config like the Electron bridge.
  **Consequence:** The first launch no longer races an uninitialized config service or rejects on a missing config file.

## 2026-10-01 - MoBrowser 2.17 automation upgrade

- **Area:** `package.json`, `package-lock.json`, MoBrowser development tooling
  **Decision/Observation:** Upgraded the API, CLI, native package, and all platform SDK declarations from 2.10.1 to 2.17.0 because built-in AI automation was introduced after 2.10.1. The upgrade requires Node 24 for this project and `--legacy-peer-deps` because of the existing unused AnalogJS/Angular peer mismatch.
  **Consequence:** Development launches can use `--automation` plus the built-in snapshot, screenshot, console, and evaluation commands. The 2.17 API package does not initially contain `docs/`, so `npm run gen` must restore the project-local reference before further MoBrowser API changes.

- **Area:** `CMakeLists.txt`, MoBrowser 2.17 native module
  **Decision/Observation:** Replaced the older direct Protobuf/Abseil include list with 2.17's `mobrowser_configure_app_lib(mobrowser_lib)` helper. The old variables are unset when 2.17 selects a prebuilt Protobuf toolchain, causing missing `google/protobuf/*.h` errors.
  **Consequence:** Native builds work with both the prebuilt and source-fetched Protobuf modes selected by the framework.

- **Area:** MoBrowser 2.17 native Node-module packaging
  **Decision/Observation:** The 2.17 arm64 packer rejects `node-pty` and `russh` because their npm packages also contain unused Darwin x64 binaries, even though matching arm64 prebuilds are present.
  **Consequence:** The unused Darwin x64 prebuilds must be excluded locally for an arm64 development build until the CLI filters per-architecture alternatives; reinstalling dependencies restores them.

## 2026-10-01 - Angular component styles restored

- **Area:** `vite.config.ts`, copied Angular component resources
  **Decision/Observation:** Angular JIT leaves `styleUrls` for its resource loader, but Vite does not compile those decorator URLs. The shared Angular resource transform now converts every literal `styleUrls` entry into a Vite `?inline` import and passes the resulting CSS through `styles`. Legacy TypeScript `require('*.svg')` values are likewise loaded with `?raw`, because their consumers inject SVG markup rather than expecting an asset URL.
  **Consequence:** All copied component SCSS/CSS is compiled centrally without editing 32 components, and toolbar SVG strings no longer render as visible data URIs.

- **Area:** production CSS compatibility and automation verification
  **Decision/Observation:** Replaced the sole legacy `:host /deep/` selector with `:host ::ng-deep`. MoBrowser 2.17 automation confirmed `app-root` changed from the browser default `display: inline; height: auto` to `display: flex; height: 800px`, found six inline toolbar SVGs and zero leaked data-URI strings, and captured `.mobrowser/after-styles.png`.
  **Consequence:** `npm exec vite build -- --mode renderer` succeeds. Remaining Sass deprecation and Lightning CSS Angular-pseudo warnings are non-fatal migration cleanup, not blockers for component styling.

## 2026-10-01 - Localization and renderer-wide styles restored

- **Area:** `vite.config.ts`, Pug templates
  **Decision/Observation:** Pug serializes a bare `(translate)` attribute as `translate="translate"`. Since ngx-translate exposes `translate` as an input, every directive received the literal key `translate` instead of deriving its key from the element text. The shared Pug renderer now normalizes that generated value to `translate=""`.
  **Consequence:** All copied Pug views use their text content as the localization key again; no component-by-component template edits are needed.

- **Area:** `src/renderer/index.ts`, `global.scss`, `preload.scss`, renderer dependencies
  **Decision/Observation:** The standalone entry omitted the original renderer's preload/global SCSS, Source Sans/Code fonts, and Font Awesome CSS. Those existing entry resources are now copied/imported, with the logo served from the standalone public directory.
  **Consequence:** MoBrowser automation confirms English localization, the bundled Source Sans font, the Tabby logo, `form-line` flex layout, and the expected control styling. `.mobrowser/localization-fixed.png` captures the result, and the renderer production build passes.

## 2026-10-01 - Local terminal happy path verified

- **Area:** copied xterm/local-terminal compatibility
  **Decision/Observation:** xterm 6 exposes its platform flags as getter-only and may not create the old private `viewport` object. Removed writes to the platform flags and made the optional private viewport refresh conditional. Copied `tabby-local` still needs synchronous platform/env metadata, so bootstrap installs a data-only `window.tabbyAPI` compatibility object; filesystem calls use generated MoBrowser IPC directly. `MoBrowserPTYInterface.spawn` now preserves Tabby's `(command, args, options)` contract.
  **Consequence:** Terminal construction and resizing no longer fail on missing/getter-only xterm internals. The compatibility object exposes no Electron IPC or native capability.

- **Area:** `node-pty` 1.1 packaging under MoBrowser 2.17
  **Decision/Observation:** `node-pty` resolves its macOS `spawn-helper` below virtual `/app`, which native `posix_spawn` cannot execute. MoBrowser's declared `nodeModules` copy also omits that helper. The macOS bundle now copies/signs it as an explicit extra, postinstall restores its executable bit, and the main process redirects the native fork call to the physical `appResources` copy. MoBrowser 2.17 still omits `russh`'s `rxjs` peer, so the earlier local packaging workaround remains required.
  **Consequence:** A restored OS-default `/bin/zsh --login` session launches, accepts `printf 'MOBROWSER_HAPPY_PATH_OK\\n'`, and renders the expected output. Automation captured `.mobrowser/happy-path-terminal.png`; the app remains running with automation enabled.

## 2026-10-02 - UI smoke scenarios

- **Area:** Settings and Appearance UI
  **Decision/Observation:** MoBrowser automation opened Settings, navigated to Appearance, and toggled the Blink cursor setting off and back on. The localized labels, component styles, font preview, inputs, and toggles rendered correctly, and the setting returned to its original value.
  **Consequence:** The settings navigation and reversible preference-edit path passes. Automation captured `.mobrowser/scenario-settings-appearance.png`.

- **Area:** Terminal tab lifecycle
  **Decision/Observation:** Creating an OS-default tab and running `printf 'SCENARIO_NEW_TAB_OK\\n'` succeeds, but closing that active tab does not complete. Its 250 ms Web Animation reaches `finished` while Angular leaves the `tab-header` in `ng-animating`; the old and fallback headers both retain `active`, and the new `/bin/zsh --login` process remains alive. The console records the renderer-side session as `Destroying` without an exception.
  **Consequence:** Tab creation/input/output passes, but close/cleanup fails under MoBrowser. Automation captured `.mobrowser/scenario-new-tab.png` and `.mobrowser/scenario-tab-close-stuck.png`; diagnose Angular animation completion integration before treating repeated open/close as safe.

- **Area:** Automation/runtime state
  **Decision/Observation:** An orphaned MoBrowser process whose Vite server had stopped produced `ERR_CONNECTION_REFUSED` and `write EPIPE`; after a clean relaunch, element references also became stale across tab enter/leave transitions.
  **Consequence:** Start UI scenarios from a live dev-server process and take a fresh accessibility snapshot after every tab mutation. Command completion alone does not mean Angular's tab animation has settled.
