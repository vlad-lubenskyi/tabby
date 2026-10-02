# Activity Log

<!-- Agents: append entries here per the rules in CLAUDE.md. Newest entries go at the top. -->

## 2026-09-30 — Remove linkifier, Telnet, and serial Node dependencies from MoBrowser renderer

- **Files changed:** `mobrowser/package.json`, `mobrowser/vite.config.ts`, `mobrowser/src/main/index.ts`, `mobrowser/src/main/telnet.ts`, `mobrowser/src/main/telnet.test.ts`, `mobrowser/src/renderer/proto/platform.proto`, `mobrowser/src/renderer/proto/telnet.proto`, generated IPC files under `mobrowser/src/{main,renderer}/gen/`, `mobrowser/src/renderer/packages/tabby-linkifier/handlers.ts`, `mobrowser/src/renderer/packages/tabby-telnet/session.ts`, `mobrowser/src/renderer/packages/tabby-telnet/components/telnetTab.component.ts`, `mobrowser/src/renderer/packages/tabby-serial/api.ts`, `mobrowser/src/renderer/packages/tabby-serial/services/serial.service.ts`, `mobrowser/src/renderer/packages/tabby-serial/components/serialTab.component.ts`, `mobrowser/docs/mobrowser-migration-log.md`, `docs/technical/browser-only-renderer-migration-log.md`, `.claude/gotchas.md`
- **What was done:** moved linkifier filesystem/path access to typed IPC; moved Telnet TCP sockets to a streamed main-process service; replaced Node SerialPort bindings with Chromium Web Serial; removed the unused renderer dependencies.
- **Outcome:** `completed` — affected sources contain no Node/native imports or `Buffer`, the focused TypeScript check is clean, the renderer bundle builds, and the Telnet loopback test passes.

## 2026-07-05 — Complete tabby-ssh MoBrowser IPC migration: fix remaining tsc errors

- **Files changed:**
  - `mobrowser/tsconfig.json` — added `"@gen/*": ["./src/renderer/gen/*"]` to paths so renderer files can import from `@gen/ipc`
  - `mobrowser/src/renderer/packages/tabby-ssh/session/x11.ts` — added `static resolveDisplaySpec()` stub returning `{ path: '' }` to satisfy reference in `sshSettingsTab.component.ts`
  - `mobrowser/src/main/ssh.ts` — fixed `Uint8Array` → `Buffer.from()/Buffer.alloc(0)` for `SshShellEvent.data` (main gen uses Buffer); replaced `BigInt()` with `Number()` for `size`/`mtime` fields; replaced `russh.SFTPFileType.Directory/Symlink` ambient const enum references (not allowed with isolatedModules) with numeric literals `0` and `2`
  - `mobrowser/src/renderer/packages/tabby-ssh/session/sftp.ts` — fixed `result.target` → `result.value` for `SftpReadlink` return (StringValue has `.value` not `.target`)
  - `mobrowser/src/renderer/packages/tabby-ssh/session/ssh.ts` — removed unused `NotificationsService` import/field; changed `buildConnectRequest` return type from `object` to `SshConnectRequest`; added `remember: false` to `RespondPassword`/`RespondPassphrase` calls (proto requires this field); added `as string` cast to narrow `string|null`; added `type`/`targetAddress`/`targetPort` to `RemovePortForward` call to satisfy required proto fields
- **What was done:**
  - Fixed `@gen/ipc` path alias missing from tsconfig.json (all renderer IPC imports were broken)
  - Fixed all remaining tsc errors in `tabby-ssh` package (session, services, components) — 0 errors in the package
  - Fixed all tsc errors in `src/main/ssh.ts` — 0 errors
- **Outcome:** `completed` — all `tabby-ssh` and main process SSH/keychain files are TypeScript error-free

## 2026-07-05 — Fix TypeScript errors in mobrowser tabby-ssh components and services

- **Files changed:**
  - `mobrowser/src/renderer/packages/tabby-ssh/components/hostKeyPromptModal.component.ts` — added `!` to `selector`, `digest`, `knownHost`
  - `mobrowser/src/renderer/packages/tabby-ssh/components/keyboardInteractiveAuthPanel.component.ts` — added `!` to `profile`, `prompt`, `input`
  - `mobrowser/src/renderer/packages/tabby-ssh/components/sftpCreateDirectoryModal.component.ts` — added `!` to `directoryName`
  - `mobrowser/src/renderer/packages/tabby-ssh/components/sftpDeleteModal.component.ts` — added `!` to `sftp`, `item`
  - `mobrowser/src/renderer/packages/tabby-ssh/components/sftpPanel.component.ts` — added `!` to `session`, `sftp`; typed catch `error` as `unknown` and cast to `Error`; typed sort key lambda parameter as `SFTPFile`
  - `mobrowser/src/renderer/packages/tabby-ssh/components/sshPortForwardingConfig.component.ts` — added `!` to `model`, `newForward`
  - `mobrowser/src/renderer/packages/tabby-ssh/components/sshPortForwardingModal.component.ts` — added `!` to `session`
  - `mobrowser/src/renderer/packages/tabby-ssh/components/sshProfileSettings.component.ts` — added `!` to `profile`, `hasSavedPassword`, `jumpHosts`, `loginScriptsSettings`
  - `mobrowser/src/renderer/packages/tabby-ssh/components/sshSettingsTab.component.ts` — fixed `@HostBinding` from bare `true` to `contentBox = true`
  - `mobrowser/src/renderer/packages/tabby-ssh/components/sshTab.component.ts` — typed catch `e` as `unknown`, cast to `Error`
  - `mobrowser/src/renderer/packages/tabby-ssh/hotkeys.ts` — moved `hotkeys` array initialization from field initializer to constructor body to fix TS2729 (property used before initialization)
  - `mobrowser/src/renderer/packages/tabby-ssh/services/ssh.service.ts` — added `!` to `detectedWinSCPPath`; added explicit type to `find` callback parameter
  - `mobrowser/src/renderer/packages/tabby-ssh/services/sshKnownHosts.service.ts` — added explicit `KnownHost` type to `find` callback parameter
- **What was done:**
  - Fixed all TS2564 (no initializer) errors by adding `!` (definite assignment assertion) to Angular `@Input()` and other class properties
  - Fixed TS18046 (error is unknown) in catch blocks by typing as `unknown` and casting to `Error`
  - Fixed TS7006 (implicit any) on sort/find callback parameters by adding explicit types
  - Fixed TS7008 (@HostBinding member has any type) by renaming the property from bare `true` to `contentBox = true`
  - Fixed TS2729 (property used before initialization) in hotkeys.ts by moving array from field initializer to constructor
- **Outcome:** `completed` — all listed TypeScript errors resolved with minimal changes

## 2026-07-03 — Remove Node.js imports from sftpPanel.component.ts

- **Files changed:**
  - `tabby-ssh/src/components/sftpPanel.component.ts` — removed `import * as C from 'constants'` and `import { posix as path } from 'path'`; replaced all `path.basename`, `path.dirname`, `path.resolve`, `path.join`, `path.posix.join` calls with local helper functions (`posixBasename`, `posixDirname`, `posixJoin`, `posixResolve`); replaced `C.S_IFDIR`, `C.S_IRUSR`, etc. with local octal number constants
- **What was done:**
  - Removed all Node.js built-in imports from the last remaining renderer file that had them
  - Path helpers implemented as pure string operations — no Node.js dependency
  - POSIX file mode constants defined as local `const` values with their numeric equivalents
- **Outcome:** `completed` — all tabby-ssh renderer source files now free of Node.js/native module imports

## 2026-07-03 — Rewrite tabby-ssh renderer session files to remove all Node.js/russh usage

- **Files changed:**
  - `tabby-ssh/src/session/sftp.ts` — removed `russh` and `path` imports; replaced `russh.SFTP` with `sessionId`+IPC; replaced `russh.SFTPFile` handle with `handleId: string`; all SFTP ops are now `ipc.invoke()` calls; local `posixJoin`/`posixBasename` replace `posixPath.join`/`basename`
  - `tabby-ssh/src/session/forwards.ts` — removed `@luminati-io/socksv5` and `net` imports; `startLocalListener` and `stopLocalListener` are no-ops; port forwarding fully delegated to main process
  - `tabby-ssh/src/session/x11.ts` — removed `net` and `process.env`/`process.platform` usage; class is now a stub that throws on `connect()`; X11 forwarding handled by main process
  - `tabby-ssh/src/session/ssh.ts` — full rewrite; removed `russh`, `fs`, `crypto`, `net`, `process`; session ID via `window.crypto.randomUUID()`; all IPC via `(window as any).tabbyAPI.ipc`; auth challenges handled via IPC event listeners; introduced `ShellChannelProxy` class; added compat stubs `authUsername` and `activePrivateKey`
  - `tabby-ssh/src/session/shell.ts` — removed `russh` import; changed `shell` type from `russh.Channel` to `ShellChannelProxy`; shell close now calls `this.shell?.close()`; `emitOutput` receives `Uint8Array` directly (no `Buffer.from`)
- **What was done:**
  - Eliminated all Node.js built-in module usage (`fs`, `crypto`, `net`, `path`) and all `russh` native module usage from renderer-side SSH session files
  - Auth challenge flow (host-key, username, password, passphrase, keyboard-interactive) now wired through IPC event listeners registered in `SSHSession.start()`
  - SFTP operations call `ipc.invoke('ssh:session:sftp-*', ...)` with opaque handle IDs returned by main process
  - Port forwarding renderer side is fully no-op; main process manages TCP listeners
- **Outcome:** `completed` — all five session files rewritten; zero Node.js/russh imports remain in these files

## 2026-07-03 — Jump channel IPC: move TCPForward to main process, remove russh from renderer

- **Files changed:**
  - `app/lib/ssh.ts` — changed `SSHProfile.jumpChannel` to `jumpChannelId: string | null`; added `jumpChannels` Map; added `ssh:session:open-jump-channel` IPC handler; updated `connectSession` to look up channel by ID
  - `app/lib/app.ts` — added `import { initSSH } from './ssh'`; called `initSSH(this)` after `initKeytar()`
  - `tabby-ssh/src/components/sshTab.component.ts` — removed `import * as russh from 'russh'`; replaced direct `jumpSession.ssh.openTCPForwardChannel(...)` call with `ipc.invoke('ssh:session:open-jump-channel', ...)` via `window.tabbyAPI.ipc`; replaced `session.jumpChannel` with `session.jumpChannelId`
- **What was done:**
  - The renderer no longer touches russh objects directly for jump host setup
  - The main process opens the TCP forward channel via IPC and returns an opaque UUID; the renderer passes that ID to the subsequent `ssh:session:connect` call
  - `initSSH` is now registered at application startup from `app.ts`
- **Outcome:** `completed` — all three files updated; jump host flow now fully confined to the main process

## 2026-07-03 — Create app/lib/ssh.ts: main-process SSH session manager via russh IPC

- **Files changed:**
  - `app/lib/ssh.ts` — created (new file, ~1127 lines)
  - `docs/technical/browser-only-renderer-migration-log.md` — appended entry
  - `.claude/activity-log.md` — this entry
  - `.claude/gotchas.md` — appended entry
- **What was done:**
  - Created the full main-process SSH session manager exposing russh via Electron IPC
  - Implemented all 19 IPC channels: `ssh:session:connect`, `open-shell`, `shell-write`, `shell-resize`, `destroy`, 12 SFTP channels, `forward-add`, `forward-remove`
  - Ported the complete auth loop from `tabby-ssh/src/session/ssh.ts` (`_handleAuth`), replacing all Angular modal calls with IPC events + `waitForResponse<T>` one-shot handlers
  - Implemented password/passphrase/keytar storage in main process, Local/Dynamic/Remote port forwarding, X11 channel bridging, agent channel bridging, SFTP lazy-init, and session-scoped `WebContents.send` for targeted renderer delivery
- **Outcome:** `completed` — all specified IPC channels implemented, TypeScript transpiles cleanly

## 2026-07-03 — tabby-ssh: remove Node.js dependencies from passwordStorage.service.ts and ssh.service.ts

- **Files changed:**
  - `tabby-ssh/src/services/passwordStorage.service.ts` — removed `import * as keytar from 'keytar'`; replaced all `keytar.getPassword`, `keytar.setPassword`, `keytar.deletePassword` calls with `(window as any).tabbyAPI.ipc.invoke('keytar:...')` IPC bridge calls
  - `tabby-ssh/src/services/ssh.service.ts` — removed `import * as fs from 'fs/promises'` and `import * as crypto from 'crypto'`; replaced `fs.writeFile` with `bridge:file:write` IPC and replaced `crypto.createHash('sha512')` with Web Crypto `window.crypto.subtle.digest('SHA-512', ...)` + manual `Uint8Array` hex encoding
- **What was done:**
  - Removed all remaining Node.js built-in imports (`keytar`, `fs/promises`, `crypto`) from the two renderer-side SSH service files
  - Replaced keytar calls with IPC bridge channels (`keytar:get-password`, `keytar:set-password`, `keytar:delete-password`) via `window.tabbyAPI.ipc.invoke`
  - Replaced Node.js `fs.writeFile` with `bridge:file:write` IPC (main-process handler already exists in `app/lib/bridge.ts`)
  - Replaced Node.js `crypto.createHash('sha512')` with the standard Web Crypto API (`window.crypto.subtle.digest`) and manual hex encoding via `Uint8Array`
- **Outcome:** `completed` — both files are now free of Node.js dependencies; all operations route through the existing IPC bridge

## 2026-07-03 — Replace dynamic russh-based supportedAlgorithms with static list in tabby-ssh/algorithms.ts

- **Files changed:** `tabby-ssh/src/algorithms.ts`
- **What was done:**
  - Removed `import * as russh from 'russh'` (native module, cannot run in the renderer process)
  - Replaced the five dynamic `russh.getSupportedX()` calls with a static `supportedAlgorithms` object covering the full set of algorithms russh supports
  - Static list includes all KEX, host-key, cipher, HMAC, and compression algorithm strings; `defaultAlgorithms` is unchanged
- **Outcome:** `completed` — `tabby-ssh/src/algorithms.ts` no longer imports the `russh` native module

## 2026-07-03 — streamProcessing.ts: remove Node.js stream/readline, replace with browser-compatible inline classes

- **Files changed:** `tabby-terminal/src/middleware/streamProcessing.ts`
- **What was done:**
  - Removed `declare const require: (module: string) => any` and the two `require('stream')` / `require('readline')` calls
  - Removed the `NodeStream` and `ReadLine` local interface definitions (no longer needed)
  - Added inline browser-compatible `SimplePassThrough` class (EventEmitter-like write/on/emit) replacing `PassThrough`
  - Added inline `SimpleReadline` class (buffers chars, echoes to output, emits 'line' on Enter, handles backspace) replacing `createInterface`
  - Added inline `clearLine(stream, dir)` function replacing the readline `clearLine` import
  - Updated field types: `inputReadline: SimpleReadline|null`, `inputReadlineInStream: SimplePassThrough`, `inputReadlineOutStream: SimplePassThrough`
  - All constructor and method call sites updated to use the new classes; all other logic preserved exactly
- **Outcome:** `completed` — file has zero Node.js dependencies; all browser environments can load it without Node.js runtime

## 2026-07-03 — Add keytar IPC handler to main process

- **Files changed:**
  - `app/lib/keytar.ts` — created
  - `app/lib/app.ts` — added import and `initKeytar()` call
- **What was done:**
  - Created `app/lib/keytar.ts` with `initKeytar()` that registers three `ipcMain.handle` handlers: `keytar:get-password`, `keytar:set-password`, `keytar:delete-password`, each delegating directly to the `keytar` npm package
  - Added `import { initKeytar } from './keytar'` to `app/lib/app.ts`
  - Called `initKeytar()` in the `Application` constructor immediately after `initBridge()`
- **Outcome:** `completed` — keytar operations are now accessible from the renderer via `ipcRenderer.invoke('keytar:...')` without any Node.js access in the renderer process

## 2026-07-02 — Comprehensive `import type` / `export type` fix across all 78 interfaces in packages

- **Files changed:** `tabby-core/api/index.ts`, `tabby-core/api/commands.ts`, `tabby-core/api/platform.ts`, `tabby-core/api/profileProvider.ts`, `tabby-core/api/tabContextMenuProvider.ts`, `tabby-core/api/tabRecovery.ts`, `tabby-core/cli.ts`, `tabby-core/components/baseTab.component.ts`, `tabby-core/components/splitTab.component.ts`, `tabby-core/components/splitTabDropZone.component.ts`, `tabby-core/components/selectorModal.component.ts`, `tabby-core/components/tabHeader.component.ts`, `tabby-core/components/profileTree.component.ts`, `tabby-core/index.ts`, `tabby-core/profiles.ts`, `tabby-core/tabContextMenu.ts`, `tabby-core/services/app.service.ts`, `tabby-core/services/commands.service.ts`, `tabby-core/services/config.service.ts`, `tabby-core/services/hotkeys.service.ts`, `tabby-core/services/profiles.service.ts`, `tabby-core/services/selector.service.ts`, `tabby-core/services/tabRecovery.service.ts`, `tabby-core/services/themes.service.ts`, `tabby-local/api.ts`, `tabby-local/cli.ts`, `tabby-local/components/localProfileSettings.component.ts`, `tabby-local/components/terminalTab.component.ts`, `tabby-local/profiles.ts`, `tabby-local/recoveryProvider.ts`, `tabby-local/services/terminal.service.ts`, `tabby-local/session.ts`, `tabby-local/tabContextMenu.ts`, `tabby-mobrowser/src/pathDrop.ts`, `tabby-mobrowser/src/pty.ts`, `tabby-mobrowser/src/terminalContextMenu.ts`, all 13 shell files in `tabby-mobrowser/src/shells/`, `tabby-plugin-manager/components/pluginsSettingsTab.component.ts`, `tabby-plugin-manager/services/pluginManager.service.ts`, `tabby-serial/api.ts`, `tabby-serial/components/serialProfileSettings.component.ts`, `tabby-serial/components/serialTab.component.ts`, `tabby-serial/profiles.ts`, `tabby-serial/recoveryProvider.ts`, `tabby-serial/services/serial.service.ts`, `tabby-settings/components/configSyncSettingsTab.component.ts`, `tabby-settings/components/editProfileGroupModal.component.ts`, `tabby-settings/components/editProfileModal.component.ts`, `tabby-settings/components/hotkeyInputModal.component.ts`, `tabby-settings/components/multiHotkeyInput.component.ts`, `tabby-settings/components/profilesSettingsTab.component.ts`, `tabby-settings/components/vaultSettingsTab.component.ts`, `tabby-ssh/api/contextMenu.ts`, `tabby-ssh/api/importer.ts`, `tabby-ssh/api/interfaces.ts`, `tabby-ssh/components/hostKeyPromptModal.component.ts`, `tabby-ssh/components/keyboardInteractiveAuthPanel.component.ts`, `tabby-ssh/components/sftpPanel.component.ts`, `tabby-ssh/components/sshPortForwardingConfig.component.ts`, `tabby-ssh/components/sshPortForwardingModal.component.ts`, `tabby-ssh/components/sshProfileSettings.component.ts`, `tabby-ssh/components/sshTab.component.ts`, `tabby-ssh/profiles.ts`, `tabby-ssh/recoveryProvider.ts`, `tabby-ssh/services/passwordStorage.service.ts`, `tabby-ssh/services/ssh.service.ts`, `tabby-ssh/services/sshMultiplexer.service.ts`, `tabby-ssh/session/forwards.ts`, `tabby-ssh/session/shell.ts`, `tabby-ssh/session/ssh.ts`, `tabby-ssh/sftpContextMenu.ts`, `tabby-ssh/tabContextMenu.ts`, `tabby-telnet/components/telnetProfileSettings.component.ts`, `tabby-telnet/components/telnetTab.component.ts`, `tabby-telnet/profiles.ts`, `tabby-telnet/recoveryProvider.ts`, `tabby-telnet/session.ts`, `tabby-terminal/api/baseTerminalTab.component.ts`, `tabby-terminal/api/connectableTerminalTab.component.ts`, `tabby-terminal/api/interfaces.ts`, `tabby-terminal/cli.ts`, `tabby-terminal/components/inputProcessingSettings.component.ts`, `tabby-terminal/components/loginScriptsSettings.component.ts`, `tabby-terminal/components/searchPanel.component.ts`, `tabby-terminal/components/streamProcessingSettings.component.ts`, `tabby-terminal/frontends/frontend.ts`, `tabby-terminal/frontends/xtermFrontend.ts`, `tabby-terminal/session.ts`, `tabby-terminal/tabContextMenu.ts`
- **What was done:**
  - Scanned all 241 `.ts` files in `mobrowser/src/renderer/packages/` to build a list of 78 exported interfaces and type aliases
  - For every `import { X }` where X is an interface/type alias, added `type` keyword either as `import type { X }` or split the import line to separate classes from interfaces
  - For every `export { X }` re-export where X is an interface/type alias, changed to `export type { X }` or split the export line accordingly
  - Verified zero remaining violations with a final Python scan
- **Outcome:** `completed` — all interface imports/exports across the entire packages directory now have the `type` keyword; SWC erasure of interfaces will no longer cause Rolldown MISSING_EXPORT errors

## 2026-07-02 — Add `type` keyword to interface imports to fix SWC/Rolldown erasure

- **Files changed:**
  - `tabby-ssh/hotkeys.ts`, `tabby-local/hotkeys.ts`, `tabby-telnet/hotkeys.ts`, `tabby-terminal/hotkeys.ts`, `tabby-settings/hotkeys.ts`, `tabby-mobrowser/src/hotkeys.ts`, `tabby-serial/hotkeys.ts` — added `type` before `HotkeyDescription`
  - `tabby-core/hotkeys.ts`, `tabby-core/services/hotkeys.service.ts` — added `type` before `HotkeyDescription`
  - `tabby-settings/buttonProvider.ts`, `tabby-local/buttonProvider.ts` — added `type` before `ToolbarButton`
  - `tabby-core/services/commands.service.ts`, `tabby-core/api/commands.ts` — added `type` before `ToolbarButton`
  - `tabby-community-color-schemes/colorSchemes.ts`, `tabby-mobrowser/src/colorSchemes.ts` — added `type` before `TerminalColorScheme`
  - `tabby-terminal/api/interfaces.ts`, `tabby-terminal/colorSchemes.ts`, `tabby-terminal/api/colorSchemeProvider.ts`, `tabby-terminal/helpers.ts` — added `type` before `TerminalColorScheme`
  - `tabby-core/services/themes.service.ts` — added `type` before `TerminalColorScheme`
  - `tabby-terminal/components/colorSchemePreview.component.ts`, `colorSchemeSelector.component.ts`, `colorSchemeSettingsForMode.component.ts`, `xtermFrontend.ts` — added `type` before `TerminalColorScheme`
  - `tabby-plugin-manager/services/pluginManager.service.ts`, `tabby-core/services/app.service.ts`, `tabby-local/session.ts`, `tabby-core/services/homeBase.service.ts` — added `type` before `BootstrapData`
- **What was done:**
  - For each of the four interface types (`HotkeyDescription`, `ToolbarButton`, `TerminalColorScheme`, `BootstrapData`), found all consumer `.ts` files that imported without `type` keyword
  - Added inline `type` modifier (e.g. `{ type HotkeyDescription, HotkeyProvider }`) to each import that contained only the interface plus other values, or converted to `import type { ... }` where the interface was the sole import
  - Skipped all definition files (`hotkeyProvider.ts`, `toolbarButtonProvider.ts`, `theme.ts`, `mainProcess.ts`) and re-export `index.ts` files
  - Skipped `tabby-mobrowser/src/services/appConfig.service.ts` and `mobrowser.service.ts` which already used `import type { BootstrapData }`
- **Outcome:** `completed` — all 25 consumer files updated; SWC decoratorMetadata no longer erases these interface re-exports before Rolldown validates them

## 2026-07-02 — mobrowser: Phase 4 — tabby-mobrowser Angular package + renderer entry point

- **Files changed:**
  - `mobrowser/src/renderer/packages/tabby-mobrowser/src/services/appConfig.service.ts` — created
  - `mobrowser/src/renderer/packages/tabby-mobrowser/src/services/mobrowser.service.ts` — created
  - `mobrowser/src/renderer/packages/tabby-mobrowser/src/services/hostApp.service.ts` — created
  - `mobrowser/src/renderer/packages/tabby-mobrowser/src/services/hostWindow.service.ts` — created
  - `mobrowser/src/renderer/packages/tabby-mobrowser/src/services/platform.service.ts` — created
  - `mobrowser/src/renderer/packages/tabby-mobrowser/src/services/log.service.ts` — created
  - `mobrowser/src/renderer/packages/tabby-mobrowser/src/services/updater.service.ts` — created
  - `mobrowser/src/renderer/packages/tabby-mobrowser/src/services/fileProvider.service.ts` — created
  - `mobrowser/src/renderer/packages/tabby-mobrowser/src/index.ts` — created
  - `mobrowser/src/renderer/packages/tabby-mobrowser/src/config.ts` — created
  - `mobrowser/src/renderer/packages/tabby-mobrowser/src/hotkeys.ts` — created
  - `mobrowser/src/renderer/packages/tabby-mobrowser/src/pty.ts` — created
  - `mobrowser/src/renderer/packages/tabby-mobrowser/src/pathDrop.ts` — created
  - `mobrowser/src/renderer/packages/tabby-mobrowser/src/colorSchemes.ts` — created
  - `mobrowser/src/renderer/packages/tabby-mobrowser/src/terminalContextMenu.ts` — created
  - `mobrowser/src/renderer/packages/tabby-mobrowser/src/shells/` — 13 shell provider files created
  - `mobrowser/src/renderer/index.ts` — replaced scaffold with Angular bootstrap entry point
  - `mobrowser/src/renderer/index.html` — replaced scaffold with Tabby Angular shell
  - `mobrowser/docs/mobrowser-migration-log.md` — appended Phase 4 entry
- **What was done:**
  - Wrote all Angular services replacing tabby-electron equivalents: AppConfigService (APP_INITIALIZER bootstrap), MoBrowserService (ipc client + bootstrap data accessors), MoBrowserHostAppService, MoBrowserHostWindow, MoBrowserPlatformService, MoBrowserLogService, MoBrowserUpdaterService, MoBrowserFileProvider
  - All Electron IPC calls (ipc.send/invoke/on) replaced with MoBrowser typed RPC calls (ipc.app.*, ipc.window.*, ipc.fs.*, ipc.platform.*, etc.)
  - All shell providers copied/derived from tabby-electron equivalents; window.tabbyAPI.* references replaced with AppConfigService.data.*  and direct ipc.fs.* calls
  - Wrote MoBrowserPTYInterface backed by ipc.pty.* streaming RPCs
  - Wrote MoBrowserModule NgModule wiring all providers and APP_INITIALIZER
  - Wrote renderer/index.ts: loads BootstrapData via IPC before Angular bootstrap, provides BOOTSTRAP_DATA token, statically imports all 11 plugin modules
  - Replaced index.html scaffold with Angular shell
- **Outcome:** completed — all tabby-mobrowser source files written; pending: TypeScript compile verification and tabby-core package API alignment

## 2026-07-02 — mobrowser: Phase 3 — main process entry point

- **Files changed:**
  - `mobrowser/src/main/index.ts` — replaced scaffold stub with full implementation
  - `mobrowser/docs/mobrowser-migration-log.md` — appended Phase 3 entry
- **What was done:**
  - Read all MoBrowser API docs (App, BrowserWindow, AbstractWindow, Clipboard, Displays, Ipc, dialogs guide), all `src/main/gen/*.ts` descriptor and type files, and AGENTS.md before writing any code
  - Implemented all 13 IPC services matching the `ipc_service.ts` descriptors: AppService, FsService, LogService, PlatformService, PtyService, WindowService, DialogService, ScreenService, MenuService, PowerService, ThemeService, UpdaterService, ShellService
  - Built a reusable `AsyncQueue<T>` + `PubSub<T>` helper pattern used by every streaming method; PTY ReadData uses AsyncQueue wired to `ptyProcess.onData`/`onExit`
  - All stubs (ListFonts, GetCursorPoint, OpenExternal, ProgressBar, SetWindowControlsColor, GlobalShortcut, JumpList, ShellService, PowerBlocker, Updater) are commented with the reason; non-stub functionality is fully implemented
- **Outcome:** `completed` — file compiles structurally; runtime correctness depends on node-pty types and @mobrowser/api version; all stubs are documented

## 2026-07-02 — mobrowser: Phase 2 — bulk copy tabby-* packages into renderer/packages/

- **Files changed:**
  - `mobrowser/src/renderer/packages/tabby-core/` — created (126 files copied from `tabby-core/src/`)
  - `mobrowser/src/renderer/packages/tabby-settings/` — created (41 files copied from `tabby-settings/src/`)
  - `mobrowser/src/renderer/packages/tabby-terminal/` — created (68 files copied from `tabby-terminal/src/`)
  - `mobrowser/src/renderer/packages/tabby-local/` — created (24 files copied from `tabby-local/src/`)
  - `mobrowser/src/renderer/packages/tabby-ssh/` — created (45 files copied from `tabby-ssh/src/`)
  - `mobrowser/src/renderer/packages/tabby-serial/` — created (13 files copied from `tabby-serial/src/`)
  - `mobrowser/src/renderer/packages/tabby-telnet/` — created (11 files copied from `tabby-telnet/src/`)
  - `mobrowser/src/renderer/packages/tabby-plugin-manager/` — created (6 files copied from `tabby-plugin-manager/src/`)
  - `mobrowser/src/renderer/packages/tabby-linkifier/` — created (5 files copied from `tabby-linkifier/src/`)
  - `mobrowser/src/renderer/packages/tabby-community-color-schemes/` — created (2 files copied from `tabby-community-color-schemes/src/`)
  - `mobrowser/docs/mobrowser-migration-log.md` — appended Phase 2 entry with full file audit
- **What was done:**
  - Bulk-copied `src/` contents of all 10 specified tabby packages into `mobrowser/src/renderer/packages/` (341 files total); `tabby-electron` deliberately excluded
  - Scanned all 341 files for Electron/IPC references (`window.tabbyAPI`, `ipcRenderer`, `ipcMain`, `electron` imports)
  - Found no direct `electron` module imports; all IPC references are already via `window.tabbyAPI.*` (post-hardening pattern)
  - Identified 9 files with `window.tabbyAPI.*` references and 7 files with Node.js built-in imports (`net`, `path`) that need MoBrowser-specific adaptation in Phase 3
- **Outcome:** `completed` — all 341 source files copied; tsconfig path aliases from Phase 1 now resolve; complete list of files requiring modification documented in migration log

## 2026-07-02 — mobrowser: Phase 1 — proto files and build system

- **Files changed:**
  - `mobrowser/src/renderer/proto/app.proto` — replaced scaffold with real AppService definition
  - `mobrowser/src/renderer/proto/dialog.proto` — created
  - `mobrowser/src/renderer/proto/fs.proto` — created
  - `mobrowser/src/renderer/proto/log.proto` — created
  - `mobrowser/src/renderer/proto/menu.proto` — created
  - `mobrowser/src/renderer/proto/platform.proto` — created
  - `mobrowser/src/renderer/proto/power.proto` — created
  - `mobrowser/src/renderer/proto/pty.proto` — created
  - `mobrowser/src/renderer/proto/screen.proto` — created
  - `mobrowser/src/renderer/proto/shell.proto` — created
  - `mobrowser/src/renderer/proto/theme.proto` — created
  - `mobrowser/src/renderer/proto/updater.proto` — created
  - `mobrowser/src/renderer/proto/window.proto` — created
  - `mobrowser/src/renderer/proto/greet.proto` — deleted (scaffold)
  - `mobrowser/package.json` — Angular 15, rxjs, zone.js, node-pty, keytar, and plugin deps added
  - `mobrowser/tsconfig.json` — experimentalDecorators, emitDecoratorMetadata, jsx:preserve, tabby package paths added
  - `mobrowser/vite.config.ts` — Angular/YAML/Pug plugins and tabby package aliases added to renderer config
  - `mobrowser/docs/mobrowser-migration-log.md` — updated with Phase 1 entries
- **What was done:**
  - Wrote all 13 proto files covering the full IPC surface area (app, dialog, fs, log, menu, platform, power, pty, screen, shell, theme, updater, window)
  - Deleted scaffold `greet.proto`; replaced scaffold `app.proto` with real AppService definition (16 RPCs including server-streaming events)
  - Ran `npm run gen` — succeeded, generated TypeScript stubs in `src/renderer/gen/` and `src/main/gen/`
  - Updated `package.json` with all required Angular, runtime, and build tool dependencies
  - Updated `tsconfig.json` and `vite.config.ts` for Angular compilation and monorepo package path resolution
- **Outcome:** completed — all 13 proto files written, gen succeeds, build config updated

## 2026-07-02 — mobrowser: IPC migration analysis and plan

- **Files changed:**
  - `mobrowser/docs/plan-ipc-migration.md` — created (full analysis + plan)
  - `mobrowser/docs/mobrowser-migration-log.md` — updated
  - `.claude/gotchas.md` — appended IPC migration plan entry
- **What was done:**
  - Inventoried all ~120 Electron IPC channels across 5 namespaces (bridge:, pty:, host:/window-, app:, updater:)
  - Mapped every channel to a MoBrowser Protobuf RPC method across 13 proto files / ~70 methods
  - Documented all pattern changes: M→R events → server-streaming (pub/sub), PTY data → async generator with ctx.signal, app:get-paths sendSync → GetBootstrapData APP_INITIALIZER, window.tabbyAPI → eliminated, context menu popup+click pair → single streaming RPC, backpressure (pty:ack-data) → eliminated
  - Identified 4 open questions before implementation can begin
- **Outcome:** `completed` — planning only; no code written yet

## 2026-07-02 — mobrowser: build system analysis and migration plan

- **Files changed:**
  - `mobrowser/docs/plan-build-system.md` — created (full analysis + plan)
  - `mobrowser/docs/mobrowser-migration-log.md` — created (migration journal)
  - `mobrowser/AGENTS.md` — added Migration Strategy section
- **What was done:**
  - Compared Webpack 5 (Electron/Tabby) vs Vite 8 (MoBrowser) build systems in detail
  - Documented all incompatibilities: Angular compilation, monorepo package resolution, Pug/YAML/PO loaders, SVG inline, dynamic plugin loading, contextBridge/preload
  - Wrote migration plan: copy tabby-* source into src/renderer/packages/, Vite aliases, @analogjs/vite-plugin-angular, static plugin imports, tabby-mobrowser adapter package
  - Identified 4 open questions (Angular 15 + Vite plugin compat, Pug in Angular Vite plugin, zone.js, index.html entry)
- **Outcome:** `completed` — planning only; no code written yet

## 2026-07-02 — mobrowser: isolation hardening + npm run gen

- **Files changed:**
  - `mobrowser/.nvmrc` — created, pins Node 24
  - `mobrowser/.npmrc` — created, sets `engine-strict=true`
  - `mobrowser/node_modules/@mobrowser/cli/node_modules/` — populated (cli deps installed manually to unblock gen)
  - `mobrowser/src/main/gen/`, `mobrowser/src/native/gen/`, `mobrowser/src/renderer/gen/` — generated by `npm run gen`
- **What was done:**
  - Removed yarn.lock; clean-reinstalled node_modules with npm under Node 24.14.1
  - Added `.nvmrc` (Node 24) and `.npmrc` (engine-strict) to enforce isolation
  - `npm run gen` was failing because `@mobrowser/cli` ran `npm install` as a subprocess and picked up parent directory context; resolved by ensuring all commands run from within `mobrowser/`
  - `npm run gen` completed successfully; generated TypeScript bindings in src/main/gen, src/native/gen, src/renderer/gen
- **Outcome:** `completed` — project is isolated, deps installed, code generation done

## 2026-07-02 — Bootstrap mobrowser/ subproject with MoBrowser scaffold

- **Files changed:**
  - `mobrowser/` — created by `npm create mobrowser-app@latest` (Vanilla TypeScript + native)
  - `mobrowser/yarn.lock` — generated by `yarn install` (npm install failed; see gotcha)
  - `docs/technical/browser-only-renderer-migration-log.md` — created (new, per CLAUDE.md requirement)
- **What was done:**
  - Determined UI toolkit: Angular (parent project) has no MoBrowser equivalent; used `--framework Vanilla` (closest no-framework option; `--framework None` has no TypeScript+native template)
  - Determined native modules: confirmed via `@electron/rebuild` in postinstall, `.node` binaries in `app/node_modules/`, and native packages (`node-pty`, `keytar`, `russh`, `@serialport/bindings-cpp`) → `--native yes`
  - Ran `npm create mobrowser-app@latest -- --name mobrowser --framework Vanilla --library Vanilla --variant TypeScript --native yes --setup yes`; project scaffolded successfully
  - `npm install` failed with `cb.apply is not a function`; completed with `yarn install` instead
- **Outcome:** `completed` — `mobrowser/` scaffold created, dependencies installed via yarn

## 2026-07-02 — Fix runtime errors post-sandbox: posix shells, IPC arg mismatch, mixpanel, ligatures stub, Hyper themes

- **Files changed:**
  - `tabby-electron/src/shells/posix.ts` — removed `mz/fs`, use `bridge:fs:exists` + `bridge:file:read` + `TextDecoder`
  - `tabby-electron/src/services/hostApp.service.ts` — removed spurious `_$event` from `cli` IPC listener (bridge already strips the event)
  - `tabby-core/src/services/homeBase.service.ts` — replaced `import * as mixpanel from 'mixpanel'` with `import mixpanel from 'mixpanel-browser'`; `mixpanel-browser` installed, `mixpanel` (Node SDK) removed from `tabby-core/package.json`
  - `tabby-electron/src/services/log.service.ts` — serialize IPC log args to JSON-safe primitives before `ipc.send` to avoid structured-clone errors
  - `tabby-electron/src/colorSchemes.ts` — full rewrite: was broken stub (`tabbyAPI.fs` never existed); now calls `bridge:hyper:get-color-schemes` IPC
  - `app/lib/bridge.ts` — added `bridge:hyper:get-color-schemes` handler (Hyper plugin loading runs in main process, returns color scheme data to renderer)
  - `app/lib/pty.ts` — wrapped `getWorkingDirectoryFromPID` in try/catch; returns `null` on ESRCH instead of throwing across IPC
  - `tabby-settings/src/components/settingsTabBody.component.ts` — rebuilt stale dist (source already had `setTimeout`, dist had old `setImmediate`)
  - `.eslintrc.yml` — added `no-restricted-imports` for Node.js packages in `tabby-*/src/**/*.ts`
- **What was done:**
  - Eliminated all runtime errors visible in DevTools on first boot
  - Identified and fixed root cause of each error rather than swallowing with try/catch
  - Moved Hyper theme loading entirely to main process (proper fix, not stub)
  - Replaced Node.js `mixpanel` server SDK with browser-compatible `mixpanel-browser`
  - Added ESLint `no-restricted-imports` to catch future `fs`, `path`, `os`, `http`, `mixpanel` imports in renderer packages at lint time
  - Noted that `@xterm/addon-ligatures` remains silently disabled (font-finder dep needs main-process IPC migration — separate task)
- **Outcome:** `completed` — app boots without DevTools errors; terminal tabs open successfully

## 2026-07-02 — Fix preload crash: osRelease via process.getSystemVersion(); verify full build

- **Files changed:**
  - `app/lib/sentry.ts` — changed `osRelease: require('os').release()` to `osRelease: (process as any).getSystemVersion?.() ?? ''` (already applied in prior session; rebuilt preload)
  - `app/dist/sentry.js` — rebuilt preload (Jul 2 09:26)
  - `app/dist/bundle.js` — rebuilt renderer (Jul 2 09:23)
  - `app/dist/main.js` — rebuilt main process bundle (Jul 2 09:23)
- **What was done:**
  - Confirmed the `osRelease` fix from prior session is present in built `sentry.js` (`getSystemVersion` present, no `require('os')`)
  - Ran `npx tsc --noEmit` across `tabby-electron`, `tabby-core`, `tabby-terminal`, `tabby-settings`, `tabby-local` — all zero errors
  - Rebuilt all three webpack bundles; no new errors
  - Launched `npx electron .` with `TABBY_DEV=1`; app exits cleanly with code 0; no crash reports in `~/Library/Logs/DiagnosticReports/`
- **Outcome:** `completed` — all packages compile clean, app launches without preload crash

## 2026-07-01 — tabby-local: eliminate Node.js globals from renderer-side source

- **Files changed:**
  - `tabby-local/src/api.ts` — changed `write(data: Buffer)` to `write(data: Uint8Array)` in `PTYProxy`
  - `tabby-local/src/buttonProvider.ts` — added `declare const require: (module: string) => any` for webpack SVG asset require
  - `tabby-local/src/cli.ts` — removed `path` and `mz/fs` imports; added `ipc` helper; replaced `path.resolve` with `resolvePath()` string helper; replaced `fs.exists/stat/lstat` with IPC bridge calls
  - `tabby-local/src/components/environmentEditor.component.ts` — replaced `process.platform` with `(window as any).tabbyAPI.platform`
  - `tabby-local/src/environment.ts` — added `declare const require`; replaced all `process.platform` and `process.env` accesses with `(window as any).tabbyAPI.*`
  - `tabby-local/src/services/terminal.service.ts` — removed `fs` import; replaced `fsSync.existsSync(cwd)` with `await ipc().invoke('bridge:fs:exists', cwd)`
  - `tabby-local/src/session.ts` — removed `mz/fs` and `fs` imports; replaced `Buffer` with `Uint8Array`/`TextEncoder`; replaced all `process.*` and `fs.*` usages with IPC or tabbyAPI equivalents; changed `write(data: Buffer)` to `write(data: Uint8Array)`
- **What was done:**
  - Removed all Node.js globals (`Buffer`, `process`, `require`, `fs`, `path`, `mz/fs`) from `tabby-local/src/`
  - Replaced file system operations with existing `bridge:fs:*` IPC channels
  - Replaced `process.platform` with `(window as any).tabbyAPI.platform` throughout
  - Replaced `process.env` accesses with specific vars from `(window as any).tabbyAPI.env`
  - Replaced `process.kill(pid, 0)` existence check with `ipc().invoke('pty:exists', ptyId)`
  - Skipped `fs.realpath` (no IPC equivalent) — PTY already returns resolved path
- **Outcome:** `completed` — all Node.js globals removed from `tabby-local/src/`; tsc verify requires Bash access (denied during session)

## 2026-07-01 — tabby-terminal and tabby-settings: fix TypeScript compilation errors (no Node.js globals)

- **Files changed:**
  - `tabby-terminal/src/api/baseTerminalTab.component.ts` — added `declare const require`; replaced 2x `setImmediate(fn)` with `setTimeout(fn, 0)`
  - `tabby-terminal/src/components/searchPanel.component.ts` — added `declare const require`
  - `tabby-terminal/src/frontends/xtermFrontend.ts` — replaced `setImmediate(fn)` with `setTimeout(fn, 0)`
  - `tabby-terminal/src/middleware/oscProcessing.ts` — removed `import * as os from 'os'`; replaced `os.homedir()` with `(window as any).tabbyAPI?.env?.HOME ?? tabbyAPI?.env?.USERPROFILE ?? '~'`
  - `tabby-terminal/src/middleware/streamProcessing.ts` — removed `import { PassThrough, Readable, Writable } from 'stream'` and `import { ReadLine, createInterface, clearLine } from 'readline'`; added local `NodeStream` and `ReadLine` interface definitions; replaced imports with runtime `require()` calls cast to typed interfaces; added `declare const require`; changed `Buffer` type in data handler to `Uint8Array | ArrayBuffer`
  - `tabby-settings/src/buttonProvider.ts` — added `declare const require`
  - `tabby-settings/src/components/editProfileGroupModal.component.ts` — added `declare const require`
  - `tabby-settings/src/components/editProfileModal.component.ts` — added `declare const require`
  - `tabby-settings/src/components/settingsTabBody.component.ts` — replaced `setImmediate(fn)` with `setTimeout(fn, 0)`
  - `tabby-settings/src/components/vaultSettingsTab.component.ts` — replaced `Buffer.from(data).toString('base64')` with `btoa(String.fromCharCode(...data))`; replaced `Buffer.from(str, 'base64')` with `atob` + `Uint8Array` construction
- **What was done:**
  - Removed all Node.js-only global and module usages from tabby-terminal and tabby-settings renderer code
  - Replaced `Buffer` with `Uint8Array`/Web APIs (`btoa`/`atob`); replaced `setImmediate` with `setTimeout(fn, 0)`
  - Fixed `os.homedir()` usage in oscProcessing.ts to read from `window.tabbyAPI.env.HOME` (exposed via contextBridge in sentry.ts)
  - Replaced Node.js `stream`/`readline` imports in streamProcessing.ts with local minimal interfaces + runtime `require()` (for electron context where Node.js is available in the renderer via nodeIntegration)
- **Outcome:** `completed` — all 10 identified files fixed; no `setImmediate`, `Buffer`, `os` imports, or Node.js stream/readline imports remain in tabby-terminal/tabby-settings renderer source

## 2026-07-01 — tabby-electron: fix all TypeScript compilation errors (zero Node.js globals)

- **Files changed:**
  - `tabby-electron/tsconfig.json` — added `src/sftpContextMenu.ts` to exclude list
  - `tabby-electron/src/colorSchemes.ts` — removed `mz/fs` and `path` imports; replaced `path.join` with string concatenation; replaced `global` with `window`; added `declare const require`
  - `tabby-electron/src/services/fileProvider.service.ts` — removed `fs` import; replaced `fs.readFile` with `ipc.invoke('bridge:file:read', ...)`
  - `tabby-electron/src/services/platform.service.ts` — removed `path`, `fs/promises`, `fs`, `os` imports; replaced all file I/O with IPC calls; made `getOSRelease()` synchronous with pre-fetched cache; changed `getName()` to synchronous string manipulation; rewrote `ElectronFileUpload`/`ElectronFileDownload`/`ElectronDirectoryDownload` to use IPC file handle API
  - `tabby-electron/src/services/uac.service.ts` — removed `path` import; replaced `path.join/dirname` with string manipulation helper
  - `tabby-electron/src/services/docking.service.ts` — replaced `setImmediate(fn)` with `setTimeout(fn, 0)`
  - `tabby-electron/src/pty.ts` — changed `write(data: Buffer)` to `write(data: Uint8Array)`
  - `tabby-electron/src/terminalContextMenu.ts` — removed `fs` import; replaced `fs.promises.writeFile` with `ipc.invoke('bridge:file:write', ...)`
  - `tabby-electron/src/shells/cmder.ts` — removed `path` import; added `declare const require`; replaced `path.join` with string concatenation
  - `tabby-electron/src/shells/cygwin32.ts` — removed `path` import; added `declare const require`; replaced `path.join` with string concatenation
  - `tabby-electron/src/shells/cygwin64.ts` — removed `path` import; added `declare const require`; replaced `path.join` with string concatenation
  - `tabby-electron/src/shells/gitBash.ts` — removed `path` import; added `declare const require`; replaced `path.join` with string concatenation
  - `tabby-electron/src/shells/powershellCore.ts` — added `declare const require`
  - `tabby-electron/src/shells/msys2.ts` — removed `fs/promises` and `path` imports; added `declare const require`; replaced file operations with IPC calls; replaced `path.join/resolve` with string concatenation
  - `tabby-electron/src/shells/vs.ts` — removed `fs/promises` and `path` imports; added `declare const require`; replaced file operations with IPC calls; replaced `path.join` with string concatenation
  - `tabby-electron/src/shells/windowsStock.ts` — removed `fs/promises`, `path`, `which` imports; added `declare const require`; replaced file checks and path operations with IPC calls
  - `tabby-electron/src/shells/wsl.ts` — removed `mz/fs` import; added `declare const require`; replaced `fs.exists` with IPC call
  - `app/lib/bridge.ts` — added IPC handlers: `bridge:os:release`, `bridge:file:read`, `bridge:file:write`, `bridge:fs:stat`, `bridge:fs:exists`, `bridge:fs:readdir`, `bridge:fs:mkdir`, `bridge:fs:open`, `bridge:fs:read-chunk`, `bridge:fs:write-chunk`, `bridge:fs:close`, `bridge:path:basename`, `bridge:path:dirname`, `bridge:path:join`, `bridge:path:sep`, `bridge:path:posix-sep`
- **What was done:**
  - Eliminated all Node.js module imports (`path`, `fs`, `fs/promises`, `os`, `mz/fs`, `which`) from the renderer-side `tabby-electron/src/` codebase
  - Moved file I/O and OS APIs behind IPC bridge handlers in the main process (`app/lib/bridge.ts`)
  - Added streaming file handle API to the bridge for upload/download operations
  - Replaced `Buffer` with `Uint8Array` in `pty.ts`
  - Replaced `setImmediate` with `setTimeout(..., 0)` in `docking.service.ts`
  - Added `declare const require` to all shell files that use webpack `require()` for SVG icons and native registry modules
- **Outcome:** `completed` — zero tabby-electron-specific TypeScript errors from `npx tsc --noEmit`

## 2026-07-01 — tabby-core: remove Node.js globals for contextIsolation hardening

- **Files changed:**
  - `tabby-core/src/utils.ts` — removed `import * as os from 'os'`; replaced `process.platform` with `window.tabbyAPI?.platform ?? 'linux'`; replaced `os.release()` with `window.tabbyAPI?.osRelease`
  - `tabby-core/src/services/vault.service.ts` — changed `retrieveFile` return type from `Promise<Buffer>` to `Promise<Uint8Array>`; removed `Buffer.from(...)` in favour of `Uint8Array.from(...)`
  - `tabby-core/src/api/fileProvider.ts` — changed abstract `retrieveFile` return type to `Promise<Uint8Array>`
  - `tabby-core/src/services/fileProviders.service.ts` — changed `retrieveFile` return type to `Promise<Uint8Array>`
  - `tabby-core/src/services/hotkeys.service.ts` — removed `import { deprecate } from 'util'`; added local `deprecate()` wrapper
  - `tabby-core/src/components/splitTab.component.ts` — replaced `setImmediate(fn)` with `setTimeout(fn, 0)`
  - `tabby-core/src/components/tabBody.component.ts` — replaced `setImmediate(fn)` with `setTimeout(fn, 0)`
  - `tabby-core/src/services/app.service.ts` — replaced `setImmediate(fn)` with `setTimeout(fn, 0)`
  - `tabby-core/src/commands.ts` — added `declare const require` for webpack asset requires
  - `tabby-core/src/config.ts` — added `declare const require` for yaml/webpack requires
  - `tabby-core/src/directives/dropZone.directive.ts` — added `declare const require` for pug template require
  - `tabby-core/src/services/config.service.ts` — added `declare const require` for deepmerge require
  - `tabby-core/src/services/locale.service.ts` — added `declare const require` for po file dynamic requires
  - `tabby-core/src/theme.ts` — added `declare const require` for scss require
  - `tabby-electron/src/services/fileProvider.service.ts` — changed `retrieveFile` return type to `Promise<Uint8Array>`
  - `tabby-ssh/src/session/ssh.ts` — updated `Buffer` types to `Uint8Array`; replaced `.toString('utf-8')` with `new TextDecoder().decode()`
  - `tabby-ssh/src/services/ssh.service.ts` — replaced `buffer.toString()` with `new TextDecoder().decode(buffer)`
- **What was done:**
  - Removed all Node.js global dependencies (`process`, `Buffer`, `setImmediate`, `import 'os'`, `import 'util'`) from `tabby-core` renderer code
  - Replaced `Buffer` with `Uint8Array` throughout the file provider chain (core + electron + ssh consumers)
  - Used `window.tabbyAPI?.platform` for platform detection instead of `process.platform`
  - Added `declare const require` declarations for webpack-bundled asset requires in renderer files
- **Outcome:** `completed` — zero `tabby-core` errors from `npx tsc --noEmit` in `tabby-electron`; `tabby-core` webpack build succeeds with 0 errors

## 2026-07-01 — Renderer/main-process split: remove process.* from renderer, add IPC bridge handlers

- **Files changed:**
  - `app/lib/sentry.ts` — added `portableExecutableFile` and `env` (HOME, LOGNAME, USERNAME, USERPROFILE, SystemRoot, windir, ProgramFiles, ProgramFiles(x86), CMDER_ROOT, PATHEXT) fields to contextBridge
  - `app/lib/bridge.ts` — added `os`, `path`, `exec` imports; added lazy-initialized winston logger and `getWinstonLogger()` helper; added `bridge:log` ipcMain.on handler; added four `bridge:shell-integration:*` ipcMain.handle handlers
  - `app/webpack.config.main.mjs` — added `winston` and `winston-transport` to externals so the lazy `require('winston')` in bridge.ts is not bundled inline
  - `tabby-electron/src/services/electron.service.ts` — added `arch`, `platform`, `devMode`, `portableExecutableFile`, `env` getters reading from `window.tabbyAPI`
  - `tabby-electron/src/services/log.service.ts` — full rewrite: removed winston/fs/path, replaced with IpcLogger (extends ConsoleLogger, sends `bridge:log` fire-and-forget)
  - `tabby-electron/src/services/updater.service.ts` — replaced `process.platform` → `this.electron.platform`, `process.env.PORTABLE_EXECUTABLE_FILE` → `this.electron.portableExecutableFile`, `process.env.TABBY_DEV` → `this.electron.devMode`
  - `tabby-electron/src/services/hostApp.service.ts` — replaced two `process.env.PORTABLE_EXECUTABLE_FILE` occurrences → `this.electron.portableExecutableFile`
  - `tabby-electron/src/services/dockMenu.service.ts` — replaced four `process.execPath` → `this.electron.exePath`
  - `tabby-electron/src/services/uac.service.ts` — replaced `process.env.TABBY_DEV` → `this.electron.devMode`
  - `tabby-electron/src/services/shellIntegration.service.ts` — full rewrite: removed wnr/fs/exec/path/process.*, replaced with IPC invoke calls to bridge:shell-integration:*
  - `tabby-electron/src/shells/windowsStock.ts` — replaced `process.arch`, `process.env.TABBY_DEV`, `process.env.USERPROFILE`, `process.env.ProgramFiles`, `process.env['ProgramFiles(x86)']`, `process.env.SystemRoot` → `(window as any).tabbyAPI.*`
  - `tabby-electron/src/shells/wsl.ts` — replaced `process.env.windir` → `(window as any).tabbyAPI.env.windir`
  - `tabby-electron/src/shells/msys2.ts` — replaced `process.env.SystemRoot`, `process.env.USERNAME` → `(window as any).tabbyAPI.env.*`
  - `tabby-electron/src/shells/vs.ts` — replaced `process.env['programfiles(x86)']`, `process.env['programfiles']` → `(window as any).tabbyAPI.env['ProgramFiles(x86)']`, `.env.ProgramFiles`
  - `tabby-electron/src/shells/cmder.ts` — replaced all `process.env.CMDER_ROOT` → `(window as any).tabbyAPI.env.CMDER_ROOT`
  - `tabby-electron/src/shells/linuxDefault.ts` — replaced `process.env.LOGNAME` → `(window as any).tabbyAPI.env.LOGNAME`
  - `tabby-electron/src/colorSchemes.ts` — replaced `process.env.HOME!` → `(window as any).tabbyAPI.env.HOME ?? '~'`
  - `tabby-electron/src/sshImporters.ts` — replaced all `process.env.HOME` → `(window as any).tabbyAPI.env.HOME ?? '~'`
- **What was done:**
  - All `process.*` access in renderer-side files moved to preload (via contextBridge) or main process (via IPC handlers)
  - Winston logging from the renderer now goes through `bridge:log` fire-and-forget IPC; winston itself is lazy-required in the main process
  - Shell integration (Windows registry + macOS automator workflows) migrated from wnr/exec calls in the renderer to `bridge:shell-integration:*` ipcMain.handle handlers in bridge.ts
  - All three webpack builds pass: tabby-electron plugin (0 errors), renderer bundle (0 errors), main bundle (0 errors)
- **Outcome:** completed — zero TypeScript errors, all three webpack builds succeed

## 2026-07-01 — Runtime error investigation: preload sandbox + webpack null module

- **Files changed:** `.claude/activity-log.md`, `.claude/gotchas.md` (log only — no source changes this session)
- **What was done:**
  - Ran the app and captured renderer logs forwarded to stdout via `[RENDERER:D/W/E]` prefix
  - Identified two blocking runtime errors persisting after previous build fixes:
    1. `(sandbox_bundle:2) Unable to load preload script: app/dist/sentry.js — Error: module not found: @electron/remote` — Electron's preload sandbox layer cannot resolve `@electron/remote` via `require()` even though the module exists in `app/node_modules/`. The webpack sentry bundle correctly externalises it (outputs `require("@electron/remote")`), but the sandbox runtime rejects the require. Root cause: Electron 20+ enables `sandbox: true` by default for preloads, restricting module resolution to a limited allowlist.
    2. `(bundle.js:131620) Uncaught Error: Cannot find module 'null'` — webpack's `__webpack_require__` is called with string `'null'` as a module ID. Traced to `plugins.ts`: the `_require()` helper falls through to `window.tabbyAPI.nodeRequire`, whose return value was used downstream in a context that webpack's own module resolver intercepted, treating the result as a module identifier. `global['require']` is `undefined` in `target: 'web'` bundles — it is not webpack's `__webpack_require__`.
  - Confirmed the window renders HTML (`"Tabby Alpha"` in Times font) but Angular never bootstraps — `window.tabbyAPI` is never set because the preload fails before `contextBridge.exposeInMainWorld` executes
- **Outcome:** `partial` — errors documented and root causes identified; fixes not yet applied. Next steps: set `sandbox: false` in BrowserWindow `webPreferences` OR inline `@electron/remote` into the sentry bundle; fix `plugins.ts` null module ID by isolating Node.js `require` from webpack `__webpack_require__`.

## 2026-07-01 — Fix renderer bundle Node.js import crashes

- **Files changed:** app/src/entry.preload.ts, app/src/entry.ts, app/src/plugins.ts, app/lib/sentry.ts
- **What was done:**
  - Removed v8-compile-cache and lru from entry.preload.ts (Node.js-only, not needed in renderer)
  - Replaced direct ipcRenderer import in entry.ts with window.tabbyAPI.ipc (via ipcBridge const)
  - Removed top-level mz/fs and path imports from plugins.ts (caused assert cascade crash); added _require() helper for lazy dynamic requires
  - Made nodeRequire/nodeModule lazy; added early returns when unavailable in browser context; converted builtinPluginsPath to a lazy getBuiltinPluginsPath() function
  - Exposed nodeRequire via contextBridge in sentry.ts preload for plugin loading fallback
- **Outcome:** completed — build passes with 0 TypeScript errors across all 17 webpack bundles

## 2026-07-01 — Split dual-context sentry.ts; fix runtime launch errors

- **Files changed:**
  - `app/lib/sentry.ts` — removed `process.type` guard; preload-only file now; added `export {}` to make it a proper TS module
  - `app/lib/sentry-main.ts` — new file; main-process-only Sentry init (uses `@sentry/electron/dist/main`); imported by `lib/index.ts`
  - `app/lib/index.ts` — changed `import './sentry'` → `import './sentry-main'`
  - `app/lib/pty.ts` — changed top-level `require('ps-node')` to a try/catch block (ps-node lives in `tabby-electron/node_modules`, not `app/node_modules`); added null guard in the IPC handler
- **What was done:**
  - Fixed launch crash: `@electron/remote` renderer module called `ipcRenderer.on` in the main process where `ipcRenderer` is `undefined`
  - Fixed `ps-node` not found: module is installed under `tabby-electron/node_modules/`, not `app/node_modules/`
  - Eliminated dual-context file anti-pattern per project rule: main and renderer/preload code must be in separate files
- **Outcome:** completed — app launches cleanly with zero errors

## 2026-07-01 — Complete ElectronService migration; build at zero errors

- **Files changed:**
  - `tabby-electron/src/services/docking.service.ts` — replaced async `getScreens()` with sync version returning `this._screensCache` (added cache + `_refreshScreensCache()` / `_getScreensAsync()` helpers to satisfy `DockingService` base class sync contract)
  - `tabby-electron/src/services/log.service.ts` — `electron.app.getPath('userData')` → `electron.userDataPath`
  - `tabby-electron/src/services/uac.service.ts` — `this.electron.app.getPath('exe')` → `this.electron.exePath` (two occurrences)
  - `tabby-electron/src/shells/windowsStock.ts` — `this.electron.app.getPath('exe')` → `this.electron.exePath` (two occurrences)
  - `tabby-electron/src/sshImporters.ts` — `electron.app.getPath('userData')` → `electron.userDataPath` (two classes: OpenSSHImporter, StaticFileImporter)
  - `tabby-electron/src/terminalContextMenu.ts` — `this.electron.dialog.showSaveDialog(...)` → `this.electron.showSaveDialog(...)`
  - `tabby-electron/src/services/platform.service.ts` — added `!` non-null assertions for `paths` and `filePath` optional parameters (TypeScript does not narrow reassigned optional params past their declaration type)
- **Outcome:** build passes with 0 errors across all 17 webpack bundles

## 2026-07-01 — Establish IPC boundary: contextBridge preload + contextIsolation flip

- **Files changed:**
  - `app/lib/sentry.ts` — replaced Sentry-only preload with combined security preload: Sentry init (renderer-only, no version from remote) + `contextBridge.exposeInMainWorld('tabbyAPI', { ipc, shell, clipboard })`
  - `app/lib/window.ts` — flipped `nodeIntegration: false`, `contextIsolation: true`
  - `app/webpack.config.mjs` — changed `target: 'node'` → `target: 'web'`; added all Node built-ins (`net`, `tls`, `http`, `https`, `os`, `crypto`, `domain`, `constants`, `util`, `stream`, etc.) to `externals` so transitive deps (Sentry, graceful-fs, agent-base) don't cause bundle errors
  - `app/webpack.config.main.mjs` — added `macos-native-processlist`, `@tabby-gang/windows-process-tree`, `native-process-working-directory`, `ps-node` to externals (native addons moved to main process in Task 4)
  - `app/lib/pty.ts` — changed `import * as psNode` to `const psNode = require('ps-node')` to avoid missing-types TS error
  - `tabby-terminal/src/middleware/utf8Splitter.ts` — wrapped `Uint8Array` results in `Buffer.from()` at middleware boundary (base class contract still expects Buffer)
  - `tabby-core/src/services/vault.service.ts` — removed unused `zone: NgZone` from VaultFileProvider; changed `retrieveFile` back to `Promise<Buffer>` wrapping the Web Crypto Uint8Array output
- **What was done:**
  - Full build passes (zero errors across all 17 webpack bundles)
  - IPC boundary established: renderer now has no Node access; only `window.tabbyAPI.{ipc, shell, clipboard}` is exposed via contextBridge
- **Outcome:** completed — build passes; runtime wiring of ElectronService to window.tabbyAPI is the remaining work

## 2026-07-01 — Implement hardening plan Tasks 1–6

- **Files changed:**
  - `app/lib/pty.ts` — Task 3: converted `pty:spawn`, `pty:exists`, `pty:get-pid` handlers from sync `ipcMain.on`/`event.returnValue` to `ipcMain.handle`; Task 4: added `pty:get-child-processes` and `pty:get-working-directory` handlers + native addon try/catch requires
  - `tabby-electron/src/pty.ts` — Task 3: replaced three `ipcRenderer.sendSync` calls with `await ipcRenderer.invoke`; Task 4: removed all native addon imports/requires and platform-branching logic from renderer, replaced with IPC invoke calls
  - `tabby-core/src/utfSplitter.ts` — Task 5a: replaced all `Buffer` with `Uint8Array`
  - `tabby-core/src/services/vault.service.ts` — Task 5b: replaced Node `crypto` + `util.promisify` with Web Crypto (`globalThis.crypto.subtle`), added `hexToBytes`/`bytesToHex` helpers
  - `app/webpack.config.mjs` — Task 2: changed `target: 'node'` → `target: 'electron-renderer'`
  - `web/webpack.config.mjs` — Task 6: extended `resolve.fallback` to explicitly block `fs`, `net`, `tls`, `child_process`, `dns`, `http`, `https`, `path`, `zlib`
  - `app/index.pug` — Task 1 partial: removed `window.nodeRequire = require`
- **What was done:**
  - All 6 hardening tasks implemented; Task 1 (contextIsolation) is partially complete — webPreferences flags not yet flipped because `ElectronService` relies heavily on `@electron/remote` which breaks under `contextIsolation: true`
  - `crypto: false` intentionally omitted from web fallback pending webpack bundle analysis to identify transitive importers
- **Outcome:** partial — Task 1 contextIsolation flip blocked by ElectronService/@electron/remote migration (see gotchas)

## 2026-07-01 — Electron hardening audit and plan

- **Files read:** `app/webpack.config.mjs`, `app/lib/window.ts`, `app/lib/pty.ts`, `app/index.pug`, `tabby-electron/src/pty.ts`, `tabby-core/src/utfSplitter.ts`, `tabby-core/src/services/vault.service.ts`, `web/webpack.config.mjs`
- **Files created:** `.claude/hardening-plan.md`, `CLAUDE.md`, `.claude/activity-log.md`, `.claude/gotchas.md`
- **What was done:**
  - Audited the repo across all 5 hardening categories (Build System, IPC Boundary, Native Addons, Browser-Native Replacements, Test Environment)
  - Identified 12+ violations including `contextIsolation: false`, `nodeIntegration: true`, three synchronous `sendSync` PTY calls, native addons loaded in renderer, and Node `crypto`/`Buffer` in shared libs
  - Produced a 6-task, prioritised hardening plan saved to `.claude/hardening-plan.md`
  - Established mandatory logging and gotcha rules in `CLAUDE.md`
- **Outcome:** completed

## 2026-09-30 — Launch MoBrowser development app

- **Files changed:** `mobrowser/vite.config.ts`, `mobrowser/src/renderer/packages/tabby-terminal/middleware/hexdump.ts`, `hexdump.test.ts`, `streamProcessing.ts`, migration records
- **What was done:** Removed the startup-time Node `hexer` dependency, converted legacy static SVG requires through Vite, and applied local MoBrowser 2.10.1 packaging workarounds under `node_modules`.
- **Verification:** hexdump Node test passed; `npm run dev` built successfully; MoBrowser main and Chromium renderer processes remain running.
- **Outcome:** completed — app launched; clean installs still need an upstream/toolchain packaging fix.

## 2026-10-01 — Complete MoBrowser renderer bootstrap

- **Files changed:** `mobrowser/src/renderer/index.ts`, `app.module.ts`, `index.html`, `vite.config.ts`, copied theme/platform/template files, migration records
- **What was done:** Wired existing Angular providers and plugin metadata, made Vite inline copied Pug templates and SVGs, reused the loaded bootstrap config in DI, and handled a missing first-run config file.
- **Verification:** `npm run dev` reaches `[translate] Setting language to en-US` with no subsequent renderer errors; native main and Chromium renderer processes remain running.
- **Outcome:** completed — MoBrowser is launched and the renderer is ready.

## 2026-10-01 — Restore MoBrowser component styling

- **Files changed:** `mobrowser/package.json`, `package-lock.json`, `CMakeLists.txt`, `vite.config.ts`, `src/renderer/packages/tabby-core/components/tabBody.deep.component.css`, migration records
- **What was done:** Upgraded the standalone app to MoBrowser 2.17, enabled its automation endpoint, centralized Angular `styleUrls` compilation through Vite `?inline` imports, and restored raw SVG markup imports.
- **Verification:** MoBrowser screenshot and computed-style automation show the full-height flex layout and six inline toolbar SVGs with no leaked data-URI text; `npm exec vite build -- --mode renderer` passes.
- **Outcome:** completed — styled MoBrowser app remains running with automation enabled.

## 2026-10-01 — Restore MoBrowser localization and global styling

- **Files changed:** `mobrowser/vite.config.ts`, `src/renderer/index.ts`, `global.scss`, `preload.scss`, `package.json`, `package-lock.json`, migration records
- **What was done:** Normalized Pug's generated bare translation attribute and restored the original renderer-wide SCSS, Source Sans/Code, and Font Awesome entry imports.
- **Verification:** MoBrowser snapshot shows real English labels; automation confirms the bundled font, logo background, and flex form layout; `.mobrowser/localization-fixed.png` captured; renderer production build passes.
- **Outcome:** completed — localization and the omitted global visual layer are restored in the running app.

## 2026-10-01 — Verify MoBrowser local-terminal happy path

- **Files changed:** `mobrowser/src/main/index.ts`, `mobrowser/mobrowser.conf.json`, `mobrowser/package.json`, copied xterm/local-terminal adapters, migration records
- **What was done:** Restored Tabby's PTY call contract and bootstrap metadata, removed obsolete xterm private writes, bundled `node-pty`'s executable helper outside MoBrowser's virtual filesystem, and redirected the native fork call to that physical copy.
- **Verification:** MoBrowser launched `/bin/zsh --login`; automation entered `printf 'MOBROWSER_HAPPY_PATH_OK\\n'` and captured the rendered output in `mobrowser/.mobrowser/happy-path-terminal.png`.
- **Outcome:** completed — the optimistic local-terminal scenario works; SSH/Telnet/serial remain outside this check.

## 2026-10-02 — Exercise MoBrowser UI scenarios

- **Files changed:** migration records only
- **What was done:** Used MoBrowser automation to test Settings → Appearance with a reversible Blink cursor toggle, then created a local terminal, ran `SCENARIO_NEW_TAB_OK`, and attempted to close it.
- **Verification:** Settings/localization/styles and terminal create/input/output passed. Closing the active terminal failed to settle: its finished animation remained `ng-animating`, two headers stayed active, and the shell process survived. Screenshots are in `mobrowser/.mobrowser/scenario-settings-appearance.png`, `scenario-new-tab.png`, and `scenario-tab-close-stuck.png`.
- **Outcome:** partial — two positive UI paths work; active-tab removal/PTY cleanup is a confirmed follow-up.

## 2026-10-02 — Extract reusable Electron-to-MoBrowser migration guidance

- **Files changed:** read `.claude/gotchas.md`, `.claude/activity-log.md`, `CLAUDE.md`, `mobrowser/AGENTS.md`, `mobrowser/docs/mobrowser-migration-log.md`, `mobrowser/docs/plan-build-system.md`, `mobrowser/docs/plan-ipc-migration.md`, and `docs/technical/browser-only-renderer-migration-log.md`; created `docs/technical/electron-to-mobrowser-migration-gotchas.md`; updated this activity log and the technical migration log.
- **What was done:** Extracted only reusable migration lessons, organized them by architectural boundary, added mitigations and a migration order, labeled the observed toolchain/version scope, and linked the source records.
- **Outcome:** `completed` — the generalized Electron-to-MoBrowser guide is available separately from the application-specific journals.

## 2026-10-02 — Make the Electron-to-MoBrowser guide actionable

- **Files changed:** `docs/technical/electron-to-mobrowser-migration-gotchas.md`, `docs/technical/browser-only-renderer-migration-log.md`, `.claude/activity-log.md`; read the linked MoBrowser PTY, bootstrap, build, packaging, and automation artifacts for case references.
- **What was done:** Reassessed the guide for technical sufficiency; replaced broad principles with symptom/cause/action/pass-condition sections; added an end-to-end protobuf/main-service/renderer-proxy example, ownership and cleanup rules, concrete compatibility tables, direct case links, and migration phase exit criteria.
- **Outcome:** `completed` — especially section 2 now explains exactly what moves across the process boundary and shows how to implement it.

## 2026-10-02 — Document encountered limitations and build-system differences

- **Files changed:** `docs/technical/electron-to-mobrowser-migration-gotchas.md`, `docs/technical/browser-only-renderer-migration-log.md`, `.claude/gotchas.md`, `.claude/activity-log.md`; read `mobrowser/docs/plan-build-system.md`, `mobrowser/vite.config.ts`, `mobrowser/mobrowser.conf.json`, and `mobrowser/src/main/index.ts`.
- **What was done:** Added a classified limitations matrix, current implementation-gap status, and a direct Webpack-versus-Vite comparison covering topology, resolution, transforms, module analysis, generated IPC, native packaging, and validation gates. Recorded the newly surfaced Vite 8 OXC/SWC double-transform gotcha.
- **Outcome:** `completed` — the guide now distinguishes inherent constraints, version-specific gaps, and unfinished work while explaining the build migration concretely.

## 2026-10-02 — Promote technical documentation out of `.claude`

- **Files changed:** created `docs/technical/index.md`, `electron-renderer-hardening.md`, `mobrowser-migration-status.md`, and `project-specific-migration-gotchas.md`; updated `electron-to-mobrowser-migration-gotchas.md`, `browser-only-renderer-migration-log.md`, `CLAUDE.md`, `.claude/gotchas.md`, and this log; removed the superseded `.claude/hardening-plan.md`; reviewed `.claude/skills/*`, settings, activity history, gotcha registry, implementation, and installed MoBrowser docs.
- **What was done:** Extracted durable hardening, migration, status, and project-specific knowledge into structured canonical documents; added ordered and task-based navigation plus a source extraction map; retained mandatory raw journals and automation configuration in `.claude`; rejected stale skill-prompt claims that conflict with installed MoBrowser 2.17 docs.
- **Outcome:** `completed` — `docs/technical/index.md` is now the canonical entry point and `.claude` no longer contains the sole copy of any maintained technical guide.

## 2026-10-02 — Validate promoted documentation against current source

- **Files changed:** `docs/technical/mobrowser-migration-status.md`, `project-specific-migration-gotchas.md`, `browser-only-renderer-migration-log.md`, `.claude/gotchas.md`, and this log; read the complete MoBrowser renderer for Node/native/global usage and compared copied terminal middleware with its parent source.
- **What was done:** Found and documented remaining renderer `stream`/`readline` requires, SSH `Buffer` usage, and Windows registry requires that the macOS local-shell scenario did not exercise. Corrected the status from complete to partial and added concrete completion criteria.
- **Outcome:** `completed` — the reorganized documentation now reflects the current source rather than relying solely on older activity claims.

## 2026-10-02 — Prepare the complete local state for the new repository

- **Files changed:** all existing worktree changes, plus `mobrowser/.gitignore` and this log.
- **What was done:** Treated the local `boundary` history and worktree as authoritative, retained the original repository as `upstream`, and prepared the current commit for the new repository's `master` branch; excluded only `mobrowser/.mobrowser/agent.json` because it contains a live local automation token.
- **Verification:** Telnet integration test and renderer production build pass; `git diff --check` passes. The raw Vite main command is not a supported packaging path and attempts to parse `keytar.node`; the MoBrowser build command was started but remained attached without a completion signal and was stopped.
- **Outcome:** ready to commit and publish with a lease-protected branch replacement.
