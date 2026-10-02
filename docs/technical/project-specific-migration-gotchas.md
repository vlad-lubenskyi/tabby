# Project-Specific Migration Gotchas

This companion to the [general Electron-to-MoBrowser guide](./electron-to-mobrowser-migration-gotchas.md) preserves implementation details that are important for this codebase but should not be presented as universal MoBrowser behavior.

## 1. Electron compatibility bridge

### Bootstrap metadata is still synchronous in Electron

The hardened Electron preload calls app:get-paths synchronously before exposing window.tabbyAPI. This avoids a first-render race in the Electron baseline, but MoBrowser has no synchronous IPC and replaces it with pre-framework asynchronous bootstrap.

Do not copy the Electron sendSync pattern into MoBrowser.

### Runtime metadata is an allowlist

The preload publishes platform, architecture, OS release, resource paths, development flags, and a small environment-variable allowlist. It intentionally does not expose process or the complete environment.

Adding a renderer feature that reads a new environment variable requires an explicit bootstrap/bridge field. Falling back to process.env reopens the Node boundary.

### Bridge listeners must hide Electron's event object

window.tabbyAPI.ipc.on wraps Electron listeners and invokes the renderer callback with payload arguments only. Passing the internal event object leaks Electron-specific behavior into otherwise portable code.

### Electron service wrappers can conceal remote coupling

An apparently generic platform service may delegate deeply to @electron/remote. Audit the implementation, not only feature imports, before declaring a renderer package browser-safe.

## 2. Application bootstrap and framework wiring

### Root-module construction is application code

The function that assembles the Angular root module is not exported by the core package. The MoBrowser renderer imports the copied application module directly. Importing it from the package alias produces a missing-export failure.

Case reference: [renderer entry](../../mobrowser/src/renderer/index.ts).

### Framework providers must be restored explicitly

Loading component modules is not enough. The standalone entry must restore the original forRoot providers, plugin/module registry, bootstrap token, and explicit root component. Omitting these can produce a renderer that compiles and recursively renders or never reaches configuration readiness.

### Synchronous metadata consumers still exist

Some copied shell/profile providers read platform and environment data synchronously. The migration currently installs a data-only compatibility object after bootstrap while dynamic operations use generated RPC.

This compatibility object must never grow into a generic Electron IPC or require shim.

## 3. Vite, Angular, and dependency integration

### Use type-only imports through the complete barrel chain

SWC decorator metadata plus isolated module transforms caused Rolldown MISSING_EXPORT errors for TypeScript interfaces. Both the consumer and every barrel re-export must use import type/export type.

The warning hook cannot suppress the hard error.

### Keep aliases in both systems

The @gen alias initially existed only in Vite. Bundling resolved it, while tsc failed with TS2307. Every Vite alias used by TypeScript must have a matching compilerOptions.paths entry.

### Copied source does not bring its package dependencies

The standalone mobrowser project cannot rely on parent node_modules. Every bare import in copied packages must resolve from mobrowser/package.json with compatible runtime and peer versions.

### Angular ecosystem versions must match Angular 15

Newer ngx-translate and ngx-toastr releases use Angular APIs unavailable in Angular 15. Versions are pinned to compatible releases. Do not upgrade UI dependencies independently of the framework.

### Sass package exports can block legacy imports

The selected ngx-toastr package exposes its SCSS in a way Dart Sass does not accept under its sass/style conditions. The Vite config uses a narrow importer that resolves that package's style path directly.

Keep this workaround package-specific; do not bypass package exports globally.

### Vite 8 OXC must not run before the SWC pipeline

The renderer disables OXC because SWC owns legacy decorators and decorator metadata. Double transformation strips information needed by the Angular/Rolldown pipeline.

Re-evaluate this only when changing Vite, SWC, or Angular versions.

## 4. Angular resource transformation

### JIT template URLs must be compiled and inlined

Without the central transform, Angular resolves a relative Pug template URL from the document URL. Vite returns index.html, which can recursively instantiate the application root.

### JIT style URLs must enter Vite's CSS pipeline

Without rewriting styleUrls to inline imports, components render with browser-default layout even though the TypeScript bundle succeeds.

### Legacy SVG require calls expect markup

Several consumers inject the imported value as HTML. Vite's normal asset URL is therefore the wrong representation; these sites need raw SVG strings.

### Bare Pug translation directives change meaning

Pug serialized a bare translation attribute as translate="translate". ngx-translate interpreted that as an explicit key. The shared Pug renderer normalizes it to an empty directive value.

### Global resources are separate from component resources

The original renderer entry imported global/preload SCSS, fonts, icons, and logo assets. Reconstructing component style handling did not restore them; they must remain explicit entry imports.

Case reference: [Vite resource transforms](../../mobrowser/vite.config.ts).

## 5. Generated RPC and serialization details

| Detail | Failure | Required handling |
|---|---|---|
| Protobuf bytes | Main generated types use Buffer while renderer uses Uint8Array | Convert at the main/native edge |
| SFTP size and timestamps | Generated fields are number, not bigint | Inspect generated types and convert with Number |
| Native SFTP file type | Dependency exposes ambient const enum incompatible with isolatedModules | Use a documented local mapping/runtime-safe enum |
| StringValue response | Generated wrapper exposes value, not feature-specific names such as target | Read the generated response type |
| Password/passphrase response | Generated message requires remember | Populate every required protobuf field |
| Connect request | Broad object type does not satisfy generated client | Return the exact generated request type |

Generated code is the authority. Do not infer TypeScript representation from the .proto scalar name or the native library's types.

## 6. Stream and adapter contracts

### MoBrowser stream interoperability must be verified

RxJS from() requires an Observable-compatible or AsyncIterable value. The generated MoBrowser streams used here implement AsyncIterable; verify this again after API generation/version changes.

### Preserve existing adapter signatures exactly

The PTY abstraction calls spawn as command, args, options. Treating the first argument as one options object produced an empty executable at runtime even though the adapter compiled.

Audit every caller before changing an adapter boundary.

### Preserve event names expected by callers

The PTY proxy's subscribe contract uses data, exit, and error names. A Map-backed compatibility proxy can silently drop events when names differ because there is no compiler connection between string values.

## 7. Main-process resource ownership

### File handles must close on renderer loss

Integer/string handle maps outlive a renderer reload unless they are associated with an owner and closed on disconnect. Normal CloseHandle calls are not sufficient.

### Binary file writes must remain binary

Text private keys can be written as strings, but arbitrary binary content must cross IPC as bytes and become Buffer in main. TextDecoder followed by fs.writeFile can corrupt binary data.

### Authentication waits need IDs, exclusivity, and timeouts

The SSH authentication flow used one-shot response channels. Two concurrent connects for the same session can register competing once listeners; one consumes the response and the other waits forever.

Enforce one connect per session or correlate responses with unique request IDs, and time out waits when the renderer closes or never answers.

### Destroy during connect must unblock main

Renderer destroy can remove challenge listeners while main still waits for host-key/password input. Cancellation must reject pending waits before removing listeners.

### Close child resources before their parent

SFTP handles, port forwards, jump channels, shell streams, and subscriptions can outlive the parent SSH session unless cleanup explicitly iterates them.

Specific risks found:

- open SFTP handles were not closed when the renderer reloaded;
- unclaimed jump channels remained in a process-global Map;
- SFTP closed observables depended on receiving the parent session's close stream;
- renderer listener cleanup did not automatically cancel a main-side connection attempt.

Case references: [main SSH service](../../mobrowser/src/main/ssh.ts) and [renderer SSH session](../../mobrowser/src/renderer/packages/tabby-ssh/session/ssh.ts).

## 8. Terminal and xterm compatibility

### xterm 6 private fields changed

The copied frontend attempted to write platform flags that are now getter-only. The old private viewport object can also be absent.

Do not overwrite xterm platform detection. Guard private refresh hooks and prefer public fit/resize behavior.

### A restored tab is not necessarily a restored process

UI recovery metadata can survive application restart while its old PTY cannot. Recovery tests must distinguish restoring a tab description from recreating a usable shell session.

### UI destruction is not process destruction

The current close failure shows that logging Destroying and finishing a Web Animation do not prove the PTY exited. Verify DOM state, stream completion, main map state, and OS process state independently.

## 9. Native packaging

### node-pty has an executable sidecar

The addon derives a spawn-helper path inside virtual /app, which macOS cannot execute. The helper is copied and signed as an explicit bundle resource, its executable bit is restored after installation, and the native fork call receives the physical app-resources path.

### The observed packer missed more than native binaries

MoBrowser 2.10.1–2.17 required local workarounds for:

- a hoisted CLI dependency;
- N-API metadata/native detection;
- unused foreign-architecture binaries;
- a native wrapper's JavaScript peer dependency.

These edits are disposable while they remain under node_modules. A clean package is not reproducible until they become project-owned hooks or upstream fixes.

Case references: [packaging config](../../mobrowser/mobrowser.conf.json) and [main PTY integration](../../mobrowser/src/main/index.ts).

## 10. Browser API reductions

### Web Serial

Baud rate is selected when opening a port; changing it reconnects the session. Chromium Web Serial does not expose the original native stack's xon/xoff/xany software-flow-control settings.

### Web Crypto

The vault and key hashing use byte-array APIs. Existing hexadecimal salts/IVs and stored ciphertext compatibility must remain stable.

### Browser stream/readline replacement

The parent terminal middleware uses small browser-compatible pass-through/readline behavior rather than Node stream/readline. The copied MoBrowser file has drifted and still lazily requires both Node modules. Port the existing browser implementation into the MoBrowser copy, then test local-echo, readline, readline-hex, backspace, prompt, resize, and close behavior. The replacement is intentionally not a complete Node API clone.

### Remaining renderer Node leaks

The current MoBrowser renderer audit also found Buffer usage in the SSH shell/importer contracts and dynamic windows-native-registry requires in Windows shell/environment providers. These did not fail the verified macOS local-shell scenario because those paths were not executed.

Do not classify the renderer boundary as complete until these are removed or delegated to typed main-process services.

Case references: [copied stream processor](../../mobrowser/src/renderer/packages/tabby-terminal/middleware/streamProcessing.ts), [SSH shell](../../mobrowser/src/renderer/packages/tabby-ssh/session/shell.ts), and [Windows environment provider](../../mobrowser/src/renderer/packages/tabby-local/environment.ts).

## 11. Desktop integration gaps

The current MoBrowser main service contains explicit stubs or fallbacks for:

- font and color-scheme enumeration;
- external URL opening;
- nearest display and cursor point;
- context and dock menus;
- power-save blocker;
- updater workflow;
- shell integration;
- window progress;
- window-controls color.

These must be rechecked against the installed MoBrowser API before implementation. The exact list is version-sensitive.

The installed 2.17 docs already provide `workspace.openUrl()` and a browser `showContextMenu` handler. Those two current stubs should be treated as unwired capabilities, not missing platform APIs.

Case reference: [main service implementations](../../mobrowser/src/main/index.ts).

## 12. Automation and UI inspection

- An automation endpoint can outlive its Vite server; confirm both belong to one live run.
- Accessibility references become stale when Angular retains animated nodes.
- Take a new snapshot after create/close/select operations.
- A command returning successfully proves input dispatch, not framework settlement.
- Inspect console messages, DOM/class state, generated animations, and OS processes alongside screenshots.

## Superseded notes

Earlier experiments suggested hiding renderer Node usage behind runtime require and local interfaces. That still depends on Node and is not a valid MoBrowser solution. The maintained approach is browser-native code or main-process RPC.

Likewise, build-warning suppression was attempted for Rolldown missing exports. Hard missing-export errors must be fixed with explicit type-only imports/exports.
