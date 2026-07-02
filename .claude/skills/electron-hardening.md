---
name: electron-hardening
description: Use when asked to plan hardening an Electron app for sandbox safety or prepare it for MoBrowser migration. Produces a scoped, prioritized plan broken into discrete development tasks — does not implement changes directly.
---

# SKILL: Electron Hardening Plan Generator

## <ROLE>
You are an Expert Systems Architect specializing in sandboxed browser runtimes. Your objective is to **analyze the codebase and produce a structured, actionable hardening plan** broken into discrete tasks a developer can execute one at a time. Do not implement changes — only plan them.

## <PLANNING_PRINCIPLES>
- Each task must be independently mergeable (no task should depend on an unmerged sibling).
- Scope tasks to a single concern: one task per boundary violation category.
- Surface known gotchas as warnings inside the relevant task, not as a separate section.
- Order tasks so earlier ones reduce risk for later ones (build system first, then IPC, then leaf replacements).

## <HARDENING_CATEGORIES>
Use these as the lens for your audit. For each category, identify concrete violations in the codebase before writing tasks.

### 1. Build System
- Webpack target must be `web`, not `electron-renderer`
- Node built-ins must be stubbed in `resolve.fallback`
- `global = globalThis` shim must be injected before the Webpack runtime in `index.html`
- Renderer `tsconfig.json` must exclude `@types/node`

### 2. IPC Boundary
- No class instances, `Map`, or `Buffer` across IPC — plain JSON-safe DTOs only
- No synchronous IPC — replace with pub/sub or async generators
- No shared TS source files that mix process-specific globals

### 3. Native Addons
- No `.node` files in the renderer dependency graph, even behind platform guards

### 4. Browser-Native Replacements
- `Buffer` → `Uint8Array` + `TextDecoder` / `TextEncoder` / `btoa`
- `fs.readFile` for static assets → `fetch()` or bundler imports
- DOM globals (`window`, `location`) must not be evaluated at module top-level in shared files
- Node globals (`net`, `child_process`) must not be evaluated at module top-level in shared files

### 5. Test Environment
- `jsdom` does not mock `navigator.clipboard` — tests need an explicit host mock

## <OUTPUT_FORMAT>
Produce a plan with this structure:

```
## Hardening Plan

### Audit Summary
[2–4 sentences: what you found, overall risk level, recommended sequencing rationale]

### Tasks

#### Task 1: [Short title]
**Category:** [Build System | IPC Boundary | Native Addons | Browser-Native Replacements | Test Environment]
**Scope:** [Which files/modules are affected]
**What to do:** [Concrete steps, specific to the files found]
**Gotchas:** [Known pitfalls from the hardening knowledge base relevant to this task]

#### Task 2: ...
```

Do not include tasks for categories where no violations were found.
