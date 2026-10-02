# Electron Renderer Hardening

This document is the maintained version of the original .claude hardening plan plus the durable findings from the hardening work. It explains the Electron-side preparation that made the later MoBrowser migration possible.

## Why harden Electron first

The original renderer combined UI code with Node.js, Electron remote APIs, native addons, synchronous IPC, and shared Buffer-based utilities. Moving that application directly to a browser-only runtime makes build failures, runtime failures, and architectural changes arrive at once.

The lower-risk sequence is:

1. enforce a browser-like Electron renderer;
2. expose a narrow preload bridge;
3. move privileged work to the main process;
4. replace shared Node primitives with browser types;
5. only then replace Electron with MoBrowser.

## Current Electron baseline

The Electron implementation currently has:

- nodeIntegration disabled;
- contextIsolation enabled;
- a single preload that combines monitoring and a constrained contextBridge API;
- renderer Webpack target web;
- asynchronous PTY lifecycle IPC;
- renderer-side native process inspection moved to main;
- browser-safe Uint8Array and Web Crypto usage in shared code;
- explicit browser fallbacks for Node modules.

Remaining caveats:

- the preload still uses one synchronous app:get-paths call to publish bootstrap metadata;
- Electron main still initializes @electron/remote; renderer use must remain absent and should eventually be removed completely;
- string-keyed Electron IPC remains broad and less strongly typed than the MoBrowser RPC layer;
- resource maps and request handlers still require reload/disconnect cleanup audits.

Case references: [window security options](../../app/lib/window.ts), [preload bridge](../../app/lib/sentry.ts), [renderer Webpack config](../../app/webpack.config.mjs), and [PTY handlers](../../app/lib/pty.ts).

## 1. Establish the window boundary

### Required window configuration

~~~ts
webPreferences: {
    nodeIntegration: false,
    contextIsolation: true,
    preload: path.join(__dirname, 'sentry.js'),
    backgroundThrottling: false,
}
~~~

Remove any window.nodeRequire = require or equivalent escape hatch. A context-isolated renderer should receive capabilities, not a generic module loader.

### One preload means one composed entry

Electron accepts one preload path per BrowserWindow. Monitoring initialization and the bridge cannot be configured as separate preload files; they must be composed into a single entry or imported by it.

Keep main and preload code in different files. A file that branches on process.type hides the process boundary and can bring ipcRenderer or contextBridge into the main bundle.

### Replace @electron/remote

Audit the complete renderer graph before enabling isolation:

~~~sh
rg -n "@electron/remote|getGlobal\\(|remote\\." app/src tabby-*/src
~~~

Each remote operation becomes either:

- static metadata returned during bootstrap;
- a narrow contextBridge capability;
- an asynchronous IPC request;
- a main-to-renderer event subscription.

Do not expose Electron's module object or a generic module loader to the renderer. Main handlers still need input and ownership validation even when the renderer is trusted.

## 2. Make the renderer build fail on Node dependencies

Use a browser target for the renderer:

~~~js
target: 'web'
~~~

This is stricter than electron-renderer: it prevents Electron's patched runtime from silently satisfying Node imports.

### Externals are not browser compatibility

An external such as fs normally produces a runtime require('fs'). That still fails in an isolated renderer. For an interim Electron hardening build, resolve.fallback: { fs: false } can prevent the runtime import, but it only produces an empty stub. Any feature that calls the API remains broken.

The durable fix is to remove the dependency or move it behind IPC.

### Audit transitive and precompiled code

Precompiled UMD bundles can call Node built-ins in their factory before application code runs. Prefer browser-safe source/ESM over rebundling those artifacts.

Build after every boundary change and trace every unresolved built-in through the dependency graph. Blocking crypto, for example, also blocks transitive packages that import Node crypto.

### Keep runtime data out of build-time defines

Do not replace process.platform, architecture, environment variables, or paths with Webpack DefinePlugin values. That captures the build host and can produce the wrong result after cross-platform packaging.

Return runtime values through preload/bootstrap. Reserve build-time definitions for true compile-time constants.

## 3. Replace synchronous and unsafe IPC

### PTY lifecycle conversion

The renderer previously used synchronous IPC for spawn, existence, and PID queries. Convert:

~~~text
sendSync + event.returnValue
    ↓
invoke + ipcMain.handle
~~~

Every call site must become asynchronous. Pay special attention to constructors and promise initializers: calling a newly asynchronous method from a promise that the method itself depends on can deadlock.

### Handler registration is process-global

ipcMain.handle throws when a channel already has a handler. Initialization that can run more than once must remove the old handler first or be guarded:

~~~ts
ipcMain.removeHandler('pty:spawn')
ipcMain.handle('pty:spawn', handler)
~~~

### Event payload shape changes at the bridge

Electron listener callbacks receive an internal event object first. A preload bridge should strip it:

~~~ts
on: (channel, listener) => {
    const wrapped = (_event, ...args) => listener(...args)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.off(channel, wrapped)
}
~~~

This avoids leaking Electron objects and keeps renderer callbacks transport-neutral.

### Validate every trust boundary

Main handlers must validate paths, command arguments, URLs, IDs, and ownership. Context isolation prevents direct access; it does not make an overly broad IPC handler safe.

## 4. Move native and privileged work to main

Renderer-side native modules for process listing and working-directory lookup were moved into PTY main-process handlers. The same rule applies to:

- filesystem access;
- raw sockets;
- process spawning;
- OS credential storage;
- native window or display helpers;
- .node addons.

Return plain DTOs, byte arrays, or opaque IDs. Do not send native class instances, sockets, file handles, or library objects across IPC.

Resource maps need cleanup on normal close, renderer reload, and window destruction. A renderer that disappears cannot be trusted to send its final close call.

## 5. Make shared code browser-native

### Buffer to Uint8Array

Use Uint8Array in shared and renderer code. Convert to Buffer only at a Node/native boundary.

~~~ts
function concat (a: Uint8Array, b: Uint8Array): Uint8Array {
    const result = new Uint8Array(a.length + b.length)
    result.set(a)
    result.set(b, a.length)
    return result
}
~~~

Use TextEncoder and TextDecoder for text. Do not decode arbitrary binary data merely to pass it through IPC.

### Node crypto to Web Crypto

Web Crypto accepts byte arrays and returns promises. Preserve existing storage formats when migrating encrypted data:

- convert stored hex salt/IV values to bytes before use;
- encode passwords with TextEncoder;
- keep algorithms, iteration counts, IV sizes, and padding-compatible behavior unchanged;
- convert bytes back to the established on-disk encoding.

A cryptographic API rewrite must prove it can decrypt data written by the previous implementation.

### Streams and readline

Do not replace ES imports with runtime require('stream') or require('readline'). Use Web Streams, a small browser implementation for the exact behavior required, or move the operation to main.

## 6. Remove Node and Electron from the renderer type graph

types: [] only disables automatic type discovery. Node globals can still enter through:

- an electron type import, including import type;
- dependency declarations containing a Node triple-slash type reference;
- generated or legacy typings directories;
- a renderer dependency whose public types expose Buffer, Node streams, or Electron classes.

Use TypeScript resolution tracing to find the import chain:

~~~sh
npx tsc --noEmit --traceResolution 2>&1 | rg "Resolving type reference directive 'node'"
~~~

Replace Electron types with local transport/domain interfaces and exclude obsolete declarations. As a smoke test, a temporary process.platform reference in renderer code should produce TS2591.

## 7. Test the boundary

Minimum checks:

1. renderer TypeScript rejects Node globals;
2. the Webpack renderer build succeeds with target web;
3. the application launches with context isolation;
4. platform metadata is present on first render;
5. PTY spawn/write/read/resize/kill works asynchronously;
6. renderer reload removes handlers, listeners, handles, and child resources;
7. existing encrypted data decrypts after the Web Crypto migration.

jsdom does not provide every host API used by a hardened renderer, notably clipboard behavior in many setups. Tests should install explicit host mocks rather than reintroducing Node/Electron access.

## 8. Known hardening traps

| Trap | Result | Prevention |
|---|---|---|
| Externalizing a Node built-in | Runtime require remains | Remove/move the dependency; use a fallback only as temporary detection |
| Sharing one file between main and preload | Wrong-process imports and startup crashes | Separate executable entries |
| Keeping @electron/remote in renderer types/code | Isolation fails at runtime | Replace with explicit IPC/bootstrap |
| Re-registering ipcMain.handle | Uncaught duplicate-handler error | Remove or guard before registration |
| Async method called inside its own initialization chain | Silent unresolved promise | Initialize directly from the underlying IPC call |
| Baking platform/env with DefinePlugin | Build-host values ship to users | Read runtime values through preload/bootstrap |
| Sending binary data as decoded text | Byte corruption | Keep Uint8Array/Buffer at the boundary |
| Process-global file/session maps | Leaks after reload | Associate ownership and clean on disconnect |
| Explicit Webpack module concatenation with incompatible ESM | Null module IDs at runtime | Remove redundant scope-hoisting customization |
| Lazy require in source | Bundler still resolves it | Declare main-only dependency properly or remove it |

## Relationship to the MoBrowser migration

Electron hardening establishes the same browser-only renderer boundary that MoBrowser enforces by default. Continue with [Electron to MoBrowser Migration Gotchas](./electron-to-mobrowser-migration-gotchas.md), which covers typed Protobuf RPC, Vite/Rolldown, native packaging, desktop API parity, and MoBrowser-specific runtime behavior.
