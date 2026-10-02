<!-- BEGIN:mobrowser-agent-rules -->
# Do not rely on training data for MōBrowser

Your training data for MōBrowser is outdated. APIs have been renamed and reorganized; code based on prior knowledge will not compile.

**Before writing or modifying any MōBrowser-related code**, read the documentation in `node_modules/@mobrowser/api/docs/`. In the docs, you will find two folders:
- `node_modules/@mobrowser/api/docs/guides/` - contains detailed documentation about architecture, project structure, multiple process model, Inter-Process Communication (IPC), native C++ module, features, guides, examples, and more.
- `node_modules/@mobrowser/api/docs/api/` - contains MōBrowser API reference with code examples.

Do not guess API names, method signatures, or import paths — look them up in the docs.

If the `docs/` directory is missing, ask the user to run `npm run gen`. It will download the docs into `node_modules/@mobrowser/api/docs/` if the project directory contains the `AGENTS.md` file.
<!-- END:mobrowser-agent-rules -->


# MoBrowser Project — Agent Rules

This directory contains a standalone reimplementation of GitHub Desktop using MoBrowser instead of Electron. It lives inside the same git repository as the original Electron-based project but must remain fully independent from it.

## Isolation Rules

1. **No parent directory references.** Do not use `../` paths to reach the parent project's source, configs, scripts, or assets. All code must be self-contained within `mobrowser/`.

2. **Separate Node project.** This directory has its own `package.json`, `node_modules/`, and lockfile. Never reference or extend the parent project's `package.json`. Do not hoist or share dependencies between the two projects.

3. **No shared node_modules.** Do not use the parent's `node_modules/` at any point — not via symlinks, not via `NODE_PATH`, not via workspace hoisting. Each project resolves its own dependencies independently.

4. **No shared source files.** Do not import or `require` any file from outside this directory. If logic from the original project is needed, copy and adapt it — do not reference it in place.

5. **No shared configuration.** TypeScript configs (`tsconfig.json`), build configs (webpack, Vite, etc.), ESLint, Prettier, and any other tooling configs must be defined locally within `mobrowser/`. Do not extend configs from the parent directory.

6. **No shared scripts or tooling.** Build, test, and dev scripts must be invocable from within `mobrowser/` (e.g. `cd mobrowser && npm run build`) without depending on anything outside.

7. **Same git, separate project.** Both projects share a single git repository and history. This is intentional and the only permitted coupling. `.gitignore` entries from the parent apply to the whole repo, so `mobrowser/node_modules` must be covered either by the root `.gitignore` or a local `mobrowser/.gitignore`.

8. **Copied or derived files must reference their origin.** The majority of source files in `mobrowser/` are copies of (or derived from) files in the parent project, adapted for MoBrowser. Every such file must begin with a comment identifying the original:

   ```ts
   // Derived from: app/src/path/to/original-file.ts
   ```

   Use `// Derived from:` for files that have been modified, and `// Copied from:` for files that are unchanged or nearly verbatim. This makes it straightforward to diff against the parent, track upstream changes, and understand what has been migrated vs. written from scratch.

## Work Log

All agents working in this directory must maintain a live implementation journal at `docs/mobrowser-migration-log.md`.

- Add an entry **immediately** when you discover a decision, gotcha, architectural constraint, rejected approach, or compatibility issue — do not batch entries at the end of a task.
- Each entry must include: the date, the affected area, the observation or decision, and its consequence or required follow-up.
- Keep entries focused on information a later implementer would not reliably infer from the final code or commit diff.
- Format entries consistently with the example below:

```
## YYYY-MM-DD - <short topic>

- **Area:** <subsystem or file>
  **Decision/Observation:** <what was decided or discovered>
  **Consequence:** <what this means for future work>
```

Create the file if it does not exist.

## Migration Strategy

The migration approach is **copy-first, modify-minimally**:

- **Copy as-is** any file from the parent project that does not reference Electron APIs, Node.js built-ins unavailable in MoBrowser, or parent-specific paths. These files land in `mobrowser/` verbatim (with a `// Copied from:` header).
- **Modify to the necessary extent** any file that must change to work under MoBrowser — replacing Electron APIs with MoBrowser equivalents, adjusting import paths, adapting IPC patterns, etc. Change only what is required; do not refactor or improve beyond the migration need. These files get a `// Derived from:` header.
- **Write from scratch** only files that have no parent equivalent (MoBrowser entry points, native module bindings, generated code).

The bar for "copy as-is" is high: if a file compiles and runs correctly under MoBrowser without any edits, copy it. Only modify when the compiler or runtime forces a change.

## Intent

The goal is a clean-room MoBrowser implementation that can be developed, built, and run entirely in isolation. A developer should be able to work on `mobrowser/` without needing to install or understand the parent Electron project, and vice versa. In the end, `mobrowser/` should be a fully self-contained copy of the parent project with only the changes necessary to replace Electron with MoBrowser.
