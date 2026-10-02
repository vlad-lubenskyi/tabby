# MoBrowser Migration Status

**Last updated:** 2026-10-02

This is the current-state entry point. It distinguishes implemented architecture, verified behavior, unverified behavior, and known failures.

## Executive summary

The standalone MoBrowser application builds, launches, bootstraps Angular, renders localized and styled UI, and runs a local shell with working input/output. The migration is not feature-complete or clean-package-ready: several desktop integrations remain stubbed, SSH/Telnet/serial have not been exercised end to end, native packaging still relies on local workarounds, and closing a terminal can leave both UI state and the PTY process alive.

## Status matrix

| Area | State | Evidence | Remaining work |
|---|---|---|---|
| Standalone project | Implemented | Independent package/config/source tree under mobrowser | Keep clean-checkout isolation verified |
| MoBrowser toolchain | Working locally on 2.17 / Node 24 | Generation, dev launch, automation available | Remove disposable node_modules workarounds |
| Main and renderer build | Passing | Vite main and renderer outputs produced | Add repeatable clean-install/package verification |
| Browser-only renderer boundary | Partial | Most capabilities moved behind IPC or Web APIs | Remove the remaining stream/readline, Buffer, and Windows-registry renderer dependencies |
| Typed IPC | Implemented | Protobuf services and generated main/renderer bindings | Verify all service semantics and cleanup |
| Angular bootstrap | Verified | Configuration and locale initialization complete | Package-mode smoke test |
| Templates and component styles | Verified | Runtime UI and computed styles checked | Broaden view coverage |
| Global styles, fonts, icons | Verified | Source Sans/Code, logo, Font Awesome, layout checked | Package-mode asset check |
| Localization | Verified for English UI | Settings and welcome UI show translated strings | Exercise additional locales |
| Settings navigation/edit | Verified | Appearance view and reversible cursor setting | Cover persistence/restart |
| Local PTY create/input/output | Verified | OS-default shell prints expected marker | Test errors, resize, restart, and recovery |
| Local PTY close/cleanup | Failing | Tab leave remains stuck and shell survives | Diagnose Angular animation/lifecycle and main cleanup |
| SSH | Architecturally migrated; runtime unverified | Main-owned native session and renderer proxy compile | Connect/auth/shell/SFTP/forwarding/error/teardown tests |
| Telnet | Architecturally migrated; runtime unverified | Raw TCP moved behind streamed service | Connect/data/error/cancel/teardown tests |
| Serial | Architecturally migrated; runtime unverified | Web Serial implementation | Device tests and documented capability gaps |
| Dynamic user plugins | Not supported by initial port | Built-ins are statically imported | Design a trusted plugin host if parity is required |
| Desktop API parity | Partial | Core window/clipboard/path operations implemented | Resolve explicit stubs listed below |
| Native addon packaging | Works for local PTY workaround | node-pty helper is copied/signed to resources | Clean package, other architectures, upstream/tool-owned fixes |
| Automation | Available and useful | Snapshots, screenshots, console, eval | Avoid stale endpoints/refs; add stable scenario scripts |

## Verified scenarios

### Renderer bootstrap

- Application reaches config readiness and locale initialization.
- Root component, framework providers, and built-in plugin modules load.
- Missing first-run configuration is treated as empty.

### UI resources

- Angular Pug templates resolve to component HTML rather than index.html.
- Component styles are compiled and applied.
- Global layout, fonts, icons, logo, and SVG markup render correctly.
- Translation directives produce English text rather than literal keys.

### Settings

- Settings opens and navigates to Appearance.
- Appearance controls, preview, inputs, and toggles are styled.
- Blink cursor can be toggled off and restored without errors.

### Local terminal

- An OS-default shell starts through node-pty.
- Terminal input reaches the shell.
- Output renders in xterm.
- Resize logging occurs.

Artifacts: [settings](../../mobrowser/.mobrowser/scenario-settings-appearance.png), [terminal](../../mobrowser/.mobrowser/scenario-new-tab.png), and [happy path](../../mobrowser/.mobrowser/happy-path-terminal.png).

## Known failures

### Renderer still contains Node/runtime leaks

A fresh audit found remaining browser-boundary violations in the copied MoBrowser renderer:

- terminal stream processing lazily requires Node stream and readline;
- the SSH shell still calls Buffer.from and exposes Buffer in a method type;
- the SSH private-key importer still exposes Buffer in its type contract;
- Windows shell/environment providers dynamically require windows-native-registry.

These paths were not exercised by the verified macOS local-shell happy path. Asset require calls are handled separately by the Vite asset transform and are not equivalent to runtime Node requires.

Required proof for completion:

1. source and dependency scan shows no executable Node/native renderer imports;
2. renderer TypeScript rejects Buffer/process/require outside declared asset transforms;
3. terminal input-processing modes and SSH shell paths run without Node globals;
4. Windows profile/environment discovery uses main-process RPC or an explicitly supported browser mechanism.

### Active terminal close does not settle

The renderer logs session destruction and the Web Animation reaches finished, but the tab header remains in Angular's ng-animating state, two headers remain active, and the shell process survives.

Required proof for a fix:

1. closing header leaves the DOM;
2. fallback tab becomes the sole active tab;
3. renderer stream subscription completes;
4. main-process PTY map entry disappears;
5. child shell process exits.

Artifact: [failed close](../../mobrowser/.mobrowser/scenario-tab-close-stuck.png).

### Clean dependency/package flow is not reproducible yet

Local workarounds have been needed for hoisted CLI dependencies, N-API metadata/native detection, architecture filtering, and a native wrapper's peer dependency. Manual edits below node_modules are lost on reinstall.

Required proof for a fix:

1. fresh checkout;
2. documented Node version;
3. clean dependency install;
4. code generation;
5. main and renderer production builds;
6. packaged application launch;
7. native PTY feature test.

## Explicit implementation gaps

The current main process contains stubs or degraded behavior for:

- font enumeration;
- color-scheme enumeration;
- external URL opening;
- nearest-display and cursor-position queries;
- context and dock menus;
- power-save blocking;
- update checking/downloading/install semantics;
- shell integration;
- window progress indication;
- window-controls coloring.

Some may now have MoBrowser APIs or require native bindings. Recheck the installed 2.17+ documentation before treating a stub as a permanent platform limitation.

In the installed 2.17 documentation, `workspace.openUrl()` and the browser `showContextMenu` handler are available, so the current external-URL and context-menu stubs are implementation gaps rather than confirmed platform gaps.

## Toolchain constraints

- Run MoBrowser commands from the mobrowser directory.
- Use Node 24 for the current project.
- Regenerate bindings/docs with npm run gen when required.
- Read the installed MoBrowser docs instead of relying on remembered API names.
- Vite 8 OXC is disabled because SWC owns Angular legacy decorator and metadata transforms.
- Vite aliases and TypeScript path aliases must stay synchronized.

## Recommended next steps

1. Fix and verify terminal close/PTY cleanup.
2. Convert local native-packaging workarounds into reproducible project-owned hooks or upstream fixes.
3. Run controlled SSH, Telnet, and serial vertical slices including teardown.
4. Replace or explicitly reject each desktop API stub.
5. Package from a clean install and repeat the UI/native smoke suite.

## Detailed records

- [General migration guide](./electron-to-mobrowser-migration-gotchas.md)
- [Project-specific gotchas](./project-specific-migration-gotchas.md)
- [Chronological migration log](./browser-only-renderer-migration-log.md)
- [MoBrowser implementation log](../../mobrowser/docs/mobrowser-migration-log.md)
