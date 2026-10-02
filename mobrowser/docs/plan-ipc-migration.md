# IPC Migration Plan: Electron → MoBrowser

**Status:** Planning — not yet implemented  
**Date:** 2026-07-02  
**Depends on:** `docs/plan-build-system.md`

---

## 1. Comparative Analysis

### 1.1 Electron IPC Model (current)

**Transport layer:** String-keyed channels over Chromium IPC.  
**API surface exposed to renderer:** `window.tabbyAPI.ipc` (set up by `app/lib/sentry.ts` preload via `contextBridge`):
```typescript
window.tabbyAPI.ipc = {
  invoke(channel, ...args): Promise<any>    // renderer → main, request-response
  send(channel, ...args): void              // renderer → main, fire-and-forget
  on(channel, listener): void              // main → renderer, event subscription
}
```

**Main process registers handlers** in `app/lib/bridge.ts`, `app/lib/pty.ts`, `app/lib/window.ts`, `app/lib/app.ts`:
```typescript
ipcMain.handle('bridge:fs:exists', async (event, path) => fs.existsSync(path))
ipcMain.on('pty:write', (event, id, data) => ptyMap.get(id).write(data))
```

**Characteristics:**
- Completely untyped — string channels, `any` payloads, no schema
- Three patterns: request-response (`handle`/`invoke`), fire-and-forget (`on`/`send`), and M→R events (`send` from main to renderer via `event.sender.send()`)
- ~120 channels across 5 namespaces: `bridge:`, `pty:`, `host:`/`window-`, `app:`, `updater:`
- M→R streams are simulated by main calling `event.sender.send(channel, data)` repeatedly — no backpressure, no lifecycle management
- One synchronous call: `app:get-paths` via `ipcRenderer.sendSync` in the preload, before Angular boots

---

### 1.2 MoBrowser IPC Model

**Transport layer:** Protobuf-encoded binary messages over the MoBrowser runtime IPC bus.  
**API surface in renderer:** Generated typed client imported from `src/renderer/gen/ipc.ts`:
```typescript
import { ipc } from './gen/ipc'

// Unary (request → response)
await ipc.fs.Exists({ path: '/tmp/foo' })         // Promise<ExistsResponse>

// Server streaming (request → stream of responses)
for await (const data of ipc.pty.ReadData({ ptyId })) { ... }  // Stream<PtyData>
ipc.pty.ReadData({ ptyId }).subscribe({ next: handler })       // Observable-compatible
```

**Main process registers services** via generated descriptors:
```typescript
import { ipc } from '@mobrowser/api'
import { FsServiceDescriptor } from './gen/ipc_service'

ipc.registerService(FsServiceDescriptor, {
  async Exists({ path }) { return { exists: fs.existsSync(path) } }
})
```

**Streaming — two modes:**

| Mode | When to use | How |
|------|-------------|-----|
| Pub/sub fan-out | Shared event bus (theme change, config update, window events) | `ipc.registerService(Descriptor)` with no impl; call `service.Method(msg)` to publish |
| Async generator | Per-subscription resource (PTY session, file tail, AI stream) | Implement handler as `async *Method(req, ctx) { yield ... }` |

**`Stream<T>` compatibility:** satisfies TC39 Observable, `[Symbol.asyncIterator]`, Svelte store contract, and Angular `async` pipe simultaneously. RxJS: `from(stream)` converts directly.

**`ctx.signal`:** `AbortSignal` fired when the renderer disconnects or unsubscribes. Plumbs into `fetch`, `node:events.on(emitter, name, { signal })`, and any signal-aware API for deterministic cleanup.

**Errors:** `IpcError` with `.code`, `.message`, `.details` (JSON-serializable). Thrown in handler; caught in renderer as real `instanceof IpcError`.

**Key constraint:** There is no fire-and-forget in MoBrowser IPC. Every call is either unary (returns `Promise`) or server-streaming (returns `Stream`). "Fire-and-forget" semantics are achieved by calling a unary method and not awaiting the result.

---

### 1.3 Model Differences

| Dimension | Electron | MoBrowser |
|-----------|----------|-----------|
| Schema | None (string channels + `any`) | Protobuf — required, compile-time checked |
| Type safety | None | Full, generated |
| Call direction | Bidirectional (R→M and M→R) | R→M only — renderer always initiates |
| Streaming | Ad-hoc: main calls `event.sender.send()` in a loop | First-class: `stream<T>` in proto, `Stream<T>` in TS |
| Fire-and-forget | `ipc.send()` (no response) | Not native — call unary, ignore Promise |
| Sync call | `ipcRenderer.sendSync()` | Does not exist — everything async |
| Backpressure | None | Built-in per subscription |
| Cancellation | Manual | Automatic via `ctx.signal` on disconnect |
| Preload/contextBridge | Required (wraps `ipcRenderer`) | Does not exist |
| Error model | Unstructured rejection | `IpcError` with `.code` + `.details` |

**Critical architectural shift:** In Electron the main process can push events to the renderer spontaneously (`event.sender.send()`). In MoBrowser the renderer must subscribe first — main can only stream to an active subscriber. This affects all M→R event channels (window events, config changes, PTY data, updater events).

---

## 2. Complete Channel Inventory & Mapping

### 2.1 `bridge:` namespace → `FsService`, `PlatformService`, `ShellService`, `MenuService`, `LogService`

#### File System (→ `FsService`)

| Electron channel | Args | MoBrowser method | Proto pattern |
|-----------------|------|-----------------|---------------|
| `bridge:file:read` | `path` | `FsService.ReadFile` | unary → `{data: bytes}` |
| `bridge:file:write` | `path, data` | `FsService.WriteFile` | unary → `Empty` |
| `bridge:fs:stat` | `path` | `FsService.Stat` | unary → `StatResult` |
| `bridge:fs:exists` | `path` | `FsService.Exists` | unary → `{exists: bool}` |
| `bridge:fs:readdir` | `path` | `FsService.ReadDir` | unary → `{entries: string[]}` |
| `bridge:fs:mkdir` | `path, recursive?` | `FsService.Mkdir` | unary → `Empty` |
| `bridge:fs:open` | `path, flags, mode?` | `FsService.OpenHandle` | unary → `{handleId: int32}` |
| `bridge:fs:read-chunk` | `handleId, length` | `FsService.ReadChunk` | unary → `{data: bytes, eof: bool}` |
| `bridge:fs:write-chunk` | `handleId, data, offset` | `FsService.WriteChunk` | unary → `Empty` |
| `bridge:fs:close` | `handleId` | `FsService.CloseHandle` | unary → `Empty` |

**Note on file handles:** The current `bridge:fs:open` / `bridge:fs:read-chunk` / `bridge:fs:close` handle map in bridge.ts leaks on renderer reload (existing gotcha). In MoBrowser, `ctx.signal` fires on renderer disconnect — the `OpenHandle` implementation registers a cleanup callback via `ctx.signal.addEventListener('abort', ...)` to close all open handles for that subscription, eliminating the leak.

#### Path Operations (→ `PlatformService`)

The Electron `bridge:path:*` channels call `node:path` functions on behalf of the renderer. In MoBrowser these become trivial unary methods, but most of these calls exist only because the renderer was previously blocked from calling `path` directly. Audit each call site — if the logic can be expressed without the exact Node `path` result (e.g., joining two known strings), inline it. Only the ones that genuinely need OS-specific separators or resolution need to stay as IPC.

| Electron channel | MoBrowser method |
|-----------------|-----------------|
| `bridge:path:basename` | `PlatformService.PathBasename` |
| `bridge:path:dirname` | `PlatformService.PathDirname` |
| `bridge:path:join` | `PlatformService.PathJoin` |
| `bridge:path:sep` | Included in `AppService.GetBootstrapData` result (static) |
| `bridge:path:posix-sep` | Included in `AppService.GetBootstrapData` result (static) |

#### OS & Platform (→ `PlatformService`)

| Electron channel | MoBrowser method |
|-----------------|-----------------|
| `bridge:os:release` | Included in `AppService.GetBootstrapData` result (static) |
| `bridge:fonts:list` | `PlatformService.ListFonts` → unary → `{fonts: FontInfo[]}` |
| `bridge:process:is-running` | `PlatformService.IsProcessRunning` → unary → `{running: bool}` |
| `bridge:process:exec` | `PlatformService.ExecProcess` → unary → `{exitCode: int32, stdout, stderr}` |
| `bridge:config:read-raw` | Replaced by `AppService.GetBootstrapData` |
| `bridge:hyper:get-color-schemes` | `PlatformService.GetColorSchemes` → unary |

#### Shell Integration (→ `ShellService`)

| Electron channel | MoBrowser method |
|-----------------|-----------------|
| `bridge:shell-integration:get-exe` | `ShellService.GetExePath` → unary |
| `bridge:shell-integration:is-installed` | `ShellService.IsInstalled` → unary → `{installed: bool}` |
| `bridge:shell-integration:install` | `ShellService.Install` → unary → `Empty` |
| `bridge:shell-integration:remove` | `ShellService.Remove` → unary → `Empty` |

#### Menu & Dock (→ `MenuService`)

| Electron channel | MoBrowser method |
|-----------------|-----------------|
| `bridge:menu:popup` | `MenuService.ShowContextMenu` → **streaming** → `stream<MenuClickEvent>` |
| `bridge:dock:set-menu` | `MenuService.SetDockMenu` → unary → `Empty` |

**Important:** `bridge:menu:popup` currently works as R→M request + M→R event (`bridge:menu:click`). The renderer sends menu items, main shows a context menu, and when an item is clicked main fires `bridge:menu:click` back. This is a natural server-streaming pattern: `ShowContextMenu(items)` returns a `stream<MenuClickEvent>` that fires once (when an item is selected) then completes. Renderer subscribes, main publishes the click, stream ends.

#### Logging (→ `LogService`)

| Electron channel | MoBrowser method |
|-----------------|-----------------|
| `bridge:log` | `LogService.Log` → unary → `Empty` (fire-and-forget in practice) |

---

### 2.2 `bridge:app:` + `app:` namespace → `AppService`

| Electron channel | Direction | MoBrowser method | Pattern |
|-----------------|-----------|-----------------|---------|
| `app:get-paths` (sendSync) | R→M sync | `AppService.GetBootstrapData` | unary, called once at startup |
| `bridge:app:get-version` | R→M | Part of `GetBootstrapData` | static |
| `bridge:app:get-path` | R→M | `AppService.GetPath` | unary |
| `bridge:app:get-app-path` | R→M | Part of `GetBootstrapData` | static |
| `bridge:app:relaunch` | R→M | `AppService.Relaunch` | unary → `Empty` |
| `bridge:app:exit` | R→M | `AppService.Exit` | unary → `Empty` |
| `bridge:app:quit` | R→M | `AppService.Quit` | unary → `Empty` |
| `bridge:app:set-jump-list` | R→M | `AppService.SetJumpList` | unary → `Empty` |
| `app:save-config` | R→M | `AppService.SaveConfig` | unary → `Empty` |
| `host:config-change` | M→R event | `AppService.OnConfigChange` | **streaming** → `stream<ConfigPayload>` |
| `app:register-global-hotkey` | R→M | `AppService.RegisterGlobalHotkey` | unary → `Empty` |
| `app:new-window` | R→M | `AppService.NewWindow` | unary → `Empty` |
| `plugin-manager:install` | R→M | `AppService.InstallPlugin` | unary → `Empty` |
| `plugin-manager:uninstall` | R→M | `AppService.UninstallPlugin` | unary → `Empty` |
| `app:ready` | R→M | Replaced — see §3.1 | — |
| `start` | M→R one-shot | Replaced by `GetBootstrapData` | — |
| `cli` | M→R event | `AppService.OnCliInvocation` | **streaming** → `stream<CliArgs>` |
| `uncaughtException` | M→R event | `AppService.OnUncaughtException` | **streaming** → `stream<ErrorInfo>` |
| `host:preferences-menu` | M→R event | `AppService.OnPreferencesRequested` | **streaming** → `stream<Empty>` |

**`GetBootstrapData`** is the replacement for the synchronous `app:get-paths` sendSync. It returns a rich proto message containing all static values the renderer needs at startup: `appVersion`, `appPath`, `userDataPath`, `exePath`, `platform`, `arch`, `osRelease`, `pathSep`, `posixPathSep`, `devMode`, `resourcesPath`, `userPluginsPath`, `installedPlugins`. This is called once during Angular bootstrap via an `APP_INITIALIZER`.

---

### 2.3 `pty:` namespace → `PtyService`

The PTY channels are the most complex mapping due to bidirectional streaming and backpressure.

**Current Electron model:**
```
renderer → main: pty:spawn (handle), pty:exists (handle), pty:get-pid (handle),
                 pty:get-child-processes (handle), pty:get-working-directory (handle)
                 pty:resize (on), pty:write (on), pty:kill (on), pty:ack-data (on)
main → renderer: pty:{id}:data (sender.send), pty:{id}:exit (sender.send), pty:{id}:close (sender.send)
```

**Problems with current model:**
- Data events are per-PTY-ID string channels (`pty:abc123:data`) — dynamic channel names
- Backpressure via `pty:ack-data` is manual and fragile
- No cancellation — if renderer reloads, PTY keeps running but data has nowhere to go

**MoBrowser model for PTY:**

```protobuf
// src/renderer/proto/pty.proto

message SpawnRequest {
  string file = 1;
  repeated string args = 2;
  map<string, string> env = 3;
  string cwd = 4;
  int32 cols = 5;
  int32 rows = 6;
}
message SpawnResponse { string pty_id = 1; int32 pid = 2; }

message PtyId { string pty_id = 1; }

message ResizeRequest { string pty_id = 1; int32 cols = 2; int32 rows = 3; }
message WriteRequest  { string pty_id = 1; bytes data = 2; }
message KillRequest   { string pty_id = 1; string signal = 2; }

message PtyDataChunk { bytes data = 1; }
message PtyExitEvent { string pty_id = 1; int32 exit_code = 2; }

message ChildProcessInfo { int32 pid = 1; string name = 2; }
message ChildProcessList { repeated ChildProcessInfo processes = 1; }

service PtyService {
  rpc Spawn(SpawnRequest) returns (SpawnResponse);
  rpc Exists(PtyId) returns (google.protobuf.BoolValue);
  rpc GetPid(PtyId) returns (google.protobuf.Int32Value);
  rpc Resize(ResizeRequest) returns (google.protobuf.Empty);
  rpc Write(WriteRequest) returns (google.protobuf.Empty);
  rpc Kill(KillRequest) returns (google.protobuf.Empty);
  rpc GetChildProcesses(google.protobuf.Int32Value) returns (ChildProcessList);
  rpc GetWorkingDirectory(google.protobuf.Int32Value) returns (google.protobuf.StringValue);

  // Streaming: subscribe once per PTY, receive all data until exit/disconnect
  rpc ReadData(PtyId) returns (stream PtyDataChunk);
}
```

**`ReadData` implementation** uses the async generator pattern (per-subscription resource):
```typescript
ipc.registerService(PtyServiceDescriptor, {
  async *ReadData({ ptyId }, ctx) {
    const pty = ptyMap.get(ptyId)
    if (!pty) throw new IpcError({ code: 'NOT_FOUND', message: `PTY ${ptyId} not found` })

    const queue = new AsyncQueue<PtyDataChunk>()
    const onData = (data: Buffer) => queue.push({ data })
    const onExit = () => queue.close()

    pty.on('data', onData)
    pty.on('exit', onExit)
    ctx.signal.addEventListener('abort', () => {
      pty.off('data', onData)
      pty.off('exit', onExit)
      queue.close()
    })

    yield* queue
  }
})
```

**Backpressure:** MoBrowser's streaming transport handles backpressure inherently — the async generator naturally pauses when the renderer isn't consuming. The manual `pty:ack-data` channel is eliminated.

**PTY exit event:** The current `pty:{id}:exit` M→R event is folded into `ReadData` — the generator simply returns when the PTY exits, and the `Stream<T>` completes. The renderer detects exit by the stream ending. If the exit code is needed, it can be the last message yielded (add `exit_code` field to `PtyDataChunk`, set it only on the final message), or a separate `rpc GetExitCode(PtyId)` can be added.

---

### 2.4 Window channels → `WindowService`

**Current model:** Main pushes `host:window-*` events spontaneously; renderer fires `window-*` commands as fire-and-forget.

**MoBrowser model:** Renderer subscribes to window event streams; renderer calls unary methods for window control.

```protobuf
// src/renderer/proto/window.proto

message WindowBounds { int32 x = 1; int32 y = 2; int32 width = 3; int32 height = 4; }
message WindowOpacity { double opacity = 1; }
message WindowTitle   { string title = 1; }
message AlwaysOnTop   { bool enabled = 1; }
message ProgressBar   { double value = 1; }
message TrafficLightPos { int32 x = 1; int32 y = 2; }
message VibrancyConfig { bool enabled = 1; string type = 2; }
message DarkModeConfig { string mode = 1; }

service WindowService {
  // Controls (R→M)
  rpc Minimize(google.protobuf.Empty) returns (google.protobuf.Empty);
  rpc ToggleMaximize(google.protobuf.Empty) returns (google.protobuf.Empty);
  rpc BringToFront(google.protobuf.Empty) returns (google.protobuf.Empty);
  rpc Close(google.protobuf.Empty) returns (google.protobuf.Empty);
  rpc SetBounds(WindowBounds) returns (google.protobuf.Empty);
  rpc SetAlwaysOnTop(AlwaysOnTop) returns (google.protobuf.Empty);
  rpc SetTitle(WindowTitle) returns (google.protobuf.Empty);
  rpc SetOpacity(WindowOpacity) returns (google.protobuf.Empty);
  rpc SetProgressBar(ProgressBar) returns (google.protobuf.Empty);
  rpc SetTrafficLightPosition(TrafficLightPos) returns (google.protobuf.Empty);
  rpc SetVibrancy(VibrancyConfig) returns (google.protobuf.Empty);
  rpc SetDarkMode(DarkModeConfig) returns (google.protobuf.Empty);
  rpc SetWindowControlsColor(google.protobuf.StringValue) returns (google.protobuf.Empty);
  rpc Reload(google.protobuf.Empty) returns (google.protobuf.Empty);
  rpc OpenDevTools(google.protobuf.Empty) returns (google.protobuf.Empty);
  rpc ToggleFullscreen(google.protobuf.Empty) returns (google.protobuf.Empty);

  // Events (M→R streaming, pub/sub fan-out)
  rpc OnShown(google.protobuf.Empty) returns (stream google.protobuf.Empty);
  rpc OnMoved(google.protobuf.Empty) returns (stream google.protobuf.Empty);
  rpc OnFocused(google.protobuf.Empty) returns (stream google.protobuf.Empty);
  rpc OnEnterFullScreen(google.protobuf.Empty) returns (stream google.protobuf.Empty);
  rpc OnLeaveFullScreen(google.protobuf.Empty) returns (stream google.protobuf.Empty);
  rpc OnMaximized(google.protobuf.Empty) returns (stream google.protobuf.Empty);
  rpc OnUnmaximized(google.protobuf.Empty) returns (stream google.protobuf.Empty);
  rpc OnCloseRequest(google.protobuf.Empty) returns (stream google.protobuf.Empty);
  rpc OnBecameMainWindow(google.protobuf.Empty) returns (stream google.protobuf.Empty);
}
```

**Implementation (pub/sub fan-out for events):**
```typescript
const win = ipc.registerService(WindowServiceDescriptor)

browserWindow.on('focus',     () => win.OnFocused({}))
browserWindow.on('blur',      () => { /* not subscribed */ })
browserWindow.on('maximize',  () => win.OnMaximized({}))
browserWindow.on('close',     () => win.OnCloseRequest({}))
```

**Usage in renderer (Angular):**
```typescript
// In Angular service, subscribe to the stream and emit on an RxJS Subject:
from(ipc.window.OnCloseRequest({})).subscribe(() => this.closeRequest$.next())
```

`from()` converts `Stream<T>` to an RxJS `Observable<T>` directly — no adapter needed.

---

### 2.5 Screen & Display (→ `ScreenService`)

| Electron channel | MoBrowser method |
|-----------------|-----------------|
| `bridge:screen:get-all-displays` | `ScreenService.GetAllDisplays` → unary |
| `bridge:screen:get-primary-display` | `ScreenService.GetPrimaryDisplay` → unary |
| `bridge:screen:get-display-nearest-point` | `ScreenService.GetDisplayNearestPoint` → unary |
| `bridge:screen:get-cursor-screen-point` | `ScreenService.GetCursorPoint` → unary |
| `host:displays-changed` | `ScreenService.OnDisplaysChanged` → streaming (pub/sub) |
| `host:display-metrics-changed` | `ScreenService.OnDisplayMetricsChanged` → streaming (pub/sub) |

---

### 2.6 Dialog (→ `DialogService`)

| Electron channel | MoBrowser method |
|-----------------|-----------------|
| `bridge:dialog:show-open` | `DialogService.ShowOpenDialog` → unary → `{filePaths: string[], canceled: bool}` |
| `bridge:dialog:show-save` | `DialogService.ShowSaveDialog` → unary → `{filePath: string, canceled: bool}` |
| `bridge:dialog:show-message-box` | `DialogService.ShowMessageBox` → unary → `{response: int32, checkboxChecked: bool}` |

---

### 2.7 Theme (→ `ThemeService`)

| Electron channel | MoBrowser method |
|-----------------|-----------------|
| `bridge:native-theme:get` | `ThemeService.GetNativeTheme` → unary → `{shouldUseDarkColors: bool, ...}` |
| `bridge:native-theme:updated` | `ThemeService.OnNativeThemeUpdated` → streaming (pub/sub) → `stream<NativeTheme>` |

---

### 2.8 Power (→ `PowerService`)

| Electron channel | MoBrowser method |
|-----------------|-----------------|
| `bridge:power-save-blocker:start` | `PowerService.StartBlocker` → unary → `{id: int32}` |
| `bridge:power-save-blocker:stop` | `PowerService.StopBlocker` → unary → `Empty` |

---

### 2.9 Updater (→ `UpdaterService`)

| Electron channel | MoBrowser method |
|-----------------|-----------------|
| `updater:check-for-updates` | `UpdaterService.CheckForUpdates` → unary → `Empty` |
| `updater:quit-and-install` | `UpdaterService.QuitAndInstall` → unary → `Empty` |
| `updater:update-available` | `UpdaterService.OnUpdateAvailable` → streaming (pub/sub) |
| `updater:update-not-available` | `UpdaterService.OnUpdateNotAvailable` → streaming (pub/sub) |
| `updater:update-downloaded` | `UpdaterService.OnUpdateDownloaded` → streaming (pub/sub) |
| `updater:error` | `UpdaterService.OnUpdateError` → streaming (pub/sub) → `stream<ErrorInfo>` |

---

## 3. Special Migration Cases

### 3.0 Preload script elimination

MoBrowser has no preload script slot. The current `app/lib/sentry.ts` preload has **two distinct jobs** that must be handled separately:

**Job 1 — contextBridge setup** (`window.tabbyAPI.*`): Fully covered by the rest of this plan. Every exposed value or API moves to either `GetBootstrapData` (static data) or a typed IPC service call.

**Job 2 — Sentry renderer initialization**: `@sentry/electron/dist/renderer` is initialized in the preload so it captures errors from the first moment the renderer JS context exists — before any application code runs. Without a preload this guarantee cannot be replicated exactly.

**Resolution:** Sentry renderer init moves to the **very top of `src/renderer/index.ts`**, as the first statement before any import that could throw. This means errors thrown during module evaluation of `index.ts` itself are not captured by Sentry, which is an accepted tradeoff — there is no earlier hook available in MoBrowser.

```typescript
// src/renderer/index.ts — first lines, before Angular imports
import * as Sentry from '@sentry/browser'  // use @sentry/browser, not @sentry/electron/dist/renderer
Sentry.init({ dsn: '...', ... })

// Angular bootstrap follows here
import { platformBrowserDynamic } from '@angular/platform-browser-dynamic'
// ...
```

Note: use `@sentry/browser` instead of `@sentry/electron/dist/renderer` — the Electron-specific renderer integration relies on the preload for session tracking and native crash correlation. In MoBrowser, standard browser Sentry is the correct choice.

---

### 3.1 Bootstrapping: replacing `app:ready` + `start` + `app:get-paths` (sendSync)

**Current flow:**
1. Main starts, waits
2. Preload (`sentry.ts`) calls `ipcRenderer.sendSync('app:get-paths')` → receives `{ appPath, appVersion, userDataPath, exePath }` synchronously and exposes on `window.tabbyAPI`
3. Renderer bundle loads, Angular imports start
4. `entry.ts` calls `ipcBridge.once('start', bootstrapData => ...)` — waits for main to push bootstrap data
5. Main receives `app:ready` from renderer → pushes `start` event with full bootstrap data
6. Angular bootstraps with the data

**MoBrowser replacement:**
1. MoBrowser main starts, creates window, loads renderer URL
2. Renderer loads, Angular bootstraps immediately (no gate)
3. `APP_INITIALIZER` in the Angular root module calls `AppService.GetBootstrapData({})` — this is the first IPC call, happens before any component renders
4. The result populates an `AppConfigService` that all other services inject
5. No preload, no `window.tabbyAPI`, no synchronous IPC

```typescript
// src/renderer/packages/tabby-mobrowser/src/services/appConfig.service.ts
@Injectable({ providedIn: 'root' })
export class AppConfigService {
  data: BootstrapData

  async load() {
    this.data = await ipc.app.GetBootstrapData({})
  }
}

// In Angular root module:
providers: [
  {
    provide: APP_INITIALIZER,
    useFactory: (svc: AppConfigService) => () => svc.load(),
    deps: [AppConfigService],
    multi: true,
  }
]
```

### 3.2 Config change propagation

**Current:** Main calls `win.webContents.send('host:config-change', config)` whenever config changes on disk.  
**MoBrowser:** `AppService.OnConfigChange` is a pub/sub stream. Main registers the service, then calls `appService.OnConfigChange(newConfig)` whenever config changes. Renderer subscribes with Angular's `async` pipe or an RxJS `from()`:

```typescript
// In Angular service:
readonly configChange$ = from(ipc.app.OnConfigChange({}))
```

### 3.3 `window.tabbyAPI` — complete elimination

The contextBridge API (`window.tabbyAPI.ipc`, `window.tabbyAPI.shell`, `window.tabbyAPI.clipboard`, `window.tabbyAPI.platform`, etc.) disappears entirely. Every call site in `tabby-electron` that reads from `window.tabbyAPI` is replaced:

| `window.tabbyAPI.*` | MoBrowser replacement |
|---------------------|----------------------|
| `window.tabbyAPI.ipc.invoke(channel, ...args)` | `await ipc.<service>.<Method>(args)` |
| `window.tabbyAPI.ipc.send(channel, ...args)` | `ipc.<service>.<Method>(args)` (not awaited) |
| `window.tabbyAPI.ipc.on(channel, listener)` | `from(ipc.<service>.OnEvent({})).subscribe(listener)` |
| `window.tabbyAPI.platform` | `appConfigService.data.platform` (from bootstrap) |
| `window.tabbyAPI.arch` | `appConfigService.data.arch` |
| `window.tabbyAPI.osRelease` | `appConfigService.data.osRelease` |
| `window.tabbyAPI.devMode` | `appConfigService.data.devMode` |
| `window.tabbyAPI.env.HOME` | `appConfigService.data.env.home` |
| `window.tabbyAPI.shell.openExternal(url)` | `PlatformService.OpenExternal({ url })` |
| `window.tabbyAPI.clipboard.readText()` | `PlatformService.ClipboardReadText({})` |
| `window.tabbyAPI.clipboard.write(...)` | `PlatformService.ClipboardWrite(...)` |

### 3.4 `tabby-electron` → `tabby-mobrowser`

`tabby-electron/src/services/` contains Angular services that implement the interfaces defined in `tabby-core`. Each one currently calls `window.tabbyAPI.ipc.*` or uses `@electron/remote`. Each one becomes a new file in `tabby-mobrowser/src/services/` that calls the MoBrowser IPC client instead.

Key services to rewrite:

| Service | Current dep | MoBrowser replacement |
|---------|-------------|----------------------|
| `ElectronService` | `@electron/remote` | Replaced by `AppConfigService` (static data) + `AppService` IPC |
| `ElectronPlatformService` | `window.tabbyAPI.ipc.*` (50+ calls) | `FsService`, `PlatformService`, `DialogService` IPC clients |
| `HostAppService` | `window.tabbyAPI.ipc.*` | `AppService` IPC client |
| `HostWindowService` | `window.tabbyAPI.ipc.*` | `WindowService` IPC client |
| `DockingService` | `window.tabbyAPI.ipc.*` | `ScreenService`, `WindowService` IPC clients |
| `UpdaterService` | `window.tabbyAPI.ipc.*` | `UpdaterService` IPC client |
| `ShellIntegrationService` | `window.tabbyAPI.ipc.*` | `ShellService` IPC client |
| `LogService` | `window.tabbyAPI.ipc.*` | `LogService` IPC client |
| `ElectronFileProvider` | `window.tabbyAPI.ipc.*` | `FsService` IPC client |

All other `tabby-electron` files (shells, PTY proxy, SSH importers, color schemes, context menus) follow the same pattern: `window.tabbyAPI.ipc.invoke('bridge:...')` → corresponding typed IPC method call.

---

## 4. Proto File Organization

All `.proto` files live in `src/renderer/proto/`. After `npm run gen`:
- `src/main/gen/ipc_service.ts` — all service descriptors + interfaces
- `src/renderer/gen/ipc.ts` — all typed client methods

```
src/renderer/proto/
  app.proto         AppService
  dialog.proto      DialogService
  fs.proto          FsService
  log.proto         LogService
  menu.proto        MenuService
  platform.proto    PlatformService (fonts, exec, color schemes, clipboard, shell/open-external)
  power.proto       PowerService
  pty.proto         PtyService
  screen.proto      ScreenService
  shell.proto       ShellService (shell integration install/remove)
  theme.proto       ThemeService (native theme)
  updater.proto     UpdaterService
  window.proto      WindowService
```

---

## 5. Migration Rules

1. **Every Electron channel becomes exactly one proto RPC method.** No channel is left as a raw string. No shims over the old `window.tabbyAPI.ipc.*` surface.

2. **Unary by default.** If the channel was request-response (`ipcMain.handle`), it becomes a unary RPC. If it was fire-and-forget (`ipc.send`), it becomes a unary RPC with `Empty` response — the renderer does not `await` it.

3. **Streaming for all M→R events.** Every channel that went M→R (main pushing to renderer) becomes a server-streaming RPC. Use pub/sub fan-out (no impl) when the event is broadcast to all windows; use async generator when the event is per-subscription (PTY data).

4. **No dynamic channel names.** The current `pty:{id}:data` pattern (channel name includes a runtime ID) is replaced by a streaming RPC that takes the ID as a request field.

5. **`ctx.signal` for all cleanup.** Every streaming handler that holds a resource (PTY listener, file handle, event emitter) registers cleanup on `ctx.signal`. No explicit close channels needed.

6. **`GetBootstrapData` replaces preload.** All data currently exposed via `window.tabbyAPI.*` static fields is returned from `AppService.GetBootstrapData` and seeded into Angular via `APP_INITIALIZER`.

7. **`tabby-mobrowser` is the only package that imports from `./gen/ipc`.** All other packages (`tabby-core`, `tabby-terminal`, etc.) depend on abstract Angular service interfaces defined in `tabby-core`. Only `tabby-mobrowser` binds those interfaces to MoBrowser IPC.

---

## 6. Open Questions

1. **`@mobrowser/api` `ipc` import on renderer side:** The generated `src/renderer/gen/ipc.ts` is what the renderer imports. Does it need to be imported as a singleton? If two Angular services both `from(ipc.app.OnConfigChange({}))`, do they share the same underlying subscription or create two? Need to verify cold vs. hot stream semantics for pub/sub fan-out streams. The docs say `Stream<T>` is cold (each subscription is independent) — which means two Angular services subscribing both receive the events. This is correct for pub/sub fan-out because main publishes to all subscribers.

2. **Per-window vs. per-app services:** The current Electron app supports multiple windows, each with its own renderer. Services like `WindowService` are per-window (each window has its own `BrowserWindow` instance). MoBrowser's `ipc.registerService` — does it register globally or per-window? Need to confirm from docs or source whether service handlers can identify which renderer window is calling via `ctx` and route accordingly.

3. **`electron-updater` equivalent:** The updater channels wrap `electron-updater`. MoBrowser's equivalent (if any) needs to be identified. If there is no built-in updater, `UpdaterService` can wrap whatever MoBrowser provides for auto-update or use a generic HTTP check.

4. **TouchBar (`touchbar-selection`):** macOS-only. MoBrowser's API for TouchBar (if any) is unknown. This channel can be deferred.
