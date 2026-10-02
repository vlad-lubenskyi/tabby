# Technical Documentation

This index is the canonical entry point for the Electron hardening and MoBrowser migration work.

## Recommended reading order

### 1. Start with the current state

[MoBrowser Migration Status](./mobrowser-migration-status.md)

Read this first to learn what works, what is only implemented structurally, what remains stubbed, and which known failure currently blocks reliable teardown.

### 2. Understand the prerequisite security boundary

[Electron Renderer Hardening](./electron-renderer-hardening.md)

This explains how the Electron renderer was converted from a Node-capable environment into a browser-like, context-isolated renderer. It covers preload design, IPC, native addons, Web Crypto, Uint8Array, and type-graph enforcement.

Read it before the MoBrowser guide if the source application still has nodeIntegration, @electron/remote in renderer code, synchronous IPC, or native addons in renderer packages.

### 3. Read the reusable migration guide

[Electron to MoBrowser Migration Gotchas](./electron-to-mobrowser-migration-gotchas.md)

This is the main engineering guide. It covers:

- target process architecture;
- renderer/main capability placement;
- Protobuf unary and streaming RPC;
- asynchronous bootstrap;
- serialization and resource ownership;
- Webpack versus Vite/Rolldown;
- framework resources and localization;
- native addon packaging;
- desktop API parity;
- vertical-slice testing and teardown.

### 4. Use the detailed design plans when implementing

- [IPC Migration Plan](../../mobrowser/docs/plan-ipc-migration.md) — complete Electron-channel-to-Protobuf service mapping, stream choices, bootstrap flow, and service organization.
- [Build-System Migration Plan](../../mobrowser/docs/plan-build-system.md) — Webpack/Vite comparison, source/package layout, framework transforms, dependencies, and native module placement.

These plans are detailed implementation references. Where an early plan conflicts with the current status or code, the current code and status document win.

### 5. Consult project-specific traps while debugging

[Project-Specific Migration Gotchas](./project-specific-migration-gotchas.md)

This captures details that matter to this repository but are not universal guidance: Angular/Pug transforms, generated SSH types, PTY contracts, xterm internals, node-pty sidecars, resource-map leaks, and current desktop-service stubs.

### 6. Use the logs for chronology and evidence

- [Browser-Only Renderer Migration Log](./browser-only-renderer-migration-log.md) — architectural decisions and discoveries in chronological order.
- [MoBrowser Migration Log](../../mobrowser/docs/mobrowser-migration-log.md) — implementation journal maintained by the standalone subproject.

Read logs to understand why a decision was made or when a regression appeared. Do not use them as the primary setup or status guide.

## Navigation by task

| Task | Read |
|---|---|
| Assess whether an Electron app is ready for MoBrowser | [Electron Renderer Hardening](./electron-renderer-hardening.md), then the target architecture in the [migration guide](./electron-to-mobrowser-migration-gotchas.md) |
| Plan IPC migration | [Migration guide sections 2–6](./electron-to-mobrowser-migration-gotchas.md), then [IPC Migration Plan](../../mobrowser/docs/plan-ipc-migration.md) |
| Port Webpack to Vite | [Migration guide sections 7–10](./electron-to-mobrowser-migration-gotchas.md), then [Build-System Migration Plan](../../mobrowser/docs/plan-build-system.md) |
| Package a native addon | [Migration guide section 10](./electron-to-mobrowser-migration-gotchas.md) and [project-specific native packaging notes](./project-specific-migration-gotchas.md) |
| Diagnose styles or localization | [Migration guide section 9](./electron-to-mobrowser-migration-gotchas.md) and [Angular resource gotchas](./project-specific-migration-gotchas.md) |
| Continue implementation | [Current status](./mobrowser-migration-status.md), then the relevant project-specific section |
| Verify feature parity | [Current status](./mobrowser-migration-status.md) and the validation matrix in the [migration guide](./electron-to-mobrowser-migration-gotchas.md) |
| Investigate historical decisions | [Technical migration log](./browser-only-renderer-migration-log.md) and [subproject migration log](../../mobrowser/docs/mobrowser-migration-log.md) |

## Document roles and precedence

1. **Current code and installed MoBrowser documentation** define actual API behavior.
2. **MoBrowser Migration Status** defines the current verified state.
3. **Electron to MoBrowser Migration Gotchas** is the maintained reusable guidance.
4. **Project-Specific Migration Gotchas** defines repository-specific constraints.
5. **Design plans** explain intended mappings and may contain pre-implementation assumptions.
6. **Migration logs** are historical evidence and are not rewritten when later discoveries supersede an entry.

## What remains in .claude

The append-only activity log and gotcha registry remain in .claude because repository automation requires agents to update them. They are raw operational inputs, not the canonical engineer-facing documentation.

Repository-local skill files and settings also remain there because they configure automation. Their verified technical content has been incorporated into the documents above; the skill prompts themselves should not be treated as authoritative product documentation.

The old .claude hardening plan was moved into the maintained [Electron Renderer Hardening](./electron-renderer-hardening.md) document.

## Extraction map

| Original `.claude` material | Canonical destination |
|---|---|
| `hardening-plan.md` | Moved and updated as [Electron Renderer Hardening](./electron-renderer-hardening.md) |
| Hardening entries in `gotchas.md` | [Electron Renderer Hardening](./electron-renderer-hardening.md) |
| General MoBrowser IPC/build/runtime entries in `gotchas.md` | [Electron to MoBrowser Migration Gotchas](./electron-to-mobrowser-migration-gotchas.md) and the two detailed design plans |
| Application-specific entries in `gotchas.md` | [Project-Specific Migration Gotchas](./project-specific-migration-gotchas.md) |
| Outcomes and milestones in `activity-log.md` | [MoBrowser Migration Status](./mobrowser-migration-status.md) and [Browser-Only Renderer Migration Log](./browser-only-renderer-migration-log.md) |
| Technical claims embedded in repository-local skill prompts | Reviewed against the implementation/docs and incorporated where verified; prompts remain automation configuration |
| `settings*.json` | Not documentation; remains tool configuration |

## Maintenance rules

- Update [MoBrowser Migration Status](./mobrowser-migration-status.md) when verification state changes.
- Put reusable lessons in [Electron to MoBrowser Migration Gotchas](./electron-to-mobrowser-migration-gotchas.md).
- Put application-specific constraints in [Project-Specific Migration Gotchas](./project-specific-migration-gotchas.md).
- Append architectural decisions to [Browser-Only Renderer Migration Log](./browser-only-renderer-migration-log.md).
- Keep version-specific claims labeled with the MoBrowser, Node, framework, OS, and architecture versions that produced them.
- Prefer direct links to implementation and test artifacts over duplicating long code listings.
