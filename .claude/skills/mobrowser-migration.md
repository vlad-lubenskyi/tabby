---
name: mobrowser-migration
description: Use when migrating or adapting an Electron app to the MoBrowser Vite/Rolldown build system. Covers dependency traps, platform API gaps, file system quirks, and networking rewrites specific to MoBrowser.
---

# SKILL: MoBrowser Integration & Build Systems Migration (Maximalist)

## <ROLE>
You are an Expert Platform Engineer specializing in the MoBrowser Vite/Rolldown runtime. Your objective is to adapt a hardened, sandbox-ready application to compile and run smoothly on MoBrowser's build pipeline and OS interfaces.

## <CORE_INVARIANTS> (NON-NEGOTIABLE)
1. **Do Not Externalize Native Packages in Rollup:** You MUST NOT add native `.node` packages to `build.rollupOptions.external` in `vite.config.ts`, as this conflicts with the MoBrowser CLI and crashes Rolldown. Always use `build.rolldownOptions.external` instead.
2. **Pin Legacy React Versions:** Do not default-accept MoBrowser's scaffolded React 19. If porting legacy React 16 components, pin React to `^16.8.4` and use the `'classic'` JSX runtime in Vite, or else all `ReactDOM.render` calls will require a full rewrite.
3. **No Dynamic Executable Calls from the Archive:** You MUST NOT invoke bundled binaries (like Git) using `__dirname` and the OS `execFile` syscall. `__dirname` will resolve inside MoBrowser's virtual `/app/` archive, which the OS cannot execute. Furthermore, the bundler skips Mach-O executables, copying only `.node`, `.dll`, and `.dylib` files.

## <EXECUTION_STEPS_AND_GOTCHAS>
When instructed to resolve MoBrowser build failures or API gaps, apply the following exhaustive fixes:

### 1. Build System & Dependency Traps
- **The `registry-js` macOS Ghost File:** Cross-platform native packages like `registry-js` might not produce a `.node` file on macOS, causing MoBrowser's auto-detection to fail. Rolldown will crash with `UNLOADABLE_DEPENDENCY`. Explicitly add these edge-case packages to `build.rolldownOptions.external`.
- **The `tslib` Vendor Trap:** Vendored native modules (like `desktop-notifications`) compiled with `importHelpers: true` will crash the MoBrowser build because they require `tslib`. You MUST manually add `tslib` to the root `package.json` dependencies so npm hoists it correctly.
- **Symlinks & Local Packages:** MoBrowser's packager fails on symlinked directories ("is a directory" error). Instruct users to STRICTLY use `npm install --install-links` to manage local `file:` vendor packages.
- **SCSS Webpack Syntax:** Vite's internal `sass-embedded` pipeline crashes if it sees Webpack's `~` prefix for `node_modules` (e.g., `@import '~primer-support'`). You MUST strip the `~` prefix or write a custom file importer in `vite.config.ts`.
- **Build-Time Globals:** If the application requires build-time constants (e.g., `__DARWIN__`), ensure an explicit `define` block is added to `defineMainConfig()` in `vite.config.ts`. Otherwise, ambient globals will silently be `undefined` at runtime in the main process.

### 2. Platform API Gaps & UI Degradation
- **Menu Limitations:** MoBrowser has no API to trigger native context menus programmatically; you MUST build HTML/React overlays and suppress the native right-click via `win.browser.handle('showContextMenu', () => 'suppress')`. Furthermore, MoBrowser's `MenuItem` does not support `setVisible()` or `setChecked()`. You must rebuild the entire application menu from scratch to change visibility.
- **The Export Typo:** Ignore MoBrowser documentation instructing you to `import { desktop }`. The actual export required for desktop functionalities is `import { workspace } from '@mobrowser/api'`.
- **Missing Capabilities (Graceful Degradation Required):** 
  - App-level quit cancellation (`CancelQuit`) does not exist. 
  - Native certificate trust dialogs (`showCertificateTrustDialog`) do not exist.
  - Proxy resolution (`resolveProxy`) does not exist.
  - Querying for notification permissions is not supported (`PermissionName` lacks 'notifications'). Optimistically assume notifications are granted.

### 3. File System Resource Management & Networking
- **Static Assets Directory:** Do not place static templates (like JSON or CSS) in the `extras` configuration. They MUST go in a `resources/` directory at the project root, which can be retrieved at runtime via `app.getPath('appResources')`.
- **The Trampoline SSH TCP Rewrite:** Because MoBrowser's renderer is sandboxed, the original Electron credential/ASKPASS server cannot be used. You must rewrite it as an inline TCP server in the main process using `net.createServer`. Because the `split2` dependency is not available, you must manually parse bytes and `\0` splits.
