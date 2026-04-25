# UX Builder — What We're Building (and Why)

## The 30-second pitch

A web app that helps you turn one sentence — *"I want to build a todo app"* — into something you can click through in a browser, before writing a line of real code.

Not a code generator. Not a no-code platform. A **product-definition tool** that argues with you about what you're actually trying to build, then renders it as a static HTML prototype so the conversation can move from words to screens.

For this iteration we're shipping the front half of the journey:

```
Idea  →  Project Contract  →  Workflows  →  Screens  →  Clickable Wireframe
                                                              │
                                                              ▼
                          (Test suite + automation come in the next iteration)
```

By the end of this doc you'll know:
- What the user actually does, step by step
- What artifacts they produce and what each one looks like
- How the system handles real-world messiness (questions vs. change requests, scope drift, mid-stream feedback)

We'll use a single example throughout: **building a todo app**. We'll cover the happy path and four kinds of detour.

---

## The four artifacts

Each step produces a thing the user can read, share, and (eventually) click. Each one is a separate file, persisted, versioned, and reviewable on its own.

### 1. Project Contract — the "what"
Markdown. Four fixed sections:
- **Goal Statement** — one paragraph, what the product does and the problem it solves
- **Personas** — the people who use it, what they do
- **Entity Map** — the things the product knows about (Task, User, Tag, …)
- **Boundaries** — explicit *we are NOT building this*

This is the constitution for everything that follows. It's locked once Phase 1 ends — every later change is checked against it.

### 2. Workflow Map — the "how"
Markdown. One section per workflow. A workflow is one persona doing one thing end-to-end (e.g. *"Individual User creates a task"*). Each workflow lists pre-conditions, steps, exit criteria, edge cases.

### 3. Screen Inventory — the "where"
Markdown. One section per screen. Each screen lists its purpose, what it shows, and which other screens you can navigate to from it. The collection of screens forms a navigable graph.

### 4. Wireframe — the "let me click it"
A folder of static HTML files: `index.html` (a shell with navigation), one `<screen-id>.html` per screen, a `data.js` with realistic dummy content. Loads in a sandboxed iframe in the app. Crude visually, but you can click between screens, see realistic content, and tell whether the structure feels right.

---

## The user journey (with todo app)

We'll walk through every step. At each step you'll see what the user types, what the system does, and what shows up on screen. After the happy path we revisit the spots where things branch.

---

### Step 1 — Open the app, type a sentence

The user opens `http://localhost:3000`. Empty sidebar, empty document panel. They type into the chat:

> *I want to build a simple todo app*

…and hit Enter.

**What happens behind the scenes:**

- A session is created. It gets a UUID and a placeholder title.
- Two LLM calls fire in parallel:
  - A *title* call — short, returns "Personal Task Tracker" or similar; updates the session title in the sidebar
  - A *goal expansion* call — the long one. The model takes the user's sentence and produces a complete first draft of the contract (filling gaps with its best judgment)

**What the user sees:**

- The user's message appears as a blue bubble on the right
- A new session "Personal Task Tracker" appears in the sidebar
- The assistant streams a one-sentence reply: *"Drafted a contract for a personal task tracker."*
- The right panel populates with a Project Contract:

```
## Goal Statement
A lightweight personal task management app that helps individuals
capture, organize, and track tasks across their day.

## Personas
**Individual User** — A single person managing their own to-do list.
Interaction type: Creates, edits, completes tasks; organizes them
into lists; sets due dates and reminders.

## Entity Map
**Task** — A single actionable item with title, optional description,
due date, status. Individual User creates, edits, marks complete.
**List** — A grouping of related tasks (e.g. "Work", "Home").
Individual User creates, renames, archives, reorders.

## Boundaries
- No team / multi-user features
- No calendar integration (Google Calendar, Outlook)
- No advanced project management (Gantt charts, dependencies)
- No time tracking or billing
```

A `v1` badge sits in the corner of the document panel.

> **Why is the system being so opinionated?** Because indecision early kills momentum. The model fills in obvious gaps so the user has something concrete to react to. It's much easier to say "no, take that out" than to start from a blank page.

---

### Step 2 — The user asks a question

The user is curious about the model's choices. They type:

> *Why didn't you include reminders as a separate entity?*

**What happens:**

The system runs a Phase 1 conversation call. The prompt is structured so the model picks one of three response modes:

1. **First-message mode** — emit a complete contract (Step 1)
2. **Edit mode** — emit an updated contract surgically preserving everything else
3. **Question / chat mode** — answer in plain prose, **don't touch the contract**

A question triggers Mode 3.

**What the user sees:**

- An assistant message: *"I treated reminders as a property of a Task (a `due date` field plus a notification preference) rather than a standalone entity, since each reminder belongs to exactly one task. If you'd like reminders to have their own lifecycle — independent rules, recurrence, etc. — I can promote them to a separate Entity."*
- The document panel does **not** change. Still `v1`.

This is critical. A question is not a change request. The model has to know the difference.

---

### Step 3 — The user requests a small change

> *Add tags so I can categorize tasks across lists*

**What happens:**

This is Mode 2 — a targeted edit. The prompt tells the model: preserve every existing persona, entity, and boundary verbatim; touch only what the user asked about; cross-update related fields (here, the Task entity gets a `tags` field and the Individual User gains an interaction with the new Tag entity).

**What the user sees:**

- Assistant message: *"Added a Tag entity."*
- Document panel: `v2` badge. Diff (mental): Goal unchanged, Individual User unchanged but with one new line about tagging tasks, Task entity unchanged but with `+ tags` mention, **new Tag entity** appears, Boundaries unchanged.

> **Why does the diff matter?** Because if the model rewrites the entire contract every turn, the user can't trust that earlier decisions are still in force. Surgical edits are how trust accumulates.

---

### Step 4 — The user requests something out of scope

> *Add team collaboration so my coworkers can share lists with me*

This conflicts with the boundary *"No team / multi-user features"*. Two possible outcomes:

**Outcome A** — The model honors the boundary and pushes back:

> *That conflicts with the boundary "No team / multi-user features." Want me to remove the boundary and add team support, or keep the app personal-only?*

No contract update. User decides.

**Outcome B** — The model overrides the boundary and emits an updated contract with a Team Member persona. (This is technically wrong; the prompt tries to prevent it.)

If (B) happens, the user sees the change immediately in the document panel and can say *"Undo that, I want to keep it personal-only"* — Mode 2 reverts.

> The system tries to make (A) the default. Real-world testing will tell us how often (B) leaks through; the prompt is the lever.

---

### Step 5 — Click "Done — Validate & Complete Phase 1"

The user is satisfied. They click the green Done button.

**What happens:**

A separate validation LLM call runs — different prompt, different model role. It checks the contract against an internal checklist:

- Every section populated?
- Every persona referenced by at least one entity interaction?
- Goal vs. boundaries internally consistent (no contradictions)?
- Personas distinct from each other (no near-duplicates)?

Returns either `STATUS: PASS` or `STATUS: FAIL` with a list of issues and suggestions.

**Two paths:**

**Path A — FAIL.** The chat shows an amber system message:

> ```
> STATUS: FAIL
>
> Issues:
> - Tag entity has no defined interaction with Individual User
> - Goal mentions reminders but no entity covers them
>
> Suggestions:
> - Add an "Individual User can create and apply Tag" interaction
> - Either drop reminders from the goal or promote them to an entity
> ```

The Done button is re-enabled. Phase indicator stays on Phase 1. The user can fix the issues with more chat messages and click Done again.

**Path B — PASS.** The phase indicator's Phase 1 chip flips to green ✓. **Without any further user action,** the system automatically starts Phase 2 Stage 1.

> **Why no extra click?** Because waiting for the user to click "next" twice is just friction. Phase 1 PASS is consent.

---

### Step 6 — Phase 2 Stage 1: Design (Workflow Map + Screen Inventory)

The phase indicator now shows a row of sub-stage chips:

```
Phase 1 ✓   →   Phase 2:  [Design ●pulsing]  ›  Wireframe  ›  Test Suite  ›  Automation
```

The Design chip pulses blue while it's running. This stage runs ~7 LLM calls in a small DAG:

1. **Workflow discovery** — given the contract, list every workflow
2. **Workflow detail** (batched, one call per workflow) — flesh each one out
3. **Workflow Map formatting** — render the markdown document
4. **Screen extraction** — given the workflow map, derive the screens needed
5. **Navigation validation** — does the screen graph cover every workflow?
6. **(Conditional) Screen correction** — only runs if (5) found gaps
7. **Screen Inventory formatting** — render the markdown document

System messages appear in the chat as each step completes (*"Workflow Map generated"* etc.). When the stage finishes, the phase indicator shows:

```
Phase 1 ✓   →   Design [amber·review]  ›  Wireframe  ›  Test Suite  ›  Automation
```

…and a banner appears between the chat and the input:

> **Design stage complete**
> Review the Workflow Map and Screen Inventory in the document panel.
> When ready, continue to the next stage — or type feedback in the chat and we'll revise.
>
> [ **Approve → Generate Wireframe** ]

The document panel now has two new tabs (**Workflow Map**, **Screen Inventory**) plus the original Project Contract.

For our todo app, the Workflow Map might list:

- *Capture a task* — Individual User opens the app, taps "+", types a title, optionally sets due date and tags, saves
- *Browse tasks* — Individual User opens the list view, filters by tag or due date, scrolls
- *Mark a task complete* — Individual User taps the checkbox, task moves to a "done" state
- *Edit a task* — Individual User taps a task, modifies fields, saves
- *Manage lists* — Individual User creates, renames, deletes lists
- *Manage tags* — Individual User creates, deletes, recolors tags
- *Archive completed tasks* — Individual User triggers a cleanup action

…and the Screen Inventory might show:

- `home` — Today view, tasks due today
- `list-detail` — All tasks in a chosen list
- `task-create` — Modal/screen for entering a new task
- `task-detail` — View / edit one task
- `tag-manager` — Manage tags
- `settings` — Preferences

Each screen entry has a `nav:` field listing where the user can go from there.

---

### Step 7 — User feedback during the Design review

This is the most interesting step because it has multiple branches. The user has the Approve button right there, but they don't have to click it. They can chat instead.

#### 7a — Approve as-is

User clicks **Approve → Generate Wireframe**. Stage 2 starts. (Skip to Step 8.)

#### 7b — Small change to a workflow

User types:

> *Add an "undo last action" workflow*

The system runs a *Phase 2 conversational* call. The model produces a visible response *plus* a hidden `<change_context>` block describing the requested change:

```
scope: workflow_change
description: Add an undo workflow for the most recent action
```

The system then runs a **drift check** — a separate LLM call that compares the requested change against the locked Project Contract:

- **COMPATIBLE** — the change fits the existing personas/entities/boundaries
- **FLAG** — the change is borderline; user should know
- **DRIFT** — the change requires modifying the contract; must rollback first

For "add undo", the result is COMPATIBLE. The cascade then runs the relevant updates:

- Workflow Map: a new "Undo last action" workflow is appended
- Screen Inventory: re-checked — does it need a new screen for the undo affordance? Probably not (a button on existing screens), so the inventory is unchanged
- Project Contract: untouched (the change didn't introduce new personas/entities/boundaries)

The Approve button remains available; the user can review the updated docs and approve, or iterate further.

#### 7c — Change that affects screens

User types:

> *I want a separate "Today" view that's different from the list views*

`change_context.scope` is `screen_only` here. The system updates the Screen Inventory to add a `today` screen distinct from `home`, updates the navigation graph, and re-renders the Screen Inventory document. Workflow Map is unchanged. Project Contract is unchanged.

#### 7d — User asks for something that drifts

User types:

> *Add support for sharing tasks with my partner*

This conflicts with the contract boundary "No team / multi-user features." The drift check returns:

```
classification: DRIFT
type: NEW_PERSONA
reason: Sharing requires a second user role, which contradicts the
        "No team / multi-user features" boundary in the Project Contract.
```

The chat shows a **red banner**:

> ⛔ **Change Blocked — Contract Drift**
> Sharing requires a second user role, which contradicts the "No team / multi-user features" boundary in the Project Contract.
>
> [ **Go back to Phase 1** ]

The chat input is locked. The only action available is to roll back to Phase 1, edit the contract (e.g. add a Partner persona, remove the boundary), then re-enter Phase 2.

This is by design. We don't want the model to silently broaden scope — that's how products end up sprawling.

#### 7e — Borderline change (FLAG)

User types:

> *Should tasks support sub-tasks?*

The drift check returns:

```
classification: FLAG
type: SCOPE_EXPANSION
reason: Sub-tasks would either require a new entity (Subtask) or
        recursive Task self-reference. Either is a meaningful scope expansion.
```

The chat shows a **yellow banner**:

> ⚠ **Warning — Possible Drift**
> Sub-tasks would either require a new entity (Subtask) or recursive Task self-reference. Either is a meaningful scope expansion.
>
> [ **Continue anyway** ]   [ **Go back to Phase 1** ]

If the user continues, the cascade runs as a `screen_only` or `workflow_change` (the model's call). If they go back to Phase 1, they can amend the contract first.

---

### Step 8 — Stage 2: Wireframe

The user has approved the design. The Wireframe chip pulses. Phase 2 Stage 2 runs:

1. **Dummy data generation** — given the entities, produce realistic JSON content (sample tasks, lists, tags, with names like "Buy groceries" and "Finish the deck for Tuesday's meeting")
2. **Wireframe shell** — generate the `index.html` that holds the navigation
3. **Per-screen HTML** (batched, one call per screen) — generate static HTML for each screen, populated from the dummy data
4. **Smoke test** (code-only, no LLM) — verify every screen ID in the inventory has a matching HTML file and every nav link points somewhere
5. **Data file assembly** (code-only) — turn the dummy JSON into `window.DATA = {...}` for the screens to read

When done, the document panel gets a **Wireframe** tab. Clicking it loads the HTML inside a sandboxed iframe.

The user sees a crude but functional todo app:
- Tap "+ New Task" → goes to `task-create`
- Type a title, hit save → returns to `home`, new task appears in the list
- Tap a task → goes to `task-detail`
- Etc.

Visual fidelity is intentionally low (think wireframes, not Figma mockups). The point is to verify whether the **structure** feels right — the right screens exist, the right nav paths are there, the right content is on each screen.

---

### Step 9 — User feedback on the wireframe

Same branching as Step 7 — the user can approve or revise. Three illustrative cases:

#### 9a — Cosmetic content tweak

> *The example task names are too long, make them feel more like real one-line todos*

`scope: data_only`. Only `data.js` is regenerated. The screen HTML files are unchanged. Reload the wireframe and the new dummy content shows up. The Workflow Map, Screen Inventory, and Project Contract are unchanged.

#### 9b — A screen needs work

> *The task-detail screen is missing the "Mark complete" button*

`scope: screen_only`, target: `task-detail`. Only that one screen's HTML is regenerated. Other screens unchanged. Documents unchanged.

#### 9c — Missing a screen entirely

> *I'm missing a screen for managing recurring tasks*

This is the case you specifically mentioned. The system can't fix this at the wireframe layer because the screen doesn't exist in the inventory and the underlying workflow doesn't exist either. The right thing is to walk back through the stages:

- The drift check first decides if the change fits the contract (recurring tasks — probably COMPATIBLE; the contract didn't say anything about recurrence)
- The cascade scope is `workflow_change` — needs design re-work
- The system rewinds to the Design stage internally:
  - Workflow Map gets a new "Manage recurring tasks" workflow
  - Screen Inventory gets a new `recurrence-settings` screen (with nav links updated)
  - User is shown the updated design and asked to approve
- After approval, the Wireframe stage re-runs incrementally: existing screens unchanged, new screen HTML generated, data.js refreshed

> **Today's note:** this rewind-and-cascade behavior across stages is partially built but not fully wired up. The current code handles `data_only` and `screen_only` cleanly but needs more work for the "rewind to Design, get approval, then cascade forward" flow. It's the first thing to finish in the next iteration.

#### 9d — Something that drifts

Same red-banner / yellow-banner flow as Step 7d / 7e. The contract is the source of truth no matter what stage you're in.

---

### Step 10 — Wireframe approved

The user clicks **Approve → Generate Test Suite**.

**For this iteration of the product, the journey ends here.**

The system would normally continue to Stage 3 (Test Suite — human-readable test cases) and Stage 4 (Automated Tests — executable bundle), but those stages are out of scope for the version we're shipping now. The Approve button at the wireframe stage simply marks the wireframe complete and lets the user export everything they've produced so far.

What they have on disk:
- `project-contract.md` — the locked contract
- `workflow-map.md` — every workflow
- `screen-inventory.md` — every screen with navigation
- A folder of HTML files they can host anywhere as a clickable demo

That's enough to:
- Hand to a designer for high-fidelity mockups
- Hand to engineers as an unambiguous spec
- Show a stakeholder *"this is what we're building"* and get a real reaction
- Save and come back to next week

---

## A note on rollback

Any DRIFT (Step 7d / 9d) gives the user a one-click rollback to Phase 1. What that does:

- Phase 2 is suspended (state preserved on disk)
- Phase 1 reopens with the original chat history
- The user edits the contract (typically: add the persona/entity/boundary that's needed)
- They click Done again
- The system compares the new contract to the snapshot it kept from the original Phase 1 completion:
  - If the contract is structurally identical — the suspended Phase 2 is **restored** as-is (no waiting)
  - If it differs — Phase 2 is **regenerated from scratch** because the design and wireframes might no longer be valid

This means rollback isn't a destructive action; it's a "let me amend the foundation" action.

---

## The build philosophy (in one breath)

This thing is built as **independent modules**. Each one has a narrow job and a small public surface. They form a clean dependency graph (nothing calls "up" the chain) so you can swap one out without touching the others.

You don't need to know all 14 modules to use the app. But knowing they exist explains why certain things are easy:

- **Switching LLM providers** is one module's job (LLM Provider) — not a refactor
- **Storing data** is one module's job (Storage) — file-based today, swap for a database without touching anything else
- **Each LLM call** has a parser paired with it (Parsers + Operation Executor) — when the model misbehaves, fix one prompt or one parser, not the whole pipeline
- **The 4 Phase 2 stages** each have their own runner (in Session Manager) — adding a 5th stage is a contained change

The full module catalog and inter-module contracts live in `replicate-instructions.md`. You don't need it to use the product, but if you ever want to rebuild the system or hack on it, that's the map.

---

## What's deferred to the next iteration

We're shipping the front half of the journey. Explicitly **not** in this version:

| Feature | Why deferred |
|---|---|
| Test Suite generation (Stage 3) | The contract → wireframe loop is the riskiest part; ship it and learn before adding more LLM-heavy stages |
| Automated Tests (Stage 4) | Same. Also depends on Test Suite. |
| Full stage-rewind-cascade on feedback (case 9c) | The plumbing is mostly there; needs the cross-stage approval UX completed |
| Multi-user / team accounts | This is a single-developer / single-stakeholder tool right now |
| Provider switching from the UI | Currently `.env.local`; planned as Module 14 ("LLM Configuration") in the next iteration |
| Visual polish on wireframes | Intentionally crude — we're testing structure, not aesthetics |

The stages we ARE shipping (Project Contract → Workflow Map → Screen Inventory → Wireframe) cover the most expensive part of any product project: **getting the scope right** and **seeing it concretely** before anyone writes code.

---

## TL;DR for someone joining the project

1. The product helps users go from one sentence to a clickable wireframe of the product they want to build.
2. The user produces four artifacts in order: **Contract → Workflows → Screens → Wireframe**, with an explicit approval gate after each.
3. The user can chat with the system at any point. The system distinguishes **questions** (chat reply, no doc change) from **change requests** (surgical edit, doc updated).
4. Every change request is checked against the locked contract. **Compatible** → proceeds. **Flag** → user decides. **Drift** → blocked, must rollback.
5. The whole thing is composed of small independent modules — see `replicate-instructions.md` for the full catalog.
6. Test suite + automation are next iteration. This iteration ends at the approved wireframe.

Open the app, type *"I want to build a todo app,"* and see how far you get in 15 minutes.







13-Module Overview

  #: 1
  Module: LLM Provider
  What it does: uses LiteLLM to interact with any configured provider
  Interacts with: Calls out: OpenRouter HTTP API. Called by: Operation Executor.
  ────────────────────────────────────────
  #: 2
  Module: Parsers
  What it does: Pure functions turning raw LLM text into typed data (YAML, JSON, markdown sections, validation results, drift classifications, diagnosis
    verdicts, tagged contexts). All return uniform ParseResult<T>.
  Interacts with: Calls out: nothing. Called by: Operation Executor (via the parser attached to each operation definition).
  ────────────────────────────────────────
  #: 3
  Module: Prompt Registry
  What it does: Slug → prompt-string lookup. Holds all 26 prompts as plain strings (Phase 1: 4, Phase 2 auto-gen: 16, Phase 2 interaction: 5, validation:
  1).
  Interacts with: Calls out: nothing. Called by: Operations and Context Builder.
  ────────────────────────────────────────
  #: 4
  Module: Streaming (SSEWriter)
  What it does: Wraps a ReadableStream into typed SSE events (chunk, document, phase, stage, progress, drift, meta, error, complete). One instance per HTTP
    request.
  Interacts with: Calls out: nothing. Called by: API Routes (creates one), Session Manager + Operations (write events to it).
  ────────────────────────────────────────
  #: 5
  Module: Storage
  What it does: CRUD for every domain entity — sessions, phase states, documents, artifacts, chat messages, operation progress, checkpoints, conversation
    summaries, pending messages, test results, cascade snapshots. Two interchangeable backends: FileStorage (JSON-on-disk) and MemoryStorage (tests).
  Interacts with: Calls out: filesystem. Called by: Session Manager, Operations, Context Builder, API Routes (via bootstrap singleton).
  ────────────────────────────────────────
  #: 6
  Module: Operation Executor
  What it does: The single point that calls the LLM. Adds retries with corrective hints on parse failure, per-op timeouts, abort signals, and per-session
    token tracking on top of the LLM Provider. Has a streamCall hook subclassable for tests.
  Interacts with: Calls out: LLM Provider (1), Parsers (2 — via the parser on each definition). Called by: every Operation.
  ────────────────────────────────────────
  #: 7
  Module: Context Builder
  What it does: Reads from Storage + Prompt Registry to build {systemPrompt, messages} for each operation. Includes a Summarizer for trimming long chat
    history to fit context limits.
  Interacts with: Calls out: Storage (5), Prompt Registry (3), Operation Executor (6 — for summarization). Called by: Operations.
  ────────────────────────────────────────
  #: 8
  Module: Operations
  What it does: One function per LLM operation (op-1-0, op-1-1, op-1-2, op-1-3, op-2-1a–2-1c, op-2-2a–2-2c, op-2-3a–2-3d, op-2-4a–2-4e, op-2-5a–2-5e,
  op-2-6,
    op-2-7a/c/d, op-2-9, op-2-10). Each glues a prompt + parser + storage writeback. Includes executeBatch() for fan-out ops with semaphore concurrency.
  Interacts with: Calls out: Operation Executor (6), Context Builder (7), Prompt Registry (3), Storage (5), Streaming (4). Called by: Session Manager (via
    stage runners).
  ────────────────────────────────────────
  #: 9
  Module: Dependency Graph
  What it does: Generic DAG executor with bounded concurrency, conditional skips, and progress callbacks. Knows nothing about the domain — just runs nodes
    when their deps are ready. Catches per-node exceptions intentionally so siblings keep progressing; callers must check the status map after execute().
  Interacts with: Calls out: nothing (calls the execute function passed in each node). Called by: Session Manager's stage runners.
  ────────────────────────────────────────
  #: 10
  Module: Phase 2 Stage Machine
  What it does: Tracks which of the 4 Phase 2 stages a session is in (design_running → design_review → wireframe_running → ... → complete). Enforces valid
    transitions; provides canAdvanceStage(), setPhase2Stage(), getPhase2Stage().
  Interacts with: Calls out: Storage (5). Called by: Session Manager (Phase 2 handlers + advance endpoint).
  ────────────────────────────────────────
  #: 11
  Module: Session Manager
  What it does: Top-level coordinator. Owns session lifecycle (create, route, complete), the per-session chat lock (rejects overlapping operations), Phase 1

    → Phase 2 chaining, the 4 Phase 2 stage runners, and the cascade/rollback paths. Implements Phase1Handlers and Phase2Handlers interfaces that wire to
    concrete Operations.
  Interacts with: Calls out: Storage (5), Operations (8), Dependency Graph (9), Phase 2 Stage Machine (10), Streaming (4). Called by: API Routes.
  ────────────────────────────────────────
  #: 12
  Module: API Routes
  What it does: Thin HTTP adapters (~30 lines each). 13 routes — /chat, /phase/complete, /phase2/start, /phase2/advance, /rollback, /sessions,
    /sessions/[id], /wireframe/[sessionId]/[filename], /tests/run, /tests/diagnose, /export, /health, /test-llm. Each grabs the SessionManager from the
    bootstrap singleton, opens an SSEWriter, delegates.
  Interacts with: Calls out: Session Manager (11), Storage (5), Streaming (4). Called by: the browser (HTTP).
  ────────────────────────────────────────
  #: 13
  Module: UI (React + Zustand)
  What it does: Three-zone layout (sidebar / chat / document panel), three Zustand stores (session / chat / document), and a useSSE() hook that consumes the

    SSE wire format and dispatches events to the right store. Components: AppShell, SessionSidebar, PhaseIndicator (with sub-stage chips), ChatPanel,
    ChatInput, DocumentPanel, ApproveStageButton, DriftWarning, WireframeViewer, TestResultsPanel, ErrorBoundary.
  Interacts with: Calls out: API Routes (12 — via fetch + SSE). Called by: the browser (rendered by Next.js).

  Dependency layout

  The numbers form a clean DAG — nothing above ever calls down to itself:

                   [12 API Routes] ─► [11 Session Manager] ─► [8 Operations]
                         │                  │  │  │  │           │
                         │            ┌─────┘  │  │  └────┐      │
                         │            ▼        │  ▼       ▼      │
                         │      [10 Stage]     │ [9 DAG]         │
                         │       Machine       │                 │
                         │            │        │                 │
                         └────────────┴────────┴─────►[5 Storage]│
                                                                 │
                                                    [7 Context]──┤
                                                         │       │
                                                         └──────►[3 Prompts]
                                                                 │
                                                            [6 Executor]
                                                                 │
                                                    ┌────────────┤
                                                    ▼            ▼
                                             [1 LLM Prov.]  [2 Parsers]

                                    [4 SSE Streaming] ─ used as a transport by 8, 11, 12, 13

  Five modules have zero dependencies

  These can be built and tested in any order, in complete isolation: 1 LLM Provider, 2 Parsers, 3 Prompt Registry, 4 Streaming, 5 Storage, 9 Dependency
  Graph.

  Build any of these first and you have something testable end-to-end with a few lines of glue code.

  Three modules are pure orchestration

  6 Operation Executor, 11 Session Manager, 12 API Routes — they don't add domain knowledge, they just sequence calls to the modules below. If you wanted to
   swap the product (build something other than UX Builder), you'd rewrite 8 Operations + 3 Prompts and probably reuse everything else.




An extra new module 14 for provider


Module 14 — LLM Configuration

  Purpose

  Holds the currently active LLM credentials and model selection. Lets the user change provider + key without restarting the server. The LLM Provider module
   reads from it at call time; the UI writes to it from a settings page.

  Where it sits in the stack

       ┌─────────────────────┐
       │ Settings UI (13)    │ ─── writes
       └──────────┬──────────┘
                  ▼
       ┌─────────────────────┐
       │ /api/llm-config (12)│ ─── HTTP adapter
       └──────────┬──────────┘
                  ▼
       ┌─────────────────────┐
       │ LLM Configuration   │  ◄── NEW MODULE
       │      (14)           │
       └──────────┬──────────┘
                  │ get() at call time
                  ▼
       ┌─────────────────────┐
       │ LLM Provider (1)    │ ─── streams via LiteLLM
       └─────────────────────┘

  Public API

  // What the user picks per session (or globally — both work, see "Scope" below).
  interface LlmConfig {
    // What LiteLLM calls the upstream — e.g. "openrouter", "groq",
    // "anthropic", "openai", "ollama". This becomes the prefix in the
    // model slug LiteLLM expects.
    provider: string;

    // The upstream provider's API key. Stored encrypted at rest if you
    // care about that; plaintext is fine for a local dev tool.
    apiKey: string;

    // LiteLLM-formatted model slugs. Examples:
    //   "openrouter/inclusionai/ling-2.6-1t:free"
    //   "groq/llama-3.3-70b-versatile"
    //   "anthropic/claude-opus-4-7"
    //   "openai/gpt-4o"
    modelFast: string;
    modelReasoning: string;

    // Optional. If set, all calls go to this URL and LiteLLM proxy handles
    // upstream routing. If unset, we hit the upstream provider directly via
    // its OpenAI-compatible endpoint (works for openrouter/groq/openai/ollama;
    // anthropic needs the proxy or its OpenAI-compat shim).
    proxyUrl?: string;

    updatedAt: string;
  }

  interface ILlmConfigStore {
    get(): Promise<LlmConfig | null>;        // null = not configured yet
    set(config: LlmConfig): Promise<void>;   // overwrites
    clear(): Promise<void>;
    // Diagnostic helper for /api/health and the smoke route.
    describe(): Promise<{ configured: boolean; provider?: string; modelFast?: string; modelReasoning?: string; proxyUrl?: string }>;
  }

  class FileLlmConfigStore implements ILlmConfigStore {
    constructor(filePath: string);  // e.g. "./data/llm-config.json"
  }

  Scope: global vs. per-session

  ┌─────────────────────────────────┬──────────────────────────────────────┬───────────────────────┬───────────────────────────────────────────────────┐
  │              Scope              │               Storage                │          UX           │                   Pick this if…                   │
  ├─────────────────────────────────┼──────────────────────────────────────┼───────────────────────┼───────────────────────────────────────────────────┤
  │ Global (single config the whole │ One JSON file at                     │ Settings page in the  │ You're a single user; want one place to manage    │
  │  app uses)                      │ ./data/llm-config.json               │ sidebar               │ credentials                                       │
  ├─────────────────────────────────┼──────────────────────────────────────┼───────────────────────┼───────────────────────────────────────────────────┤
  │ Per-session (each chat picks    │ Stored on the Session record         │ Picker in the "New    │ You want to A/B test providers, or different      │
  │ its own provider)               │ (session.llmConfig)                  │ Chat" dialog          │ clients have their own credentials                │
  └─────────────────────────────────┴──────────────────────────────────────┴───────────────────────┴───────────────────────────────────────────────────┘

  The interface above works for both — a per-session implementation just delegates to Storage and keys the config by sessionId. Most users want the global
  flavor; start there.

  Example — the settings flow

  // User opens Settings, enters provider + key + model slugs.
  // UI POSTs to /api/llm-config:

  POST /api/llm-config
  Content-Type: application/json

  {
    "provider": "openrouter",
    "apiKey": "sk-or-v1-...",
    "modelFast": "openrouter/inclusionai/ling-2.6-1t:free",
    "modelReasoning": "openrouter/anthropic/claude-opus-4-7",
    "proxyUrl": "http://localhost:4000"
  }

  → 200 { "ok": true, "configured": true, "provider": "openrouter" }

  The route just calls llmConfigStore.set(body). Next LLM call picks up the new config automatically.

  // Inside the LLM Provider module, resolveModel becomes async:
  async function resolveModel(role: RoleName): Promise<ResolvedModel> {
    const config = await llmConfigStore.get();
    if (!config) throw new Error("LLM not configured. Open Settings and pick a provider.");
    const modelId = role === "fast" ? config.modelFast : config.modelReasoning;
    return {
      role,
      provider: config.provider,
      modelId,
      apiKey: config.apiKey,
      baseUrl: config.proxyUrl ?? defaultBaseUrlFor(config.provider),
    };
  }

  What LiteLLM brings to the table

  LiteLLM is just an OpenAI-compatible router. From our app's perspective the wire format doesn't change — every call still POSTs {model, messages, stream:
  true} to a /v1/chat/completions endpoint. The only differences from today's OpenRouter-only setup:

  1. The model field gets a provider prefix: "openrouter/inclusionai/..." instead of just "inclusionai/..."
  2. The baseUrl switches between providers (or points at a single LiteLLM proxy if you run one)

  So Module 1 (LLM Provider) needs minimal changes:
  - Rename streamOpenRouter → streamLiteLLM (or streamCompletions)
  - Take baseUrl and apiKey as parameters (already supported)
  - That's it — the SSE parser, request shape, error handling all stay

  Interactions with other modules

  ┌──────────────────────────┬──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
  │   Module 14 talks to…    │                                                           How                                                            │
  ├──────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ Storage (5) OR its own   │ Persists the config. If you reuse Storage, add one method getLlmConfig()/setLlmConfig(); otherwise the module owns its   │
  │ file                     │ own JSON file.                                                                                                           │
  ├──────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ Nothing else             │ It has zero dependencies on the rest of the system.                                                                      │
  └──────────────────────────┴──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

  ┌─────────────────────┬───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
  │ Other modules talk  │                                                              How                                                              │
  │        to 14        │                                                                                                                               │
  ├─────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ LLM Provider (1)    │ Calls llmConfigStore.get() inside resolveModel(role) to know which model + key + URL to use for this call                     │
  ├─────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ API Routes (12)     │ New /api/llm-config GET/POST/DELETE adapter                                                                                   │
  ├─────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ UI (13)             │ Settings page reads + writes via the new API route. Also reads /api/health (which now reports configured: true/false) to show │
  │                     │  a "no LLM configured" warning when needed                                                                                    │
  └─────────────────────┴───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

  The Operation Executor, Session Manager, Operations, Context Builder, etc. all stay untouched. They go through resolveModel(role) already; they don't care
   that it now reads from a store instead of env vars.

  One subtlety: env vars as a fallback

  Keep env vars working as a fallback so dev setup stays one-step:

  async function resolveModel(role: RoleName): Promise<ResolvedModel> {
    // Priority order: configured → env vars → fail
    const stored = await llmConfigStore.get();
    if (stored) return modelFromConfig(stored, role);

    const envConfig = readEnvFallback();
    if (envConfig) return modelFromConfig(envConfig, role);

    throw new Error("No LLM configured");
  }

  That way existing .env.local setups keep working, and anyone who picks credentials in the UI overrides them.

  ---
  Updated full module list (14 modules)

  ┌─────┬─────────────────┬──────────────────────────────────────────────────────────────────┬──────────────────────────────────────────────────────────┐
  │  #  │     Module      │                           What it does                           │                      Interacts with                      │
  ├─────┼─────────────────┼──────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
  │     │                 │ Streams OpenAI-compatible chat completions via native fetch.     │ Calls out: LiteLLM proxy or upstream provider HTTP, LLM  │
  │ 1   │ LLM Provider    │ Targets either a direct provider URL or a LiteLLM proxy URL —    │ Configuration (14) for the per-call resolved             │
  │     │                 │ same wire format either way.                                     │ provider/key/baseUrl. Called by: Operation Executor (6). │
  ├─────┼─────────────────┼──────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
  │     │                 │ Pure functions: raw LLM text → typed data (YAML, JSON, markdown  │                                                          │
  │ 2   │ Parsers         │ sections, validation results, drift, diagnosis, tagged           │ Calls out: nothing. Called by: Operation Executor (6).   │
  │     │                 │ contexts). All return ParseResult<T>.                            │                                                          │
  ├─────┼─────────────────┼──────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
  │ 3   │ Prompt Registry │ Slug → prompt-string lookup. Holds all 26 prompts as static      │ Calls out: nothing. Called by: Operations (8), Context   │
  │     │                 │ strings.                                                         │ Builder (7).                                             │
  ├─────┼─────────────────┼──────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
  │ 4   │ Streaming       │ Wraps ReadableStream into typed SSE events (chunk, document,     │ Calls out: nothing. Called by: API Routes (12), Session  │
  │     │ (SSEWriter)     │ phase, stage, progress, drift, meta, error, complete).           │ Manager (11), Operations (8).                            │
  ├─────┼─────────────────┼──────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
  │     │                 │ CRUD for sessions, phase states, documents, artifacts, chat      │                                                          │
  │ 5   │ Storage         │ messages, operation progress, checkpoints, summaries, pending    │ Calls out: filesystem. Called by: Session Manager (11),  │
  │     │                 │ messages, test results, cascade snapshots. FileStorage +         │ Operations (8), Context Builder (7), API Routes (12).    │
  │     │                 │ MemoryStorage.                                                   │                                                          │
  ├─────┼─────────────────┼──────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
  │     │ Operation       │ Calls the LLM via Module 1, runs Parsers (2), retries on parse   │ Calls out: LLM Provider (1), Parsers (2). Called by:     │
  │ 6   │ Executor        │ failure with corrective hints, tracks tokens, honors timeouts +  │ every Operation in (8).                                  │
  │     │                 │ abort signals.                                                   │                                                          │
  ├─────┼─────────────────┼──────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
  │     │                 │ Reads chat history + documents from Storage and prompts from the │ Calls out: Storage (5), Prompt Registry (3), Operation   │
  │ 7   │ Context Builder │  Registry; assembles {systemPrompt, messages} for each           │ Executor (6 — for summarization). Called by: Operations  │
  │     │                 │ operation. Includes a Summarizer for trimming long histories.    │ (8).                                                     │
  ├─────┼─────────────────┼──────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
  │     │                 │ One function per LLM op (op-1-0 … op-2-10). Each glues a prompt  │ Calls out: Operation Executor (6), Context Builder (7),  │
  │ 8   │ Operations      │ + parser + storage writeback + SSE event emission. Includes      │ Prompt Registry (3), Storage (5), Streaming (4). Called  │
  │     │                 │ executeBatch for fan-out ops with semaphore concurrency.         │ by: Session Manager (11) — specifically its stage        │
  │     │                 │                                                                  │ runners.                                                 │
  ├─────┼─────────────────┼──────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
  │     │ Dependency      │ Generic DAG executor — bounded concurrency, conditional skips,   │ Calls out: the per-node execute callbacks passed in.     │
  │ 9   │ Graph           │ progress callbacks. Domain-agnostic. Catches per-node            │ Called by: Session Manager's stage runners (11).         │
  │     │                 │ exceptions; callers must check getStatuses().                    │                                                          │
  ├─────┼─────────────────┼──────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
  │     │ Phase 2 Stage   │ Tracks the 4 Phase 2 stages (design_running → design_review →    │ Calls out: Storage (5). Called by: Session Manager's     │
  │ 10  │ Machine         │ wireframe_running → … → complete). Enforces valid transitions;   │ Phase 2 handlers + advance endpoint (11).                │
  │     │                 │ helpers to persist state on the Session record.                  │                                                          │
  ├─────┼─────────────────┼──────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
  │     │                 │ Top-level coordinator: session lifecycle, chat lock (one op per  │ Calls out: Storage (5), Operations (8), Dependency Graph │
  │ 11  │ Session Manager │ session at a time), Phase 1 → Phase 2 chaining, the 4 Phase 2    │  (9), Phase 2 Stage Machine (10), Streaming (4). Called  │
  │     │                 │ stage runners, cascade and rollback paths. Implements            │ by: API Routes (12).                                     │
  │     │                 │ Phase1Handlers and Phase2Handlers.                               │                                                          │
  ├─────┼─────────────────┼──────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
  │     │                 │ HTTP adapters (~30 lines each). 14 routes — all the existing     │                                                          │
  │ 12  │ API Routes      │ ones plus /api/llm-config. Each grabs the SessionManager /       │ Calls out: Session Manager (11), Storage (5), Streaming  │
  │     │                 │ LlmConfigStore from the bootstrap singleton, opens an SSEWriter  │ (4), LLM Configuration (14). Called by: the browser.     │
  │     │                 │ when needed, delegates.                                          │                                                          │
  ├─────┼─────────────────┼──────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
  │ 13  │ UI (React +     │ Three-zone layout, three Zustand stores, the useSSE() hook, plus │ Calls out: API Routes (12) via fetch + SSE. Called by:   │
  │     │ Zustand)        │  a new Settings page for LLM Configuration.                      │ the browser.                                             │
  ├─────┼─────────────────┼──────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
  │     │ LLM             │ Stores the active provider, API key, model slugs, and optional   │ Calls out: Storage (5) OR its own JSON file. Called by:  │
  │ 14  │ Configuration ⬅ │ LiteLLM proxy URL. Read by the LLM Provider at every call;       │ LLM Provider (1) at call time, API Routes (12) for       │
  │     │  NEW            │ written by the Settings UI.                                      │ read/write.                                              │
  └─────┴─────────────────┴──────────────────────────────────────────────────────────────────┴──────────────────────────────────────────────────────────┘

  ---
  Updated dependency layout

                      [12 API Routes]
                            │
                ┌───────────┼─────────────────────────────┐
                ▼           ▼                             ▼
         [11 Session    [14 LLM Config]              [4 SSE Streaming]
           Manager]          │                       (used as transport
                │            │ stored in              by 8, 11, 12, 13)
         ┌──────┼──────┐     ▼
         ▼      ▼      ▼  [5 Storage]
   [10 Stage] [9 DAG] [8 Operations]
     Machine     │     │ │ │ │
         │       │     │ │ │ └─► [3 Prompts]
         │       │     │ │ └───► [7 Context Builder] ─► [3], [5]
         │       │     │ └─────► [5 Storage]
         │       │     └───────► [6 Operation Executor]
         │       │                       │
         │       │                       ├─► [1 LLM Provider]
         │       │                       │           │
         │       │                       │           └─► [14 LLM Config] ─► [5]
         │       │                       │
         │       │                       └─► [2 Parsers]
         │       │
         └───────┴─────────────► [5 Storage]

  [13 UI] ──HTTP/SSE──► [12 API Routes]
         └──────settings page writes──► /api/llm-config ──► [14]

  Reading the diagram: every arrow is a call from caller → callee. Nothing ever calls "up" the diagram. The only structural change from the previous
  13-module design is Module 14 sitting between Module 1 and the Storage/file layer, which makes the LLM Provider's resolveModel async (it does an I/O read)
   but otherwise leaves every other module untouched.

  What this buys you concretely

  1. Switch provider with no restart. User opens Settings, picks Anthropic instead of OpenRouter, hits Save. Next chat message goes to Anthropic.
  2. No SDK lock-in. streamLiteLLM is the same ~150 lines of native fetch — works against LiteLLM proxy, OpenRouter direct, Groq direct, or any
  OpenAI-compatible endpoint.
  3. Proxy is optional. If the user wants to use LiteLLM's full power (cost tracking, rate limiting, fallback chains), they run the proxy and set proxyUrl.
  Otherwise they skip it and we hit upstream directly.
  4. Existing env-var setup keeps working as a fallback — no breaking change for anyone who set .env.local before.
