# Claude Code Rules for Tabby

## MANDATORY: Activity Log and Gotcha Registry

**This rule applies to every agent session and cannot be skipped.**

### Activity Log

Every agent that performs work in this repo must append an entry to `.claude/activity-log.md` at the end of the session. Use this format:

```markdown
## YYYY-MM-DD — <short task description>

- **Files changed:** list each file path that was read, created, or modified
- **What was done:** 2–4 bullet points summarising the actual changes made
- **Outcome:** `completed` | `partial` | `blocked` — plus one sentence explaining why if not completed
```

### Gotcha Registry

Any time an agent discovers a non-obvious risk, pitfall, or constraint that is **not self-evident from reading the code**, it must append it to `.claude/gotchas.md` before finishing the session. Use this format:

```markdown
## <Short title>

**Discovered:** YYYY-MM-DD
**File(s):** path/to/file:line
**Description:** What the gotcha is and why it matters.
**How to avoid:** Concrete action a future agent or developer should take.
```

Do not duplicate existing entries — scan `.claude/gotchas.md` before appending.

### Enforcement

- Agents must write both files **before** reporting task completion to the user.
- If an agent is interrupted or produces a partial result, it must still write whatever it knows to both files.
- Entries are append-only — never delete or edit existing entries, only add new ones.

## Subproject: MoBrowser

The `mobrowser/` directory is an independent subproject with its own rules. Agents working within that directory must read and follow [`mobrowser/AGENTS.md`](mobrowser/AGENTS.md) in addition to this file.

## Browser-only renderer migration journal

All agents working in this repository must update
`docs/technical/browser-only-renderer-migration-log.md` as the work progresses.

- Record conceptual or architectural changes, newly discovered coupling,
  compatibility constraints, rejected approaches, and implementation gotchas
  immediately when they are discovered or decided.
- Do not defer or batch these notes until the task or migration is finished.
- Include the date, affected area, the observation or decision, and its
  consequence or required follow-up.
- Keep the journal focused on information that a later implementer would not
  reliably infer from the final code or commit diff.

## Canonical technical documentation

Engineer-facing documentation is organized under [`docs/technical/index.md`](docs/technical/index.md).
The `.claude` activity and gotcha files are append-only operational inputs; extract durable guidance
into the indexed technical documents rather than treating the raw agent logs as the canonical manual.
