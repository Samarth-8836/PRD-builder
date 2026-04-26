/**
 * Phase 2 Stage 1 (Design) prompts. Five LLM-driven steps:
 *   - workflow_discovery: contract -> list of workflow stubs
 *   - workflow_detail:    contract + one stub -> full workflow spec (batched)
 *   - screen_extract:     contract + workflow map -> list of screens
 *   - nav_validate:       workflow map + screens -> GAPS or NO GAPS
 *   - screen_correct:     original screens + gaps -> updated screens
 *
 * The two formatting steps from the spec (workflow_map_format and
 * screen_inventory_format) are done deterministically in code rather than
 * via LLM — they're pure templating and trading reliability for one
 * extra LLM call isn't worth it.
 */

// ---------------------------------------------------------------------------
// 1. Workflow discovery
// ---------------------------------------------------------------------------

export const WORKFLOW_DISCOVERY_SYSTEM = `You are designing the user workflows for a software product based on its Project Contract. A workflow is one persona doing one thing end-to-end (e.g. "Individual User creates a task", "Admin User exports a report").

You will be given the Project Contract inside <contract>...</contract>. Identify the smallest complete set of workflows the product needs in order to deliver on the Goal Statement, given the personas and entities in the contract.

OUTPUT FORMAT — strict markdown bullets, one per line, in this exact shape:

- **{Workflow Name}** — {one-sentence description of what the persona does and what they accomplish}

Requirements:
- 4 to 7 workflows. Pick the SMALLEST set that covers what the contract demands. Combine related actions into one workflow when possible (e.g. "Manage tasks" can cover edit + complete + delete rather than three separate workflows).
- Each workflow must involve exactly ONE persona end-to-end.
- Each workflow must be a complete user journey (start -> end), not a single UI affordance.
- Use action-oriented names (e.g. "Capture a task", "Manage lists"). Avoid screen names.
- Cover all major personas and major entity interactions implied by the contract.
- Do NOT include workflows for features ruled out by the Boundaries.

Do not output anything before the first bullet or after the last. Do not wrap in code fences. Do not include preambles like "Here are the workflows:".`;

export const WORKFLOW_DISCOVERY_EXAMPLE_USER = `<contract>
## Goal Statement
A lightweight personal task management app that helps individuals capture, organize, and track tasks across their day.

## Personas
**Individual User** — A single person managing their own to-do list.
Interaction type: Creates, edits, completes tasks; organizes them into lists; sets due dates and reminders.

## Entity Map
**Task** — A single actionable item with title, optional description, due date, status. Individual User creates, edits, marks complete.
**List** — A grouping of related tasks (e.g. "Work", "Home"). Individual User creates, renames, archives, reorders.

## Boundaries
- No team / multi-user features
- No calendar integration (Google Calendar, Outlook)
- No advanced project management (Gantt charts, dependencies)
- No time tracking or billing
</contract>`;

export const WORKFLOW_DISCOVERY_EXAMPLE_ASSISTANT = `- **Capture a task** — Individual User opens the app and creates a new task with a title and optional details.
- **Browse tasks** — Individual User views their tasks, optionally filtered by list or due date.
- **Mark a task complete** — Individual User toggles a task's status to done.
- **Edit a task** — Individual User opens an existing task and modifies its fields.
- **Delete a task** — Individual User removes a task they no longer need.
- **Create a list** — Individual User creates a new list to group related tasks.
- **Rename or reorder a list** — Individual User adjusts how their lists are organized.
- **Archive a list** — Individual User puts a list into an archived state.`;

export const WORKFLOW_DISCOVERY_CORRECTIVE_HINT = (reason: string) =>
  `Your previous response was rejected. Reason: ${reason}

Reply ONLY with markdown bullets in this exact format:

- **{Workflow Name}** — {one-sentence description}

5 to 12 bullets, one per line. No code fences, no preamble.`;

// ---------------------------------------------------------------------------
// 2. Workflow detail (batched per workflow)
// ---------------------------------------------------------------------------

export const WORKFLOW_DETAIL_SYSTEM = `You are detailing one user workflow for a software product. You will be given the Project Contract inside <contract>...</contract> and the workflow stub to expand inside <workflow>...</workflow>.

Produce a complete spec for the workflow with FOUR labeled sub-sections in this exact order: Pre-conditions, Steps, Exit criteria, Edge cases.

OUTPUT FORMAT — strict, with section labels in bold:

**Pre-conditions**
- {condition 1}
- {condition 2}

**Steps**
1. {step 1 — concrete user action}
2. {step 2}
3. ...

**Exit criteria**
- {what changed in the world after this workflow completes}

**Edge cases**
- {scenario}: {how the product handles it}
- {scenario}: {how the product handles it}

Requirements:
- Steps are imperative actions the persona takes. Each step should map to a single screen interaction (tap, type, drag, scroll). 3 to 8 steps.
- Pre-conditions are facts that must be true before the workflow can start (e.g. "App is open", "User has at least one list").
- Exit criteria are observable outcomes (e.g. "New task is visible in the list view", "Task is marked done").
- Edge cases cover realistic user mistakes or system failures (e.g. "User cancels mid-flow", "Title is empty", "Due date is in the past").
- Use the personas, entities, and constraints from the contract — do not introduce new ones.

Do not output anything before "**Pre-conditions**" or after the last edge case bullet. Do not wrap in code fences.`;

export const WORKFLOW_DETAIL_CORRECTIVE_HINT = (reason: string) =>
  `Your previous response was rejected. Reason: ${reason}

Reply ONLY with the four labeled sections in this order:

**Pre-conditions**
- ...

**Steps**
1. ...

**Exit criteria**
- ...

**Edge cases**
- ...

No code fences, no preamble.`;

// ---------------------------------------------------------------------------
// 3. Screen extract
// ---------------------------------------------------------------------------

export const SCREEN_EXTRACT_SYSTEM = `You are designing the screens needed for a software product. Given the Project Contract (inside <contract>...</contract>) and the Workflow Map (inside <workflow_map>...</workflow_map>), derive the minimum set of screens needed to support every workflow end-to-end.

A screen has:
- an id (lowercase, kebab-case, e.g. "home", "task-detail", "list-create")
- a one-sentence purpose
- a description of what content it shows
- a list of screen ids the user can navigate TO from this screen

OUTPUT FORMAT — strict markdown blocks, one per screen, separated by blank lines:

- **{screen-id}** — {one-sentence purpose}
  Shows: {what content the screen displays}
  Nav: {comma-separated list of screen-ids reachable from this screen}

Requirements:
- 4 to 12 screens.
- Every workflow in the Workflow Map must be completable by navigating between the screens you list.
- Use the smallest set of screens. Do not invent decorative screens (no separate splash, login, about, etc. unless workflows require them).
- Every nav target you cite must itself be a screen-id you list.
- It is fine for a screen's Nav to be empty (modal/terminal screens) — write "Nav: -" in that case.
- All ids are lowercase kebab-case.

Do not output anything before the first bullet or after the last. Do not wrap in code fences. Do not include preambles.`;

export const SCREEN_EXTRACT_CORRECTIVE_HINT = (reason: string) =>
  `Your previous response was rejected. Reason: ${reason}

Reply ONLY with this format, one entry per screen:

- **{screen-id}** — {purpose}
  Shows: {content}
  Nav: {comma-separated screen-ids, or "-" if none}

All ids lowercase kebab-case. Every Nav target must itself be a screen-id you list. No code fences, no preamble.`;

// ---------------------------------------------------------------------------
// 4. Navigation validation
// ---------------------------------------------------------------------------

export const NAV_VALIDATE_SYSTEM = `You are validating that a set of screens can support every workflow in a software product.

You will be given the Workflow Map (inside <workflow_map>...</workflow_map>) and the Screen list with nav links (inside <screens>...</screens>).

For each workflow, mentally walk through its Steps and check that the user can complete it by navigating between the listed screens. Look for:
- Workflows that need a screen which doesn't exist (e.g. workflow says "user opens task detail" but no task-detail screen).
- Workflows that need to navigate between screens that aren't connected (e.g. workflow needs to go home -> task-detail but home's nav doesn't include task-detail).
- Screens with broken nav references (nav target that isn't a screen id).

OUTPUT FORMAT — strict.

If every workflow can be completed AND every nav reference is valid, output exactly:

NO GAPS

If any workflow cannot be completed OR any nav reference is broken, output:

GAPS:
- {short description of the gap, citing the workflow name and the missing screen / broken nav}
- {one bullet per distinct gap}

Do not output anything before "NO GAPS" or "GAPS:". Do not wrap in code fences. Do not include preambles.`;

export const NAV_VALIDATE_CORRECTIVE_HINT = (reason: string) =>
  `Your previous response was rejected. Reason: ${reason}

Reply ONLY with one of:

NO GAPS

OR:

GAPS:
- {gap}
- {gap}

The first non-whitespace token MUST be "NO" or "GAPS". No code fences, no preamble.`;

// ---------------------------------------------------------------------------
// 5. Screen correction (conditional, only when gaps were found)
// ---------------------------------------------------------------------------

export const SCREEN_CORRECT_SYSTEM = `You are correcting a screen list to address gaps that were identified during navigation validation.

You will be given the original Screen list (inside <screens>...</screens>), the Workflow Map (inside <workflow_map>...</workflow_map>), and the gaps to fix (inside <gaps>...</gaps>).

Add new screens or update existing screens' nav links to address every listed gap. PRESERVE existing screens verbatim if a gap doesn't require changing them — do not rephrase, reorder, or "improve" untouched screens.

OUTPUT FORMAT — exactly the same as the original screen list:

- **{screen-id}** — {purpose}
  Shows: {content}
  Nav: {comma-separated screen-ids, or "-" if none}

Output the COMPLETE updated screen list (including unchanged screens), not just the diff. Do not wrap in code fences. Do not include preambles.`;

export const SCREEN_CORRECT_CORRECTIVE_HINT = SCREEN_EXTRACT_CORRECTIVE_HINT;
