# Electron to MoBrowser Migration Gotchas

This guide extracts reusable engineering lessons from a real Electron-to-MoBrowser migration. It includes concrete failure symptoms, implementation patterns, and verification criteria. Product-specific behavior is included only when it demonstrates a broader migration problem.

The observations were made with MoBrowser 2.10.1–2.17.0, Vite 8/Rolldown, Node 24, Angular 15, and macOS arm64. API names and packaging behavior can change between releases. Check the documentation installed at `node_modules/@mobrowser/api/docs/` before copying an API call from this guide.

## Target architecture

The central change is not “Electron APIs renamed to MoBrowser APIs.” It is a stricter process boundary:

```text
Renderer feature code
    ↓ calls an application-owned interface
MoBrowser renderer adapter
    ↓ calls a generated Protobuf client
MoBrowser RPC boundary
    ↓ dispatches to a registered service
Main-process service
    ↓ owns Node.js, native addons, files, sockets, and child processes
```

A practical source layout is:

```text
src/renderer/features/          browser-safe UI and domain code
src/renderer/platform/          the only renderer code importing generated IPC
src/renderer/proto/             transport schemas
src/renderer/gen/               generated renderer clients
src/main/services/              Node/native implementations
src/main/gen/                   generated service descriptors and main-side types
```

Pure parsing, formatting, state calculation, and UI logic stay in the renderer. Opening a file, socket, process, credential store, native addon, or OS integration belongs in the main process unless a browser API fully covers the required behavior.

## Limitations encountered in this migration

Not every gap below is an inherent MoBrowser limitation. The classification matters: architectural constraints require redesign, version-specific gaps must be rechecked against current docs, and project stubs still require implementation.

| Limitation encountered | Classification | Engineering impact | Practical response |
|---|---|---|---|
| Renderer cannot use Node.js, Electron, or native addons | Deliberate platform boundary | Renderer-side filesystem, sockets, processes, keychain, and native libraries must move | Typed main-process services with browser-safe DTOs |
| No Electron preload/contextBridge slot | Deliberate platform boundary | Preload globals and earliest-possible preload monitoring disappear | Explicit bootstrap RPC; initialize browser monitoring first in renderer entry |
| No synchronous renderer/main IPC | Deliberate platform boundary | Constructor-time platform/config reads race startup | Fetch one bootstrap payload before UI framework creation; migrate live APIs to async |
| Main-to-renderer communication is subscription-based | RPC model difference | Events emitted before subscription can be lost; routing and fan-out must be designed | Register streams before event production and test multi-window/subscriber behavior |
| Runtime filesystem plugin loading cannot use renderer `require()` | Sandbox/build constraint | Electron-style user plugin discovery does not carry over | Static built-in imports initially; design a separate trusted plugin host if runtime plugins are required |
| Several Electron desktop APIs had no confirmed direct equivalent in the observed version | Version-specific API gap | Progress bar, window-controls color, jump list, power blocker, and some display/shell operations were stubbed or reduced | Recheck installed docs; implement through current API/native service or declare unsupported |
| Auto-update semantics did not match `electron-updater` directly | Version-specific/API-design gap | Check, download progress, install, and restart behavior cannot be assumed equivalent | Design and test an updater flow explicitly instead of wrapping method names |
| Angular was not a scaffold option | Framework integration gap | Framework bootstrap, compilation, templates, and resources needed custom Vite integration | Start from Vanilla TypeScript and add verified framework transforms |
| MoBrowser virtual `/app` cannot execute native sidecar helpers | Packaging/runtime constraint | A native addon can load but fail when it spawns its helper | Bundle, permission, sign, and invoke the helper from a physical resources path |
| MoBrowser 2.10.1–2.17 packaging missed some hoisted dependencies, N-API metadata, peer dependencies, and architecture filtering | Version-specific tooling defects | Clean installs/builds failed despite a working local tree | Pin versions, automate workarounds, validate clean packages, and upstream fixes |
| Web Serial does not expose all native serial settings | Browser API limitation | Changing some options requires reconnect; software flow control is unavailable | Accept/document the reduced baseline or retain a native main-process service |
| UI leave animation completed at the browser level but Angular cleanup did not settle | Observed framework/runtime integration defect | Closed UI and its PTY remained alive | Treat as unresolved; verify DOM and OS-resource teardown, not animation state alone |
| Automation refs survived stale DOM/app state | Tooling limitation | Commands could target retained nodes or an orphaned app whose Vite server had stopped | Pair endpoint with live server and resnapshot after every mutation |

### Current implementation gaps in this case

At the time of writing, the MoBrowser port still contains explicit stubs or degraded implementations for font/color-scheme enumeration, external URL opening, nearest-display/cursor queries, context and dock menus, power blocking, updater behavior, shell integration, progress indication, and window-controls coloring. These are migration status items, not proof that every current MoBrowser release lacks the capability.

SSH, Telnet, and serial were migrated architecturally, but the verified happy path currently covers only a local PTY. Treat those features as unverified until their connect, data, error, cancellation, and teardown paths run end to end.

Case reference: [current main-process services and explicit stubs](../../mobrowser/src/main/index.ts).

## 1. A successful renderer bundle can still be unusable

### Symptom

The renderer production build succeeds, but application startup or a specific feature fails with errors such as:

```text
require is not defined
Cannot resolve module "fs"
Cannot find module "null"
Native module was compiled against a different architecture
```

### Cause

Electron renderers commonly inherit Node.js capabilities through `nodeIntegration`, a preload, `contextBridge`, `@electron/remote`, Webpack globals, or precompiled CommonJS/UMD packages. A MoBrowser renderer is a browser sandbox.

Bundler `external` configuration does not make a Node dependency browser-safe. It preserves a runtime import, which still needs `require`. Likewise, `declare const require` only satisfies TypeScript; it does not provide a runtime implementation.

Transitive packages are easy to miss. A dependency can execute `require('fs')`, `require('net')`, or `Buffer.from()` at module initialization before feature guards run.

### What to do

Audit both source and built dependency graphs:

```sh
rg -n "from ['\"](node:)?(fs|net|tls|path|crypto|stream|child_process)|require\(|@electron/remote|\bprocess\.|\bBuffer\b" src
```

Then classify every result:

| Use | Migration |
|---|---|
| Pure path/string transformation | Browser implementation or small pure helper |
| Cryptography supported by Web Crypto | `globalThis.crypto.subtle` |
| Filesystem, raw TCP, process control | Typed main-process service |
| Native addon | Main process only |
| Platform/version/environment metadata | Bootstrap response |
| Precompiled UMD package requiring Node | Import browser-safe source/ESM or replace it |

Remove Node types from the renderer TypeScript graph as an enforcement mechanism. `types: []` is not sufficient when imported declaration files contain `/// <reference types="node" />`; trace and remove those imports as well.

### Pass condition

- Renderer source and runtime dependencies contain no executable Electron, Node built-in, or native-addon imports.
- A deliberate `process.platform` or `Buffer.from()` probe fails renderer type-checking.
- The production bundle runs without a native `require` shim.

## 2. Move capabilities behind a main-process boundary, not behind new imports

“Use an adapter” is too vague unless ownership is explicit. The concrete rule is: renderer features keep calling application-owned interfaces; one MoBrowser-specific renderer package converts those calls to RPC; the main process owns the real resource.

### Before: a mixed Electron-era feature

This shape cannot run in a browser-only renderer:

```ts
// Renderer-side feature code
import { Socket } from 'node:net'

export class TcpSession {
    private socket = new Socket()

    connect (host: string, port: number): void {
        this.socket.connect(port, host)
    }
}
```

Changing `node:net` to an external or hiding it behind `require()` only moves the failure to runtime.

### After: schema, main owner, renderer proxy

The following is illustrative; confirm generated names against the installed MoBrowser version.

#### 1. Define the serializable contract

```proto
service TcpService {
  rpc Open(OpenTcpRequest) returns (OpenTcpResponse);
  rpc Read(TcpSessionId) returns (stream TcpData);
  rpc Write(WriteTcpRequest) returns (google.protobuf.Empty);
  rpc Close(TcpSessionId) returns (google.protobuf.Empty);
}

message OpenTcpRequest {
  string host = 1;
  uint32 port = 2;
}

message OpenTcpResponse { string session_id = 1; }
message TcpSessionId { string session_id = 1; }
message TcpData { bytes data = 1; }
message WriteTcpRequest {
  string session_id = 1;
  bytes data = 2;
}
```

The socket itself never crosses the boundary. The renderer receives an opaque `session_id`.

#### 2. Own the resource in the main process

```ts
const sockets = new Map<string, Socket>()

ipc.registerService(TcpServiceDescriptor, {
    async Open ({ host, port }) {
        const id = crypto.randomUUID()
        const socket = await connectSocket(host, port)
        sockets.set(id, socket)
        return { sessionId: id }
    },

    async Write ({ sessionId, data }) {
        sockets.get(sessionId)?.write(Buffer.from(data))
        return {}
    },

    async Close ({ sessionId }) {
        sockets.get(sessionId)?.destroy()
        sockets.delete(sessionId)
        return {}
    },
})
```

The real implementation also needs the streaming and disconnect cleanup described in section 6.

#### 3. Preserve the application interface in a renderer proxy

```ts
export class MoBrowserTcpSession implements TcpSession {
    private sessionId: string | null = null

    async connect (host: string, port: number): Promise<void> {
        const response = await ipc.tcp.Open({ host, port })
        this.sessionId = response.sessionId
    }

    async write (data: Uint8Array): Promise<void> {
        await ipc.tcp.Write({ sessionId: this.requireId(), data })
    }

    async close (): Promise<void> {
        if (this.sessionId) {
            await ipc.tcp.Close({ sessionId: this.sessionId })
            this.sessionId = null
        }
    }
}
```

Feature components depend on `TcpSession`, not on generated RPC clients. Only the platform adapter knows MoBrowser.

### How to decide where code belongs

| Operation | Renderer | Main process |
|---|---:|---:|
| Parse a URL, render output, validate a form | Yes | No |
| Read arbitrary files or inspect file existence | No | Yes |
| Open raw TCP/SSH/Telnet sockets | No | Yes |
| Spawn or resize a PTY | No | Yes |
| Store credentials in an OS keychain | No | Yes |
| Use Web Serial with user permission | Yes, if its feature set is enough | If native parity is required |
| Hold a native library object or file handle | No | Yes, return an opaque ID |

### Concrete case from this migration

- The original PTY interface remained the renderer-facing abstraction.
- A MoBrowser renderer implementation translated `spawn`, `write`, `resize`, `read`, and `kill` into generated RPC calls.
- `node-pty` and the actual child process stayed in the main process.
- SSH library objects, sockets, forwarding servers, credential-store calls, and open file handles followed the same pattern: main-owned objects keyed by IDs, browser-safe DTOs in the renderer.
- Serial was different: Chromium Web Serial covered the chosen baseline, so it stayed renderer-side with documented feature reductions.

Case references: [renderer PTY adapter](../../mobrowser/src/renderer/packages/tabby-mobrowser/src/pty.ts), [PTY schema](../../mobrowser/src/renderer/proto/pty.proto), and [main-process service registration](../../mobrowser/src/main/index.ts).

### Pass condition

- Feature packages do not import generated MoBrowser IPC directly.
- One renderer adapter owns platform translation.
- Native objects never appear in protobuf messages or renderer state.
- Creating, using, closing, and abandoning the resource are all tested.

## 3. Electron IPC and MoBrowser RPC have different semantics

### Map behavior, not channel names

| Concern | Electron pattern | MoBrowser pattern |
|---|---|---|
| Request/response | `invoke` / `handle` | Typed unary RPC |
| Fire-and-forget | `send` / `on` | Unary RPC; ignore the promise only deliberately |
| Main-to-renderer event | Main pushes to string channel | Renderer subscribes to server stream first |
| Dynamic channel | ID embedded in channel name | Stable method with ID in request |
| Synchronous IPC | `sendSync` | No equivalent; use asynchronous bootstrap |
| Cancellation | Application-specific | RPC context abort signal |
| Error | Arbitrary rejected value | Stable status/code/details |

For example, replace `pty:${id}:data` plus a separate close event with one stream:

```proto
rpc ReadData(PtyId) returns (stream PtyDataChunk);
```

The stream emits bytes and completes when the PTY exits. The request carries the ID; the method name remains static.

### Choose the correct stream model

#### Broadcast events

Configuration changes, theme changes, and display changes are events that multiple subscribers may need. Confirm whether the generated stream is cold or shared, and add application-level multicast/replay only when required.

#### Resource streams

PTY output, command output, or a menu selection belongs to one subscription. Use an async generator or equivalent service implementation and release its listeners when `ctx.signal` aborts.

### Failure modes to test

- The main process emits before the renderer subscribes.
- Two windows receive an event intended for only one.
- Two subscribers accidentally create two native listeners.
- A renderer reload leaves the old stream listener attached.
- A fire-and-forget unary call rejects and becomes an unhandled promise rejection.

## 4. Replace preload and synchronous startup with explicit bootstrap

### Why this breaks

Electron applications often use a preload to synchronously publish paths, platform details, environment values, or configuration on `window.*` before the UI framework starts. MoBrowser has no equivalent preload/contextBridge slot and no synchronous RPC.

If framework services read those values during construction, starting the RPC after framework bootstrap creates a race: the first caller sees empty strings, wrong platform defaults, or missing configuration.

### Implementation pattern

Return startup-only values in one typed call:

```proto
rpc GetBootstrapData(google.protobuf.Empty) returns (BootstrapData);
```

```ts
const bootstrap = await ipc.app.GetBootstrapData({})

await platformBrowserDynamic([
    { provide: BOOTSTRAP_DATA, useValue: bootstrap },
]).bootstrapModule(AppModule)
```

Useful bootstrap fields include application/version paths, user-data path, platform, architecture, OS release, path separator, development mode, selected environment variables, initial configuration, and installed feature metadata.

Do not expose all of `process.env`; return an allowlist. Do not bake runtime platform data into the bundle with build-time replacement, because that captures the build host rather than the execution host.

### Synchronous interface trap

When an existing interface says `readClipboard(): string` but the MoBrowser operation is asynchronous, choose explicitly:

- change the interface to `Promise<string>` when freshness matters; or
- maintain a cache only when returning a temporarily stale value is acceptable.

Do not silently apply the cache pattern to security, filesystem, dialog, or process state.

Case references: [bootstrap service](../../mobrowser/src/renderer/packages/tabby-mobrowser/src/services/appConfig.service.ts) and [renderer entry](../../mobrowser/src/renderer/index.ts).

## 5. Design protobuf schemas around serialization

### Values that need explicit decisions

| In-process value | Wire representation | Boundary rule |
|---|---|---|
| `Buffer` / `Uint8Array` | `bytes` | Convert to `Buffer` only inside Node-facing code |
| Native object, socket, file handle | Opaque string/integer ID | Main process owns and cleans it |
| `Error` | Code, message, structured details | Never serialize an arbitrary error object |
| Optional/null value | `optional`, wrapper, or explicit presence flag | Do not rely on JavaScript `undefined` semantics |
| Union | `oneof` or tagged message | Make invalid combinations unrepresentable |
| 64-bit size/time | Generated representation must be inspected | Do not assume `bigint`; check precision |

Generated main and renderer types can differ. In this migration, protobuf `bytes` were `Buffer` in main-side generated code and `Uint8Array` in renderer code. Inspect both generated trees instead of assuming symmetry.

### Binary corruption trap

Do not decode binary data to a string merely because `fs.writeFile` also accepts strings:

```ts
// Wrong for arbitrary binary content
await writeFile(path, new TextDecoder().decode(data))

// Preserve bytes at the boundary
await writeFile(path, Buffer.from(data))
```

### Pass condition

Round-trip representative empty, binary, large, optional, and error values through the generated client and service. Compilation alone does not exercise serialization.

## 6. Make ownership, cancellation, and cleanup part of every RPC

Moving privileged work to main creates process-lifetime maps of sessions, handles, streams, and child processes. Every map entry needs an owner and every wait needs an exit.

### Resource lifecycle checklist

| Event | Required behavior |
|---|---|
| Normal renderer close | Close native resource, remove map entry, complete streams |
| Renderer reload/crash | Abort signal removes listeners and closes renderer-owned resources |
| Window close | Clean only resources owned by that window |
| Duplicate open/connect | Return the in-flight operation, reject, or make it idempotent |
| UI prompt never answers | Timeout and reject; do not leave a permanent promise |
| Parent session closes | Close child files, forwards, sockets, and subscriptions first |
| Application shutdown | Drain or terminate all remaining resources |

One-shot event listeners are especially risky: two concurrent operations waiting on the same response can leave one promise blocked forever. Include a request ID or enforce one in-flight operation, and always set a timeout.

### Resource-stream pattern

```ts
async *ReadData ({ sessionId }, ctx) {
    const resource = requireSession(sessionId)
    const queue = new AsyncQueue<Uint8Array>()
    const onData = data => queue.push(data)
    const onExit = () => queue.close()

    resource.on('data', onData)
    resource.on('exit', onExit)
    ctx.signal.addEventListener('abort', () => {
        resource.off('data', onData)
        resource.off('exit', onExit)
        queue.close()
    })

    yield* queue
}
```

### Concrete failure observed here

Closing an active terminal logged the renderer session as destroyed, and its 250 ms Web Animation reached `finished`, but Angular retained the tab in `ng-animating`. Two headers remained active and the shell process survived. The lesson is broader than Angular: a UI lifecycle callback is not proof of native-resource cleanup.

Verify teardown at all layers: DOM/component, stream subscription, main-process map, native handle, and child OS process.

## 7. Understand the build-system change: Webpack to Vite/Rolldown

### Topology and execution model

| Area | Electron/Webpack build in this case | MoBrowser/Vite build |
|---|---|---|
| Configuration topology | Separate main, renderer/preload, and reusable plugin Webpack configs | One `vite.config.ts` selected by `main` or `renderer` mode |
| Module format | CommonJS/UMD tolerated throughout | ESM-first; renderer expects statically analyzable imports |
| Main target | `electron-main` bundle | ESM main bundle using `@mobrowser/api` |
| Renderer target | Web target plus Electron preload bridge | Browser-only ESM renderer |
| Preload output | Dedicated preload/Sentry bundle | No preload output |
| IPC code generation | Handwritten string channels and payloads | `.proto` input generates main descriptors and renderer clients before build |
| Package resolution | Workspace symlinks and custom multi-root module search | Project-local `node_modules`, Vite aliases, and matching TypeScript paths |
| Plugin packaging | Per-plugin UMD output plus runtime discovery | Source ESM and static imports for the initial port |
| Resource handling | Ordered loader chains | Vite plugins, import queries, or explicit source transforms |
| Native packaging | Electron rebuild/packager conventions | `nodeModules` plus explicit bundle extras/signing in MoBrowser config |

The practical consequence is that this is not a configuration-file translation. Source module format, runtime plugin loading, resource imports, entry points, IPC generation, and native packaging all change.

### Resolution differences

Webpack in the Electron application searched several package roots and consumed symlinked workspace packages or their UMD distributions. The isolated MoBrowser project resolves from its own `node_modules`. Source copied into the renderer therefore needs:

1. a Vite `resolve.alias` entry;
2. a matching `tsconfig.json` `paths` entry;
3. every runtime and peer dependency declared locally;
4. framework packages deduplicated where multiple source trees could resolve separate instances.

Without item 2, Vite can build while `tsc --noEmit` reports `TS2307`. Without item 4, framework dependency injection or runtime identity checks can fail even though imports resolve.

### Transform-pipeline differences

Webpack loaders formed an explicit chain for TypeScript, Angular metadata/linking, Pug, SCSS, inline SVG, YAML, PO files, fonts, and images. Vite handles ordinary CSS/assets well but does not automatically reproduce loader-specific semantics embedded in framework decorators or legacy `require()` expressions.

This migration required a renderer-only pipeline with SWC legacy decorators/metadata, YAML and gettext transforms, centralized Angular Pug/style inlining, raw SVG conversion, SCSS import compatibility, and framework dependency deduplication. Vite 8's default OXC TypeScript transform was disabled because running it before SWC stripped information needed by the Angular-oriented transform.

### Module-analysis differences

- Rolldown validates ESM exports after isolated transforms. TypeScript interfaces mistakenly imported as values become hard `MISSING_EXPORT` failures.
- `rollupOptions.onwarn` cannot suppress a hard missing-export error; the imports and barrel exports must use `type`.
- Dynamic or module-scope `require()` patterns that Webpack understood must become static imports or narrowly scoped source transforms.
- Marking Node/native imports as external only postpones the error to the browser sandbox.
- Vite aliases affect bundling only; they do not configure the TypeScript compiler.

### Build and package are separate gates

Vite produces the main and renderer outputs. MoBrowser configuration separately decides which native modules and extra files enter the application bundle and which extras are signed. Therefore all of these can be true at once:

- TypeScript passes but Rolldown fails;
- Vite builds but the renderer fails at runtime;
- the app launches in development but the packaged build lacks a peer dependency;
- the native addon loads but its sidecar cannot execute.

Run type check, production build, clean package, and packaged feature smoke tests as distinct steps.

Case references: [build-system analysis](../../mobrowser/docs/plan-build-system.md), [current Vite configuration](../../mobrowser/vite.config.ts), and [MoBrowser packaging configuration](../../mobrowser/mobrowser.conf.json).

### Compatibility map

| Electron/Webpack mechanism | Vite/MoBrowser migration |
|---|---|
| CommonJS/UMD renderer packages | Prefer browser-safe source ESM |
| `require('./icon.svg')` plus inline loader | Explicit `?raw` import or centralized transform |
| SCSS compiled to a component string | Explicit `?inline` handling where the framework needs text |
| Pug loader | Vite plugin or build-time template transform |
| YAML loader | Vite/Rollup YAML plugin |
| Gettext/PO loader | Preconvert to JSON or add a dedicated transform |
| Runtime filesystem plugin discovery | Static imports or a newly designed plugin host |
| Webpack alias | Matching Vite alias and TypeScript `paths` entry |
| Generated/preload HTML | Real Vite `index.html` entry |

### Common false positives

- Vite resolves an alias, but `tsc --noEmit` reports `TS2307` because `tsconfig.json` lacks the same path mapping.
- The renderer bundle exists, but a copied source package's dependency is absent from the standalone MoBrowser project.
- A framework component compiles, but its runtime template URL loads `index.html` instead of its template.
- A native package is externalized, so the bundle passes, but the sandbox cannot load it.

### Dependency rule for a standalone migration

If the MoBrowser project is intentionally isolated, copy source dependencies deliberately and declare every runtime/peer dependency locally. Do not make the migration appear to work through parent `node_modules`, `NODE_PATH`, or workspace hoisting unless that is the intended production topology.

## 8. Isolated transforms require correct type/value imports

### Symptom

TypeScript passes, but Rolldown reports `MISSING_EXPORT` for an interface re-exported through a barrel.

### Cause and fix

SWC processes each module in isolation. Without an explicit type marker, it can preserve an interface import as a runtime import after TypeScript erases the declaration.

```ts
// Wrong
export { SessionOptions } from './session'
import { SessionOptions } from './api'

// Correct
export type { SessionOptions } from './session'
import type { SessionOptions } from './api'
```

Apply this through every re-export in the chain. `rollupOptions.onwarn` cannot suppress a hard missing-export error and should not be used to hide it.

Ambient `const enum` declarations can also fail under `isolatedModules`. Prefer a normal runtime enum or a small local mapping. If forced to use numeric values from an external protocol, document the mapping next to the code and cover it with a direct test.

## 9. Verify templates, styles, assets, and localization in the running UI

### Why a build is insufficient

Framework resource URLs can remain opaque to Vite even though TypeScript compiles. The app then loads the wrong resource at runtime or silently falls back to browser defaults.

### Angular/Pug case observed in this migration

| Failure | Runtime symptom | Central fix |
|---|---|---|
| Angular JIT `templateUrl` bypassed Vite | Template URL returned `index.html`, recursively creating the root element | Compile and inline component templates in one Vite transform |
| `styleUrls` bypassed Vite | Components rendered with browser-default layout | Rewrite styles to compiled `?inline` imports |
| Webpack-era SVG `require()` returned an asset URL | Data URL/path appeared where raw SVG markup was expected | Load those imports with `?raw` |
| Bare Pug translation directive became `translate="translate"` | Literal `translate` text appeared instead of localized copy | Normalize the generated attribute centrally |
| Old renderer entry imported global assets | Component CSS worked, but fonts, icons, logo, and global layout were missing | Restore entry-level global SCSS/font/icon imports |

Do not patch dozens of components when one resource transform can preserve the original convention.

Case reference: [central Vite resource transforms](../../mobrowser/vite.config.ts).

### Runtime verification

Check more than screenshots:

- localized text rather than translation keys;
- computed root size/display mode;
- loaded font family;
- inline SVG element count and absence of visible data URLs;
- form layout and representative controls;
- navigation between multiple styled views.

## 10. Package the complete native module, not only its `.node` binary

### What can be missing

- matching-architecture `.node` binary;
- native metadata recognized by the packer;
- JavaScript peer/runtime dependencies;
- sidecar executables or shared libraries;
- executable permission bits;
- platform code signatures;
- a physical path from which the OS can launch a helper.

### Concrete case from this migration

`node-pty` loaded its native addon successfully, then derived a `spawn-helper` path inside MoBrowser's virtual `/app`. macOS `posix_spawn` could not execute that virtual path. The working package had to:

1. copy the helper as an explicit application resource;
2. preserve/restore its executable bit;
3. sign it with the application;
4. substitute the physical resources path at the native fork boundary.

The same migration also found packer failures around hoisted CLI dependencies, N-API metadata, unused foreign-architecture binaries, and a native wrapper's missing peer dependency.

Case references: [packaging configuration](../../mobrowser/mobrowser.conf.json) and [physical helper-path integration](../../mobrowser/src/main/index.ts).

### Pass condition

From a clean dependency install, package the application and exercise the actual native feature. Loading the `.node` file or launching only in development mode is not enough.

Never leave the only fix as a manual edit under `node_modules`; make it a project-owned hook or upstream fix.

## 11. Browser-native replacements can change product behavior

Choose browser APIs by capability, not by name similarity.

| Capability | Browser option | Important gap |
|---|---|---|
| Cryptography | Web Crypto | Uses `ArrayBuffer`; preserve existing encodings and parameters |
| Serial | Web Serial | Some settings require reconnect; software flow control may be absent |
| Paths | Pure string/path helper | Cannot inspect filesystem state |
| Streams/readline | Web Streams or small browser implementation | Node event and backpressure semantics may differ |
| Clipboard | Browser/MoBrowser API | Permission and asynchronous timing differ |
| Raw TCP/SSH/Telnet | None in normal browser renderer | Keep behind main-process RPC |
| Arbitrary filesystem | File System Access API only for user-granted scopes | General application paths still belong in main |

For each replacement, record whether behavior is equivalent, intentionally reduced, or delegated to main. Do not weaken the sandbox to preserve a minor convenience.

## 12. Build an explicit desktop API parity table

Before implementation, inventory every Electron API and wrapper method. A useful table contains:

| Existing capability | Call sites | Required behavior | MoBrowser mechanism | Status | Fallback |
|---|---:|---|---|---|---|
| Open external URL | Inventory all callers | Default OS handler | Confirm against installed API docs | Unknown | Main/native service |
| Global shortcut | Inventory all callers | Works while unfocused | Confirm/native | Unknown | Explicitly unsupported |
| Auto-update | Inventory all callers | Download, progress, install | No assumed equivalent | Gap | Product-specific updater |

Cover at least window controls, display queries, dialogs, context menus, shell/open-external behavior, global shortcuts, power management, updater behavior, tray/Touch Bar integration, native theme, clipboard, drag/drop paths, and application lifecycle.

In the observed MoBrowser version, progress-bar integration, window-controls color, power blocker, jump lists, global shortcuts, shell integration, updater, and Touch Bar did not have confirmed equivalents during the initial port. They were explicit stubs, not completed migration work. Recheck current docs rather than carrying those assumptions forward.

## 13. Test vertical slices, including teardown

### Minimum validation matrix

| Layer | What to prove |
|---|---|
| Static audit | Renderer has no Node/Electron/native imports or leaked types |
| Type check | Generated aliases and type-only imports resolve |
| Production build | Main and renderer bundles complete |
| Clean package | Native dependencies and resources are reproducible |
| Bootstrap smoke test | Initial data exists before services/components use it |
| UI smoke test | Localization, global styles, assets, navigation, reversible setting |
| Feature test | Create and use each privileged/native resource |
| Teardown test | Close/reload/crash removes DOM, subscriptions, maps, handles, and processes |

The concrete UI run behind this guide proved why both happy path and teardown matter: settings navigation and terminal create/input/output succeeded, while closing the terminal left its UI transition and shell process stuck.

Case artifacts: [settings scenario](../../mobrowser/.mobrowser/scenario-settings-appearance.png), [terminal creation scenario](../../mobrowser/.mobrowser/scenario-new-tab.png), and [failed close scenario](../../mobrowser/.mobrowser/scenario-tab-close-stuck.png).

### Automation gotchas

- Ensure the automation endpoint and Vite server belong to the same live run. An orphaned app can retain an endpoint while producing connection failures and broken streams.
- Take a fresh accessibility snapshot after tab/view mutations. Element references can point to nodes retained by enter/leave animations.
- Treat automation command completion as input delivery, not as proof that framework change detection and animations settled.
- Check console output and OS resources in addition to pixels.

## Migration sequence with exit criteria

### Phase 1: Inventory

List Electron APIs, preload globals, IPC channels, Node built-ins, native modules, dynamic plugins, build loaders, and runtime assets.

**Exit:** every privileged capability and desktop API has an owner and intended MoBrowser mechanism.

### Phase 2: Boundary and schemas

Define application-owned interfaces, protobuf unary/streaming methods, resource IDs, ownership, cancellation, and error contracts.

**Exit:** a reviewer can trace each renderer request to one main-process capability without a generic escape hatch.

### Phase 3: Bootstrap and renderer isolation

Load static runtime data before UI bootstrap, remove preload dependencies, and make Node globals fail renderer type-checking.

**Exit:** the renderer starts as a browser-only bundle with real runtime data.

### Phase 4: Build and resources

Port Webpack loaders and entry behavior to Vite/ESM, align aliases/dependencies, and restore templates, styles, fonts, icons, and localization.

**Exit:** production build passes and representative UI views are visually and semantically correct.

### Phase 5: Native packaging

Package addons, peer dependencies, sidecars, permissions, signatures, and physical resource paths.

**Exit:** a clean packaged application exercises every native feature on each supported architecture.

### Phase 6: Vertical slices

For each feature, test create/use/error/cancel/close/reload behavior and verify cleanup in both processes.

**Exit:** no resource remains after its owning window or renderer disappears; unsupported parity items are explicit.

## Source records

- [Technical documentation index](./index.md)
- [Current migration status](./mobrowser-migration-status.md)
- [Electron renderer hardening](./electron-renderer-hardening.md)
- [Project-specific gotchas](./project-specific-migration-gotchas.md)
- [Raw append-only gotcha registry](../../.claude/gotchas.md)
- [MoBrowser migration log](../../mobrowser/docs/mobrowser-migration-log.md)
- [Browser-only renderer migration log](./browser-only-renderer-migration-log.md)
- [IPC migration plan](../../mobrowser/docs/plan-ipc-migration.md)
- [Build-system migration plan](../../mobrowser/docs/plan-build-system.md)
