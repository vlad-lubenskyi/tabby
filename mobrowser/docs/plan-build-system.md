# Build System Migration Plan: Webpack (Electron) → Vite (MoBrowser)

**Status:** Planning — not yet implemented  
**Date:** 2026-07-02

---

## 1. Comparative Analysis

### 1.1 Electron (Tabby) Build System

**Tool:** Webpack 5  
**Three independent webpack configurations:**

| Config | Target | Output | Purpose |
|--------|--------|--------|---------|
| `app/webpack.config.main.mjs` | `electron-main` | `app/dist/main.js` | Main process (Node.js) |
| `app/webpack.config.mjs` | `web` | `app/dist/{bundle,preload,sentry}.js` | Renderer + preload |
| `webpack.plugin.config.mjs` (shared template) | `web` | `tabby-*/dist/index.js` (UMD) | Each plugin package |

**Monorepo module resolution — critical detail:**  
Each `tabby-*` package is a separate npm package under the repo root. Webpack plugin configs resolve modules via:
```
modules: ['.', 'src', 'node_modules', '../app/node_modules', '../node_modules']
```
At runtime, `scripts/install-deps.mjs` creates symlinks:
```
node_modules/tabby-core  →  ../tabby-core/
node_modules/tabby-local →  ../tabby-local/
...
```
This lets webpack (and Node.js `require()`) find `tabby-core` without `../` relative paths.  
Each plugin compiles its TypeScript source to a UMD bundle (`dist/index.js`) which the app webpack then statically bundles via `require('tabby-core')` at the top of `plugins.ts`.

**Angular compilation:**  
`@ngtools/webpack` (JIT mode) handles `.ts` files — Angular decorator processing, template compilation, dependency injection metadata. A separate `babel-loader` pass applies the Angular linker plugin to `.js/.mjs` files for the DI system.

**Webpack loaders in use:**

| Loader | File type | What it does |
|--------|-----------|--------------|
| `@ngtools/webpack` | `.ts` | Angular JIT compiler + decorator metadata |
| `babel-loader` + Angular linker | `.js/.mjs` | DI linker for pre-compiled Angular libs |
| `pug-loader` / `pug-html-loader` | `.pug` | Pug templates → HTML strings (Angular `templateUrl`) |
| `@tabby-gang/to-string-loader` + `sass-loader` | `.component.scss` | Component SCSS → TypeScript string |
| `style-loader` + `css-loader` + `sass-loader` | `.scss/.css` | Global styles → injected `<style>` tags |
| `svg-inline-loader` | `.svg` | SVG files → inline HTML string |
| `file-loader` | fonts, images | Copies to `dist/`, returns public URL |
| `yaml-loader` | `.yaml` | YAML → JS object |
| `po-gettext-loader` | `.po` | Gettext PO → JSON translation object |
| `json-loader` | `.json` | JSON (explicit) |
| `raw-loader` | misc | Raw file → string |

**Plugin system:**  
Webpack statically bundles built-in plugins at build time (via module-scope `require()` calls in `plugins.ts`). At runtime the renderer also supports dynamic filesystem discovery of user-installed plugins via Node.js `require()` — but this only works when `nodeIntegration` is on, which it no longer is in production.

---

### 1.2 MoBrowser Build System

**Tool:** Vite 8  
**Single `vite.config.ts` file, two modes:**

| Mode | Root | Output | Purpose |
|------|------|--------|---------|
| `main` | `src/main/` | `out/main/index.js` | Main process (Node.js, ESM) |
| `renderer` | `src/renderer/` | `out/renderer/` | Renderer (Chromium, ESM) |

**Module resolution:**  
Standard Node.js / Vite resolution from `mobrowser/node_modules/`. No symlinks, no multi-root `modules` array. Vite supports `resolve.alias` for custom path mappings.

**IPC:**  
Protobuf-based typed RPC. `.proto` files in `src/renderer/proto/` define services; `npm run gen` generates:
- `src/main/gen/ipc_service.ts` — service descriptors for main-side `ipc.registerService(...)`
- `src/renderer/gen/ipc.ts` — typed client for renderer-side calls

**No preload concept.** The contextBridge/preload pattern from Electron does not exist. The renderer/main boundary is absolute.

**No Angular out of the box.** The scaffold is Vanilla TypeScript. Angular is not a supported framework option but can be added via a Vite plugin.

---

### 1.3 Key Incompatibilities

| Area | Electron | MoBrowser | Gap |
|------|----------|-----------|-----|
| Build tool | Webpack 5 | Vite 8 | Different plugin ecosystems, config format |
| Angular compilation | `@ngtools/webpack` | ❌ not included | Needs `@analogjs/vite-plugin-angular` |
| Monorepo packages | Symlinks + multi-path resolution | Standard npm in `node_modules/` | Packages must be copied into `src/` and aliased |
| Pug templates | `pug-loader` | ❌ not included | Needs `vite-plugin-pug` |
| SCSS → string | `@tabby-gang/to-string-loader` | ❌ not included | Handled by `@analogjs/vite-plugin-angular` natively |
| SVG inline | `svg-inline-loader` | `?raw` query | Import sites need updating |
| YAML | `yaml-loader` | `@rollup/plugin-yaml` | Vite supports rollup plugins |
| PO gettext | `po-gettext-loader` | no direct equivalent | Pre-compile to JSON during copy step |
| Dynamic plugins | Runtime `require()` scan | ❌ sandbox forbids it | Static imports only |
| preload / contextBridge | `app/lib/sentry.ts` | ❌ does not exist | `window.tabbyAPI.*` APIs replaced by IPC |
| UMD bundles | Each `tabby-*/dist/index.js` | Not needed | Import TypeScript source directly |
| `mainFields` ordering | `['esm2015', 'browser', 'module', 'main']` | Vite default | Vite uses `['browser', 'module', 'jsnext:main', 'jsnext']` — compatible |

---

## 2. Migration Plan

### Rule
No shims, polyfills, or compatibility layers. Every incompatibility must be resolved by either a real Vite equivalent or a source-level transformation applied during the copy/modify step.

---

### 2.1 Vite Configuration (`vite.config.ts`)

**Renderer mode additions:**

1. **Add `@analogjs/vite-plugin-angular`** — handles:
   - TypeScript decorators (`@Component`, `@Injectable`, `@NgModule`, `@Pipe`, `@Directive`)
   - Angular template compilation (`templateUrl`, inline `template`)
   - Angular component styles (`styleUrls`, inline `styles`) — renders SCSS via Vite's native CSS pipeline, no need for `@tabby-gang/to-string-loader`
   - Decorator metadata for Angular DI (`emitDecoratorMetadata`)

2. **Add `vite-plugin-pug`** — processes `.pug` files referenced in Angular `templateUrl`

3. **Add `@rollup/plugin-yaml`** — for `.yaml` files (locale files)

4. **SVG**: no plugin needed. All `svg-inline-loader` import sites will be updated to use Vite's `?raw` query (`import icon from './icon.svg?raw'`)

5. **PO gettext**: pre-convert all `.po` files to `.json` during the copy step using `gettext-parser`. No runtime loader needed.

6. **`resolve.alias`** — one entry per copied tabby-* package (see §2.2):
   ```typescript
   resolve: {
     alias: {
       'tabby-core':         path.resolve(__dirname, 'src/renderer/packages/tabby-core'),
       'tabby-settings':     path.resolve(__dirname, 'src/renderer/packages/tabby-settings'),
       'tabby-terminal':     path.resolve(__dirname, 'src/renderer/packages/tabby-terminal'),
       'tabby-local':        path.resolve(__dirname, 'src/renderer/packages/tabby-local'),
       'tabby-electron':     path.resolve(__dirname, 'src/renderer/packages/tabby-electron'),
       'tabby-ssh':          path.resolve(__dirname, 'src/renderer/packages/tabby-ssh'),
       'tabby-serial':       path.resolve(__dirname, 'src/renderer/packages/tabby-serial'),
       'tabby-telnet':       path.resolve(__dirname, 'src/renderer/packages/tabby-telnet'),
       'tabby-plugin-manager': path.resolve(__dirname, 'src/renderer/packages/tabby-plugin-manager'),
       'tabby-linkifier':    path.resolve(__dirname, 'src/renderer/packages/tabby-linkifier'),
       'tabby-community-color-schemes': path.resolve(__dirname, 'src/renderer/packages/tabby-community-color-schemes'),
     }
   }
   ```
   Each alias points to the package's `src/` directory (where `index.ts` lives).

**Main mode:** No changes needed beyond what the scaffold provides. The main process is pure TypeScript with `@mobrowser/api` imports.

---

### 2.2 Monorepo Package Layout

Each `tabby-*/src/` directory is copied into `mobrowser/src/renderer/packages/tabby-{name}/`.

```
mobrowser/
  src/
    renderer/
      packages/
        tabby-core/          ← copy of tabby-core/src/
        tabby-settings/      ← copy of tabby-settings/src/
        tabby-terminal/      ← copy of tabby-terminal/src/
        tabby-local/         ← copy of tabby-local/src/
        tabby-electron/      ← copy of tabby-electron/src/ (will become tabby-mobrowser)
        tabby-ssh/           ← copy of tabby-ssh/src/
        tabby-serial/        ← copy of tabby-serial/src/
        tabby-telnet/        ← copy of tabby-telnet/src/
        tabby-plugin-manager/
        tabby-linkifier/
        tabby-community-color-schemes/
```

**Why `src/renderer/packages/` and not a top-level `src/packages/`?**

The packages are Angular modules — they contain components, services, directives, pipes. They all run in the renderer. The few services in them that need Node.js access already have IPC-indirected implementations (from the prior hardening work). Placing them under `src/renderer/` makes the process boundary explicit in the file tree: if a file is under `src/renderer/`, it must be renderer-safe.

**Copying rules (per the migration strategy in AGENTS.md):**
- Files with no Electron/Node.js imports → copy as-is (`// Copied from: tabby-core/src/...`)
- Files that reference Electron-specific services or `window.tabbyAPI.*` → adapt to MoBrowser IPC equivalents (`// Derived from: tabby-core/src/...`)
- `tabby-electron/` entirely → becomes `tabby-mobrowser/`: the platform adapter package is rewritten to use `@mobrowser/api` instead of Electron

**npm dependencies:**  
Each tabby-* `package.json` lists its runtime dependencies. All unique dependencies across all packages are merged into `mobrowser/package.json`. Exact version constraints are preserved.

---

### 2.3 `tsconfig.json` Updates

The scaffold `tsconfig.json` needs:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "jsx": "preserve",
    "paths": {
      "tabby-core":           ["./src/renderer/packages/tabby-core/index.ts"],
      "tabby-core/*":         ["./src/renderer/packages/tabby-core/*"],
      "tabby-settings":       ["./src/renderer/packages/tabby-settings/index.ts"],
      "tabby-settings/*":     ["./src/renderer/packages/tabby-settings/*"],
      "tabby-terminal":       ["./src/renderer/packages/tabby-terminal/index.ts"],
      "tabby-terminal/*":     ["./src/renderer/packages/tabby-terminal/*"],
      ...
    }
  }
}
```

`experimentalDecorators` and `emitDecoratorMetadata` are required by Angular DI.  
`"jsx": "preserve"` (not `"react-jsx"` from the scaffold — Angular does not use JSX).

---

### 2.4 Plugin Loading

**Before:** `plugins.ts` has module-scope `require('tabby-core')` etc. (webpack statically bundles them), plus runtime filesystem scan.

**After:** Direct static imports in `src/renderer/index.ts`:

```typescript
import TabbyCoreModule from 'tabby-core'
import TabbySettingsModule from 'tabby-settings'
import TabbyTerminalModule from 'tabby-terminal'
import TabbyLocalModule from 'tabby-local'
// ... etc.

// Pass directly to Angular bootstrap
platformBrowserDynamic().bootstrapModule(
  getRootModule([TabbyCoreModule, TabbySettingsModule, ...])
)
```

No runtime discovery. No `window['pluginModules']`. No `require()` interception. Plugin list is determined at build time.

User plugins (third-party, installed at runtime) are **out of scope** for the initial migration.

---

### 2.5 Renderer Entry Point (`src/renderer/index.ts`)

Replaces `app/src/entry.ts`. Responsibilities:

1. Import Angular and all static plugins
2. Bootstrap Angular via `platformBrowserDynamic().bootstrapModule(...)`
3. **No** IPC call to receive bootstrap data — the data that `entry.ts` received from main via `ipc.once('start', ...)` (config, windowID, userPluginsPath, etc.) will instead be fetched via MoBrowser IPC services defined in `.proto` files

The renderer entry needs an `index.html` at `src/renderer/index.html` (Vite's root for the renderer build). This is the Angular app shell (`<app-root></app-root>`).

---

### 2.6 Main Process Entry Point (`src/main/index.ts`)

Replaces `app/lib/index.ts`. Responsibilities:

1. Import `@mobrowser/api` — `app`, `BrowserWindow`, etc.
2. Create the application window, load the renderer
3. Register all IPC service handlers (the migration from `app/lib/bridge.ts`)
4. Initialize PTY management, config loading, window management
5. **No** Electron API references anywhere

This is a net-new file — there is no "copy" from the parent. It is derived from `app/lib/index.ts` structurally, but fully rewritten to use `@mobrowser/api`.

---

### 2.7 New Package: `tabby-mobrowser` (replaces `tabby-electron`)

`tabby-electron` is the platform adapter — the Angular services that give the rest of the app access to OS capabilities (`ElectronService`, `ElectronPlatformService`, etc.). It is entirely Electron-specific.

In MoBrowser, this package becomes `tabby-mobrowser` (or lives at `src/renderer/packages/tabby-mobrowser/`). It:
- Implements the same Angular service interfaces as `tabby-electron`
- Calls MoBrowser IPC instead of `window.tabbyAPI.*` / `@electron/remote` / `ipcRenderer`
- Is the only package that knows about MoBrowser's IPC client

This is covered in detail in the IPC migration plan (next document).

---

### 2.8 Native Modules

The parent uses these native Node.js addon packages:
- `node-pty` — PTY spawning
- `keytar` — credential storage
- `fontmanager-redux` — font enumeration
- `native-process-working-directory` — working directory resolution
- `macos-native-processlist` — process listing (macOS)
- `@tabby-gang/windows-process-tree` — process tree (Windows)
- `glasstron` — window blur (Windows)
- `@serialport/bindings-cpp` — serial port (optional)

All of these run in the **main process** only. In MoBrowser:
- They are listed as `dependencies` in `mobrowser/package.json`
- They are imported directly in `src/main/` (no IPC layer needed to call them from main)
- They are exposed to the renderer via typed IPC services (covered in IPC plan)

No native C++ module (the MoBrowser `src/native/` C++ slot) is used at this stage. The existing Node.js addons are sufficient and already provide prebuilt binaries.

---

### 2.9 Summary: Files Needing New Vite Dependencies

```
mobrowser/package.json additions:
  @analogjs/vite-plugin-angular   — Angular compilation in Vite
  @angular/core@^15              — (+ all other @angular/* already in parent package.json)
  @rollup/plugin-yaml            — YAML loader
  vite-plugin-pug                — Pug template support
  gettext-parser                 — Used during copy step to convert .po → .json (devDep)
  zone.js                        — Required by Angular
  rxjs                           — Required by Angular
  [all tabby-* runtime deps]     — Merged from each tabby-*/package.json
```

---

### 2.10 What Does NOT Need to Change

- All `.scss` files — Vite handles SCSS natively (just needs `sass` package)
- All `.ts` files that contain pure Angular logic (components, services, pipes) with no Electron/Node.js imports — copy as-is
- All TypeScript type definitions — copy as-is
- `tabby-community-color-schemes`, `tabby-linkifier`, `tabby-auto-sudo-password` — likely copy as-is (pure Angular, no Electron dependency)
- `src/renderer/packages/tabby-ssh/` — mostly copy; SSH session code uses `russh` (a Node.js addon) from main process via IPC, already architecturally correct

---

## 3. Open Questions (to resolve before implementation)

1. **`@analogjs/vite-plugin-angular` version compatibility with Angular 15?** The parent uses Angular 15.2.x. AnalogJS follows Angular's release cadence. Need to confirm that the Vite plugin supports Angular 15 (or if we need to upgrade to Angular 16/17 which have first-class Vite support via `@angular/build`).

2. **Pug template handling in `@analogjs/vite-plugin-angular`**: Does the Angular Vite plugin support `templateUrl` pointing to `.pug` files, or does `vite-plugin-pug` need to intercept first? Need to test the pipeline order.

3. **`zone.js` in Vite**: Angular 15 requires `zone.js`. It must be imported at the top of the renderer entry point (before Angular bootstraps). Vite handles this via a direct import in `index.html` or `index.ts`.

4. **Build entry HTML**: Vite's renderer build requires an `index.html` as root. The parent uses `index.pug` compiled by webpack. We will create `src/renderer/index.html` as the Angular shell (minimal static HTML). This is a new file, not copied.
