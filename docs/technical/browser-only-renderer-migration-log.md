# Browser-Only Renderer Migration Log

<!-- Record conceptual/architectural changes, newly discovered coupling, compatibility constraints,
     rejected approaches, and implementation gotchas as they are discovered.
     Format: ## YYYY-MM-DD — <area> — <observation or decision>
     Include: date, affected area, observation/decision, consequence/required follow-up. -->

## 2026-09-30 — remaining renderer Node/native dependencies

**Area:** `mobrowser` linkifier, Telnet, and serial packages

**Observation/Decision:** Linkifier filesystem/path operations and Telnet TCP sockets must cross typed
MoBrowser IPC. Serial uses Chromium's Web Serial API directly, avoiding both native bindings and an
unnecessary main-process proxy.

**Consequence/follow-up:** Web Serial cannot change baud rate on an open port, so the existing baud-rate
action reconnects the session. Software flow-control flags are unavailable unless serial is later moved
behind a main-process native binding.

## 2026-07-02 — mobrowser subproject — bootstrapped MoBrowser scaffold

**Area:** mobrowser/ (new subproject)

**Observation:** Bootstrapped the `mobrowser/` subproject using `npm create mobrowser-app@latest` with
`--framework None --variant TypeScript --native yes`. Angular (the UI framework used by the parent
project) is not available as a MoBrowser scaffold option — the closest neutral option is `None`
(no framework). TypeScript was selected to match the parent project. Native module support was
enabled because the parent repo uses native Node.js modules (`keytar`, `node-pty`, `russh`,
`@serialport/bindings-cpp`, `glasstron`, `fontmanager-redux`, `macos-native-processlist`,
`native-process-working-directory`) rebuilt via `@electron/rebuild` on install.

**Scaffold command used:**
```
npm create mobrowser-app@latest -- --name mobrowser --framework Vanilla --library Vanilla \
  --variant TypeScript --native yes --setup yes
```
`--framework Vanilla` was ultimately used (not `None`) because `None + TypeScript + native:yes`
has no template. `Vanilla` is the structurally equivalent no-framework option.

**Dependency installation:** `npm install` failed with `cb.apply is not a function` (npm/Node
version mismatch with the generated lockfile format). Installation was completed successfully with
`yarn install` (the package manager already in use for the parent monorepo).

**`npm run gen` note:** The `@mobrowser/cli` cmake.js runs `npm install` as a subprocess inside
its own directory. When invoked from the parent project root, npm picks up the wrong context and
fails with `cb.apply is not a function`. Always run `npm run gen` (and all npm scripts) from
within `mobrowser/` — never from the parent repo root.

**Consequence / follow-up:**
- `mobrowser/` is an independent subproject — do not run `yarn install` or webpack commands for
  it from the parent repo root.
- Before writing any MoBrowser code, read `mobrowser/node_modules/@mobrowser/api/docs/` per
  `mobrowser/AGENTS.md` — training-data knowledge of the MoBrowser API is outdated.
- `mobrowser/yarn.lock` has been created; use `yarn` (not `npm`) inside `mobrowser/` for all
  package management.


## 2026-07-02 — mobrowser/src/renderer/packages — `import type` / `export type` applied to all 78 interfaces

**Area:** All 11 tabby packages under `mobrowser/src/renderer/packages/`

**Observation/Decision:** SWC processes TypeScript files in isolation with `decoratorMetadata: true` for Angular. When SWC encounters `import { SomeInterface }` where `SomeInterface` is a TypeScript interface (erased at emit), it occasionally retains the identifier in the emitted code as if it were a value. Rolldown then fails with `MISSING_EXPORT` when it tries to resolve the retained identifier from the re-export barrel. The fix is to use `import type { SomeInterface }` or `import { type SomeInterface }` for all interface/type-alias imports so SWC knows unambiguously that the import is type-only and can safely drop it. The same applies to `export { SomeInterface }` barrel re-exports which must become `export type { SomeInterface }`.

78 interfaces and type aliases were identified across the packages. 90+ files were updated with the type keyword. Key patterns fixed: mixed imports like `import { SomeClass, SomeInterface }` were split into a value import and a `import type` statement; barrel re-exports like `export { SomeClass, SomeInterface }` were split into value and `export type` lines.

**Consequence/follow-up:** Zero remaining violations confirmed by automated scan. Future contributors adding new interfaces must remember to use `import type` when consuming them, and `export type` when re-exporting them through barrel files.

## 2026-07-02 — mobrowser/src/renderer/proto/ — Phase 1: all 13 IPC proto files written

**Area:** IPC contract (proto files) and build system

**Observation/Decision:** All 13 Protobuf service definition files were written in `mobrowser/src/renderer/proto/`. These cover the complete IPC surface: AppService (bootstrap, config, CLI, hotkeys, plugins), DialogService (open/save/message dialogs), FsService (file I/O + streaming handles), LogService, MenuService (context menu + dock), PlatformService (fonts, exec, clipboard, path utils), PowerService (sleep blockers), PtyService (pty spawn/resize/write/kill + data streaming), ScreenService (multi-display), ShellService (shell integration), ThemeService (native dark mode), UpdaterService, WindowService (window chrome controls + event streams). Scaffold `greet.proto` was deleted; `app.proto` was replaced with the real AppService definition. `npm run gen` succeeded and produced TypeScript stubs in `src/renderer/gen/` and `src/main/gen/`.

**Build config changes:** `package.json` extended with Angular 15, rxjs, zone.js, node-pty, keytar, @sentry/browser, js-yaml, slug, color as runtime deps and @analogjs/vite-plugin-angular, @rollup/plugin-yaml, vite-plugin-pug, gettext-parser, sass as devDeps. `tsconfig.json` updated: `jsx: preserve`, `experimentalDecorators: true`, `emitDecoratorMetadata: true`, and path aliases for all 11 tabby packages. `vite.config.ts` renderer config extended with Angular/YAML/Pug plugins and tabby package `resolve.alias` entries.

**Consequence/follow-up:** IPC contract is now fully defined. Phase 2: implement service handlers in `src/main/index.ts` and Angular service wrappers in `src/renderer/packages/tabby-mobrowser/`. Open question on Angular 15 + @analogjs/vite-plugin-angular compatibility (AnalogJS targets Angular 16+) must be resolved before the renderer build can be validated.

## 2026-07-02 — mobrowser/src/main/index.ts — Phase 3: main process entry point

**Area:** `mobrowser/src/main/index.ts` — MoBrowser main process

**Observation/Decision:** Replaced the scaffold stub with a full main process implementation. All 13 IPC services are registered using descriptors from `./gen/ipc_service`. A shared `AsyncQueue<T>` + `PubSub<T>` utility pattern handles all streaming/event channels (M → R fan-out) without pulling in any EventEmitter or external pub/sub library. PTY streaming uses `AsyncQueue` wired to `node-pty`'s `onData`/`onExit` callbacks; cleanup is triggered by `ctx.signal.abort`. The window close handler uses `win.handle('close', async () => 'hide')` which suppresses native close; the renderer must call `AppService.Quit()` to actually quit — consistent with Tabby's existing hide-on-close behavior.

Confirmed stubs (APIs either absent from MoBrowser or needing native modules): `OpenExternal` (no shell API confirmed in docs), `ListFonts` (needs native fontmanager), `GetCursorPoint` (native cursor), `GetDisplayNearestPoint` (no Displays.getNearestDisplay), `SetProgressBar` (no window progress API), `SetWindowControlsColor` (no API), `RegisterGlobalHotkey` (GlobalShortcut API exists but needs integration), `JumpList` (Windows-only, no MoBrowser equivalent), `ShellService` (all methods), `PowerService` (sleep blocker), `UpdaterService` (app.checkForUpdate exists but auto-download/install differs from electron-updater).

**Consequence/follow-up:** The file is structurally correct and should compile once `node-pty` types resolve. Stub methods must be tracked and filled in as native module bindings and MoBrowser API gaps are resolved. The `node-pty` `spawn()` call passes `env` merged with `process.env` — verify this does not cause env variable pollution in sandboxed builds.

## 2026-07-03 — tabby-ssh services — keytar and Node crypto/fs removed from renderer

**Area:** `tabby-ssh/src/services/passwordStorage.service.ts`, `tabby-ssh/src/services/ssh.service.ts`

**Observation/Decision:** Both SSH service files still imported native Node.js modules directly in the renderer: `keytar` (native credential store), `fs/promises` (filesystem), and `crypto` (hash). These are incompatible with the browser-only renderer target.

- `keytar` calls are now routed through the IPC bridge using `(window as any).tabbyAPI.ipc.invoke('keytar:get-password'|'keytar:set-password'|'keytar:delete-password', ...)`. The main process handler for these channels was already created in `app/lib/keytar.ts` by a prior session.
- `fs.writeFile` is replaced with `(window as any).tabbyAPI.ipc.invoke('bridge:file:write', ...)` — the `bridge:file:write` handler already exists in `app/lib/bridge.ts`.
- `crypto.createHash('sha512')` is replaced with the Web Crypto API: `await window.crypto.subtle.digest('SHA-512', new TextEncoder().encode(content))` followed by manual hex encoding via `Uint8Array`. This is a pure browser API with no Node.js dependency.

**Consequence/follow-up:** Both files are now fully browser-safe. The `convertPrivateKeyFileToPuTTYFormat` method is already `async`, so the added `await` for `window.crypto.subtle.digest` is sound. No API surface changes — callers are unaffected. The IPC channel `bridge:file:write` accepts a path and string content — verify the main-process handler handles non-Buffer string content correctly if binary private keys are passed.

## 2026-07-03 — SSH IPC layer — created app/lib/ssh.ts: main-process SSH session manager

**Area:** `app/lib/ssh.ts` (new file), `tabby-ssh/src/session/ssh.ts` (source of ported logic)

**Observation:** The full SSH session management — including the auth loop, SFTP, port forwarding, X11 bridging, and agent forwarding — has been moved to the main process in `app/lib/ssh.ts`. The renderer only holds a `sessionId` (UUID) and communicates through typed IPC channels. All russh state (SSHClient, AuthenticatedSSHClient, SFTP, Channel, SFTPFile handles) lives in `SSHSessionState` objects keyed by sessionId in a `Map<string, SSHSessionState>`.

**Architecture decisions:**
- Auth challenges (host key, password, passphrase, keyboard-interactive, username) are signalled by `state.webContents.send(channel, ...)` — targeting only the renderer window that owns the session (not `app.broadcast`) — and resolved via `waitForResponse<T>()` which registers a one-shot `ipcMain.once` listener.
- `keytar` is called directly in the main process for password/passphrase storage, replacing the IPC round-trips that the renderer-side `PasswordStorageService` previously made.
- SFTP is lazy: `ensureSFTP()` activates it on first use via `activateSFTP(await ssh.openSessionChannel())`.
- Port forwarding (Local/Dynamic/Remote) is managed in main: Local/Dynamic start a `net.createServer()` or socksv5 listener; Remote calls `ssh.forwardTCPPort()`. Each type bridges sockets to SSH channels via `setupSocketChannelEvents()`.
- X11 bridging inlines the `X11Socket.resolveDisplaySpec` logic from `tabby-ssh/src/session/x11.ts` — no import needed.

**Consequence/follow-up:** `tabby-ssh`'s renderer-side `SSHSession` class in `tabby-ssh/src/session/ssh.ts` should be replaced (or its shell, SFTP, forwarding methods delegated) to call these IPC channels rather than using russh directly. Until that migration is done, both code paths coexist. The IPC auth challenge channels are one-shot; the renderer must not send `ssh:session:connect` twice for the same sessionId concurrently (see gotchas.md). SFTP handle leaks on session destroy are noted as a known gap (see gotchas.md).

## 2026-07-03 — SSH session files — renderer rewrite complete; all Node.js/russh removed

**Area:** `tabby-ssh/src/session/sftp.ts`, `forwards.ts`, `x11.ts`, `ssh.ts`, `shell.ts`

**Observation:** All five renderer-side SSH session files have been rewritten to eliminate every Node.js built-in (`fs`, `crypto`, `net`, `path`) and every `russh` native module import. The renderer now communicates exclusively through `(window as any).tabbyAPI.ipc`.

**Architectural changes:**
- `SSHSession` no longer holds any russh state. It holds a `sessionId: string` generated via `window.crypto.randomUUID()`. `start()` registers IPC event listeners for all auth challenge channels (`ssh:{id}:host-key-verify`, `ssh:{id}:need-username`, `ssh:{id}:need-password`, `ssh:{id}:need-passphrase`, `ssh:{id}:keyboard-interactive`, `ssh:{id}:service-message`, `ssh:{id}:close`) and then blocks on `await ipc.invoke('ssh:session:connect', sessionId, serializedProfile)`. All auth interactions happen through the registered listeners while the invoke is pending.
- `ShellChannelProxy` replaces `russh.Channel` for shell I/O. It subscribes to `ssh:{id}:data` and `ssh:{id}:shell-close` events, and sends data via `ipc.send('ssh:session:shell-write', ...)`. Closing the proxy unregisters all listeners and completes the observables.
- `SFTPSession` delegates all operations to `ipc.invoke('ssh:session:sftp-*', ...)`. File handles are represented as opaque string IDs returned by `ssh:session:sftp-open`.
- `ForwardedPort.startLocalListener` / `stopLocalListener` are no-ops. Port forwarding is controlled by `SSHSession.addPortForward()` → `ipc.invoke('ssh:session:forward-add', ...)`.
- `X11Socket` is a stub; `connect()` throws. X11 bridging is handled entirely in the main process.
- `SSHShellSession.shell` type changed from `russh.Channel` to `ShellChannelProxy`. `emitOutput` receives `Uint8Array` directly — `Buffer.from()` removed.
- Compat stubs `authUsername: string|null` and `activePrivateKey: null` added to `SSHSession` so `ssh.service.ts:launchWinSCP` compiles without modification.

**Consequence/follow-up:** The five session files are now browser-safe. The `app/lib/ssh.ts` main-process handler already implements all the IPC channels these files call. A build-time TypeScript check should be run to confirm no remaining type errors (e.g., from callers expecting the old `russh.Channel` return type from `openShellChannel`). The `PasswordStorageService` is no longer used by `SSHSession` — password storage is now fully managed in the main process via keytar; however `PasswordStorageService` still exists for backward compatibility.

## 2026-07-05 — mobrowser tabby-ssh IPC migration — TypeScript errors resolved

**Area:** `mobrowser/src/renderer/packages/tabby-ssh/`, `mobrowser/src/main/ssh.ts`, `mobrowser/tsconfig.json`

**Decision/Observation:** The second half of the tabby-ssh MoBrowser migration required fixing several classes of TypeScript errors that blocked `tsc --noEmit`:

1. **`@gen/ipc` path alias missing from tsconfig.json**: The `@gen/*` alias was defined in `vite.config.ts` only. `tsc` cannot see Vite config aliases, so all renderer files importing from `@gen/ipc` failed with TS2307. Fixed by adding `"@gen/*": ["./src/renderer/gen/*"]` to `tsconfig.json` paths.

2. **Main gen vs renderer gen type divergence for binary fields**: `src/main/gen/ssh.ts` types proto `bytes` fields as `Buffer`, while `src/renderer/gen/ssh.ts` types them as `Uint8Array`. The `SshShellEvent.data` field in the main-process service implementation must be `Buffer.from(uint8Array)` (not a bare `Uint8Array`) to satisfy the main gen types.

3. **`russh.SFTPFileType` const enum unusable with `isolatedModules: true`**: Numeric literals (`0` = Directory, `1` = File, `2` = Symlink) must be used in place of the const enum values to avoid TS2748.

4. **`size`/`mtime` in SFTP proto are `number`, not `bigint`**: The generated TypeScript types both fields as `number`, so `Number(value)` must be used instead of `BigInt(value)`.

5. **`SshPasswordResponse` and `SshPassphraseResponse` require a `remember: boolean` field**: The proto-generated interfaces include this field (it was omitted in the initial migration). Both `RespondPassword` and `RespondPassphrase` IPC calls must include `remember: false`.

6. **`buildConnectRequest` return type was `object`**: Changed to `import('@gen/ssh').SshConnectRequest` to satisfy the `ipc.ssh.Connect()` type parameter.

7. **`StringValue.value` not `.target`**: `SftpReadlink` returns a `StringValue` with a `.value` property — the initial code incorrectly accessed `.target`.

8. **Angular `@Input()` properties without initializers**: Copied component files had TS2564 errors from `strictPropertyInitialization`. Fixed with `!` (definite assignment assertion) on all `@Input()` decorated properties and modal instance properties. This is the correct Angular pattern for inputs set by the framework.

9. **`hotkeys.ts` TS2729 — property used before initialization**: The `hotkeys` array field initializer referenced `this.translate` which is set by injection in the constructor. Fixed by moving the array initialization into the constructor body.

**Consequence:** All `tabby-ssh` package files and `src/main/ssh.ts` / `src/main/keychain.ts` are TypeScript error-free. Pre-existing errors in other packages (tabby-core, tabby-terminal, tabby-local, etc.) remain — those are out of scope for this migration and existed before the SSH work began.

## 2026-09-30 — MoBrowser development launch reaches renderer

**Area:** `mobrowser/vite.config.ts`, `mobrowser/src/renderer/packages/tabby-terminal/middleware/`

**Decision/Observation:** Removed the startup-time `hexer` dependency from the renderer in favor of a small `Uint8Array` hexdump formatter, and added a Vite pre-transform for static `.svg` `require()` expressions inherited from webpack. After local MoBrowser 2.10.1 packaging workarounds for hoisted CLI dependencies, `napi` package detection, and `russh`'s `rxjs` peer, `npm run dev` launches the native app and its Chromium renderer.

**Consequence:** The MoBrowser window now launches on macOS. The `node_modules` toolchain workarounds are not durable and must be addressed upstream or automated before clean-checkout launch can be claimed.

## 2026-10-01 — MoBrowser renderer bootstrap completes

**Area:** `mobrowser/src/renderer/index.ts`, `app.module.ts`, `vite.config.ts`, copied Angular templates

**Decision/Observation:** Restored the core `forRoot()` providers and plugin-module registry, explicitly bootstrapped `AppRootComponent`, inlined copied Pug `templateUrl` resources and SVGs, normalized Angular template references, shared the loaded `AppConfigService` through the root injector, and treated a missing first-run config as empty.

**Consequence:** `npm run dev` now reaches config readiness and locale initialization without Angular bootstrap or renderer errors; the native MoBrowser and Chromium renderer processes remain running.

## 2026-10-01 — MoBrowser component styles and raw SVG resources restored

**Area:** `mobrowser/vite.config.ts`, copied Angular component CSS/SCSS, MoBrowser 2.17 automation

**Decision/Observation:** Vite did not process Angular JIT `styleUrls`, so copied component styles were requested at runtime instead of compiled. The shared resource transform now rewrites literal style URLs to Vite `?inline` imports and supplies them as `styles`. Webpack-era TypeScript SVG requires now use Vite `?raw` imports because the existing directives bind them as HTML. The only `/deep/` selector was updated to `::ng-deep` for the production CSS parser.

**Consequence:** The running app has full-height flex layout and correctly sized controls/icons. MoBrowser automation verified six inline toolbar SVGs, no visible data-URI strings, and produced a post-fix screenshot; the renderer production build passes.

## 2026-10-01 — MoBrowser localization and global renderer resources restored

**Area:** `mobrowser/vite.config.ts`, renderer entry styles and font/icon dependencies

**Decision/Observation:** Pug emitted bare translation directives as `translate="translate"`, which passed the literal key `translate` to ngx-translate. The shared template renderer now emits an empty attribute so the directive derives its key from element text. The standalone renderer also restores the original global/preload SCSS, Source Sans/Code fonts, and Font Awesome imports omitted during initial bootstrap.

**Consequence:** The welcome page renders actual localized strings, the Tabby logo and fonts, and the original form layout. MoBrowser automation and a production renderer build verify the fix.

## 2026-10-01 — MoBrowser local-terminal happy path succeeds

**Area:** `mobrowser/src/main/index.ts`, `mobrowser/mobrowser.conf.json`, copied `tabby-local` and xterm adapters

**Decision/Observation:** The first terminal run exposed four runtime-only compatibility issues: Tabby's PTY adapter contract is three arguments rather than one options object; copied local code still reads synchronous bootstrap metadata; xterm 6 made old private platform fields getter-only and may omit the private viewport; and `node-pty` 1.1 passes a virtual `/app/.../spawn-helper` path to native `posix_spawn`. The adapter now preserves the original spawn signature, static metadata is supplied through a data-only compatibility object while dynamic work uses generated IPC, xterm private accesses are removed/guarded, and the physical macOS helper is bundled and substituted at the native fork boundary.

**Consequence:** `/bin/zsh --login` launches as a child of MoBrowser, terminal input/output works, and automation renders `MOBROWSER_HAPPY_PATH_OK` in `.mobrowser/happy-path-terminal.png`. MoBrowser 2.17 still needs the documented local CLI/native-package workarounds, including nesting `rxjs` for `russh`; this happy path does not yet prove a clean-checkout launch or SSH/Telnet/serial behavior.

## 2026-10-02 — MoBrowser UI smoke scenarios expose stuck tab removal

**Area:** Settings/Appearance and local-terminal tab lifecycle

**Decision/Observation:** Automation verified localized, styled Settings navigation and a reversible Blink cursor preference change. A newly created local terminal also accepted input and rendered `SCENARIO_NEW_TAB_OK`. Closing that tab exposed a lifecycle defect: the 250 ms tab-header animation reaches the Web Animations `finished` state, but Angular retains `ng-animating`, both the closing and fallback headers remain active, and the closed tab's `/bin/zsh --login` process stays alive even though the renderer logs `Destroying`.

**Consequence:** Settings and terminal creation/input pass, but terminal close/cleanup is not yet reliable in MoBrowser. Screenshots are stored at `mobrowser/.mobrowser/scenario-settings-appearance.png`, `scenario-new-tab.png`, and `scenario-tab-close-stuck.png`. Fresh automation snapshots are required after tab mutations because references can outlive the visual transition.

## 2026-10-02 — General Electron-to-MoBrowser guidance extracted

**Area:** `docs/technical/electron-to-mobrowser-migration-gotchas.md`

**Decision/Observation:** Consolidated the migration records into a standalone guide covering reusable process-boundary, typed-RPC, bootstrap, serialization, cleanup, Vite/ESM, framework-resource, native-packaging, API-parity, and runtime-validation lessons. Product-specific implementation details were excluded unless they demonstrated a generally applicable migration failure mode.

**Consequence:** Future migrations can start from the curated guide instead of reverse-engineering this application's chronological logs. Version-specific observations are labeled and the original records remain linked as evidence.

## 2026-10-02 — General migration guide made implementation-specific

**Area:** `docs/technical/electron-to-mobrowser-migration-gotchas.md`

**Decision/Observation:** The first extracted guide correctly identified the architectural categories but was too abstract to implement directly. It now uses nested symptom/cause/action/pass-condition sections, a concrete renderer-adapter/RPC/main-service example, transport and resource-lifecycle patterns, compatibility tables, case-specific failures, direct implementation links, and per-phase exit criteria.

**Consequence:** An engineer can now determine where a capability belongs, how to represent it over MoBrowser RPC, how to migrate build resources and native packaging, and how to prove both the happy path and cleanup without first reading the chronological project logs.

## 2026-10-02 — MoBrowser limitations and build-system differences consolidated

**Area:** `docs/technical/electron-to-mobrowser-migration-gotchas.md`, `mobrowser/vite.config.ts`

**Decision/Observation:** The guide now separates deliberate MoBrowser constraints, version-specific API/tooling gaps, browser API reductions, framework integration defects, and unfinished project adapters. It also compares the original multi-config Webpack/CommonJS/UMD/loader pipeline with MoBrowser's mode-selected Vite/ESM/generated-IPC/plugin-transform/package pipeline. Inspection of the current config exposed a further reusable constraint: Vite 8 OXC must be disabled when SWC owns Angular legacy decorators and metadata, otherwise renderer TypeScript is transformed twice.

**Consequence:** Engineers can distinguish platform limits from work still owed by this port and can plan type checking, Vite compilation, MoBrowser packaging, and packaged runtime tests as separate gates.

## 2026-10-02 — Technical documentation promoted out of `.claude`

**Area:** `docs/technical/`, `.claude/`, `CLAUDE.md`

**Decision/Observation:** Durable material from the hidden agent workspace was reorganized into an indexed engineer-facing documentation set. The old hardening plan moved to `electron-renderer-hardening.md`; activity outcomes became a current status page; application-specific registry entries became `project-specific-migration-gotchas.md`; the generalized guide and chronological logs remain separate. Raw activity/gotcha files stay in `.claude` only because repository rules require append-only agent journals. Skill prompts and settings remain automation configuration, and only claims verified against code or installed MoBrowser docs were promoted.

**Consequence:** `docs/technical/index.md` now defines reading order, task-based navigation, document precedence, extraction provenance, and maintenance ownership. Engineers no longer need to mine `.claude` to understand the migration.

## 2026-10-02 — Documentation audit finds remaining renderer Node dependencies

**Area:** copied MoBrowser terminal, SSH, and Windows-provider renderer code

**Decision/Observation:** Verifying the promoted documentation against current source disproved the earlier broad “browser-only renderer complete” status. The MoBrowser copy of terminal stream processing still lazily requires Node `stream` and `readline` even though the parent source already has browser-compatible replacements. SSH renderer code still uses/exposes `Buffer`, and Windows shell/environment providers still dynamically require `windows-native-registry`. These branches were not exercised by the successful macOS local-PTY scenario.

**Consequence:** The status page now marks renderer isolation partial. Port the existing browser stream/readline implementation, replace SSH `Buffer` with `Uint8Array`, move Windows registry queries behind typed main-process RPC, and add optional/platform-path tests before claiming the renderer boundary is complete.
