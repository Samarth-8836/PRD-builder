# PRD-Builder Engineering Manual

This manual is the ground-truth reference for how PRD-Builder is built and
why. Every chapter is a self-contained module — read the chapter for the
subsystem you're touching; cross-link via the index when you need
context. The intent is that a fresh engineer can rebuild the app from
this doc plus the source code, with no other context.

The chapter numbers are stable. When you edit a section, update the
"Last touched" line at the top of that chapter's `.md` so other readers
know it might have drifted from the code.

---

## How to use this manual

- **Index entries map chapter:section → file path** so you can jump from
  "I need to change how cascades preview" to chapter 06 §6.5 to
  `src/lib/session-manager/manager.ts` and `src/lib/pipeline/engine.ts`
  without grepping.
- **Code paths are absolute from the repo root.** When a chapter says
  `src/lib/...`, the reader should be able to open that file directly.
- **Decisions and rationale are inline.** Why something is the way it is
  matters as much as what it does — when in doubt, state the why.
- **Don't duplicate code into the doc.** Reference symbols (functions,
  types) by name and let the source be authoritative for syntax. The
  doc explains the model; the code is the reality.

---

## Chapter index

| # | Chapter | What it covers |
|---|---|---|
| [01](01-system-overview.md) | System overview | What the app is, user-facing flow, tech stack, repo layout |
| [02](02-pipeline-framework.md) | Pipeline framework | `PipelineConfig`, the engine, runners, slots, lifecycle, registry |
| [03](03-storage-and-state.md) | Storage & state | `Session` shape, slot-keyed storage, snapshots, changelog, summarization windows |
| [04](04-operations-and-llm.md) | Operations & LLM | `execute`, provider abstraction, model roles, op catalog |
| [05](05-prompts-and-parsers.md) | Prompts & parsers | Prompt registry, `PromptSpec`, parser conventions, `ParseResult` |
| [06](06-session-manager.md) | Session manager | Top-level coordinator, state routing, dispatch by pipeline, cascades, rollback, restore |
| [07](07-api-and-sse.md) | API & SSE | Route catalog, SSE event vocabulary, request/response shapes |
| [08](08-client-ui.md) | Client UI | Zustand stores, `useSSE` hooks, components inventory, tab-follows-lifecycle |
| [09](09-pipelines-implementations.md) | Pipeline implementations | PRD-builder pipeline + Research-report pipeline, per-pipeline ops |
| [10](10-cross-cutting-concerns.md) | Cross-cutting concerns | Drift, change log, diff summaries, regen context, version bumping, summarization |
| [11](11-adding-a-new-pipeline.md) | Adding a new pipeline | Step-by-step playbook, genericity guard rail, common pitfalls |
| [12](12-configuration-and-testing.md) | Configuration & testing | Env vars, LLM setup, dev workflow, unit tests, manual tests |

---

## Quick lookup table

If you're touching... | Start at...
---|---
A new domain artifact (slot) | 02 §2.3, 09 §9.1.2 (PRD slot example)
A new pipeline step | 02 §2.4, 11 §11.2
A new prompt | 05 §5.1, 05 §5.2
A new pipeline (whole new domain) | 11 (full chapter)
The cascade behavior | 02 §2.6, 06 §6.5, 10 §10.4
Drift checking | 04 §4.5, 06 §6.4, 10 §10.3
The chat / review classifier | 04 §4.4, 06 §6.4, 10 §10.6
The pipeline picker UI | 08 §8.4, 11 §11.5
Storage shape (anything `Session.*`) | 03 §3.1, 03 §3.2
SSE wire format | 07 §7.2
A UI component | 08 §8.3
Switching LLM model per role | 04 §4.2, 12 §12.1
The export ZIP | 07 §7.1.7
The wireframe iframe (PRD-only) | 07 §7.1.8, 08 §8.3.5
Adding a new state to the lifecycle | 02 §2.5, 06 §6.2

---

## Glossary

- **Pipeline** — A declarative description of a multi-step artifact
  flow (PRD-builder, research-report, etc.). Lives in
  `src/lib/pipeline/configs/<id>.ts`.
- **Step** — One unit of LLM work in a pipeline (e.g., PRD's `workflow`
  step, research-report's `outline` step). Has dependencies, produces
  one or more slots, has a runner and a gate.
- **Slot** — A typed payload bucket on a session (markdown / fileset /
  json), keyed by a stable id. Slots are the engine's I/O.
- **Phase** — A UI-only grouping of steps. Two phases for PRD
  ("Design", "Wireframe") plus the standalone Phase 1; three for
  research-report ("Brief", "Draft", "Finalize").
- **Lifecycle state** — Tagged union covering the session's current
  position: `phase1` / `phase1_complete` / `running:<stepId>` /
  `review:<stepId>` / `complete`.
- **First-impact step** — The earliest step in topological order whose
  output is affected by a user-described change. Drives cascade scope.
- **Cascade** — Re-running a step plus its transitive dependents to
  apply a confirmed user change. Has a preview/confirm gate (M12.1).
- **Drift anchor** — The locked artifact every change is checked
  against (PRD's contract, research-report's brief).
- **Regen context** — Cache of prior slot payloads moved aside when a
  cascade is about to overwrite them, so step prompts can preserve
  user customizations across regenerations (M12.1.5).
- **ChangeLog** — Append-only record of confirmed cascades on a
  session. Surfaced to step prompts as `<change_history>`. Subject to
  sliding-window summarization.
- **Diff summary** — 1-2 sentence post-hoc summary of how one slot
  changed across one cascade. Generated fire-and-forget (M12.3).
- **Pipeline version** — Monotonic counter bumped each time a session
  re-locks via iteration-on-complete (M12.2).
- **Branded id** — Compile-time-only nominal type around `string`
  (`StepId`, `PhaseId`, `DocSlotId`) that prevents mixing up id kinds.
