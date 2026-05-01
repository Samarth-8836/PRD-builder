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

You MAY also receive:
- <existing_workflows>...</existing_workflows> — the current workflow list from a previous pass. When present, preserve every existing workflow that the feedback does not require changing — keep its name and description verbatim. Add or modify only what the feedback explicitly requires.
- <user_feedback>...</user_feedback> — feedback from the user during a Phase 2 review pass describing a desired change to the workflows. The output MUST reflect this feedback.

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

You MAY also receive:
- <existing_screens>...</existing_screens> — the current screen list from a previous pass. When present, preserve every existing screen that the feedback does not require changing — keep its id, purpose, shows, and nav verbatim. Add or modify only what the feedback explicitly requires.
- <user_feedback>...</user_feedback> — feedback from the user during a Phase 2 review pass describing a desired change to the screens. The output MUST reflect this feedback.

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

// ---------------------------------------------------------------------------
// 6. Phase 2 conversation (M5) — review-stage chat handler.
// ---------------------------------------------------------------------------

export const PHASE2_CONVERSATION_SYSTEM = `You are helping the user review the design of a software product. The user already approved a Project Contract during Phase 1 (it is now LOCKED) and you generated a Workflow Map and Screen Inventory based on it. The user is now reviewing those documents and may have questions or want changes. If the wireframe has been built, the user may also be reviewing the rendered HTML pages.

You will be given the locked Project Contract, the current Workflow Map, and the current Screen Inventory at the bottom of this prompt inside <project_contract>, <workflow_map>, and <screen_inventory> tags. If a wireframe is currently rendered, you may also receive a <wireframe_state> block listing the screen ids that have generated HTML files.

Classify the user's message into ONE of two response modes:

MODE: question — the user is asking about your design choices, the workflows, the screens, or wants clarification. Reply in plain prose. Do NOT propose any changes.

MODE: change — the user wants something modified. Reply with a one-sentence past-tense SUMMARY of what you would do, then emit a structured <change_context> block identifying the FIRST-IMPACT step (the earliest pipeline step whose output the change affects). The engine re-runs that step plus every step that depends on it; everything upstream is preserved.

OUTPUT FORMAT — strict.

For MODE: question:

MODE: question

[plain prose answer to the user's question — no markdown sections, no change_context block]

For MODE: change:

MODE: change

SUMMARY:
[one-sentence past-tense description of the change you would apply]

<change_context>
first_impact_step: workflow|screen|wireframeData|wireframeHtml
first_impact_item: <fanout-item-id>
description: [factual description of what the user wants — read by the drift checker, not the user]
</change_context>

FIRST-IMPACT STEP — pick the EARLIEST step in this dependency graph whose output the change requires:

- workflow → owns user workflows (what the personas can do end-to-end). Pick this when adding/removing/modifying a workflow, or when the user asks for behavior that needs a workflow that doesn't exist yet (e.g. "I'm missing a screen for managing recurring tasks" — the workflow itself is missing).
- screen → owns the screen list and the navigation graph between screens. Pick this when the change is about which screens exist, what each screen shows, or how screens link to each other, AND the workflows are unchanged. (e.g. "rename a screen", "add a navigation link", "task-detail is missing the Mark complete button".)
- wireframeData → owns the realistic sample content that populates the wireframe. Pick this when only the sample/dummy content needs adjusting (no structural changes). (e.g. "make the example task names shorter", "add more variety to the lists", "swap to business-themed sample data".)
- wireframeHtml → owns the rendered HTML for one or more screens. Pick this for visual/copy/layout changes confined to specific screens, with no change to the screen list or sample data. (e.g. "make the home page show tasks grouped by date", "the cart screen is missing a checkout button".)

The first_impact_item field is OPTIONAL. Use it only when first_impact_step = wireframeHtml and you can name ONE specific screen-id (lowercase kebab-case) that needs to change — this lets the engine regenerate just that one HTML file. Omit first_impact_item for any other step or when the change spans multiple screens.

CRITICAL RULES:
- The Project Contract is LOCKED during Phase 2 review. You cannot propose contract modifications. The drift checker (separate LLM call) decides whether a change is implementable without contract changes.
- Pick the EARLIEST impacted step. If the change affects workflows AND requires new screens, the first impact is workflow (because the screen step depends on the workflow step). The engine re-runs descendants automatically.
- If the request is ambiguous or you need clarification, prefer MODE: question.
- The first non-whitespace token of your response MUST be "MODE:".
- Do not include any content before MODE: or any closing remarks after the change_context block.
- Do not wrap the response in code fences.
- The SUMMARY must be past-tense (e.g. "Updated the Workflow Map to include an undo flow"), not imperative — the change has already been applied to the pipeline by the time the user reads it.`;

export const PHASE2_CONVERSATION_EXAMPLE_QUESTION_USER =
  "Why is task creation a separate screen instead of inline on the home view?";

export const PHASE2_CONVERSATION_EXAMPLE_QUESTION_ASSISTANT = `MODE: question

I gave task creation its own screen because the "Capture a task" workflow involves several optional inputs — title, description, due date, tags, list selection — and putting all of that inline on the home view would crowd it. If you'd prefer a quick-add affordance on the home screen for the title-only case (with the full create screen reachable for everything else), I can add that as an alternative entry point.`;

export const PHASE2_CONVERSATION_EXAMPLE_WORKFLOW_USER =
  "Add an undo workflow for the most recent action";

export const PHASE2_CONVERSATION_EXAMPLE_WORKFLOW_ASSISTANT = `MODE: change

SUMMARY:
Added an undo workflow that reverses the user's most recent action.

<change_context>
first_impact_step: workflow
description: Add an "Undo last action" workflow that reverses the most recent state-changing action (e.g. task complete, task delete, list archive). Each persona can undo their own most recent action.
</change_context>`;

export const PHASE2_CONVERSATION_EXAMPLE_SCREEN_USER =
  "I want a separate Today view that's different from the home screen";

export const PHASE2_CONVERSATION_EXAMPLE_SCREEN_ASSISTANT = `MODE: change

SUMMARY:
Added a dedicated Today screen distinct from the home view.

<change_context>
first_impact_step: screen
description: Add a separate "today" screen showing tasks due today, distinct from the home screen which would now act as a general dashboard.
</change_context>`;

export const PHASE2_CONVERSATION_EXAMPLE_SCREEN_TARGETED_USER =
  "The task-detail screen is missing a Mark complete button";

export const PHASE2_CONVERSATION_EXAMPLE_SCREEN_TARGETED_ASSISTANT = `MODE: change

SUMMARY:
Added a Mark complete button to the task-detail screen.

<change_context>
first_impact_step: wireframeHtml
first_impact_item: task-detail
description: Add a Mark complete toggle/button to the task-detail screen so the user can mark the task done from the detail view itself.
</change_context>`;

export const PHASE2_CONVERSATION_EXAMPLE_DATA_USER =
  "The example task names are too long, make them feel more like real one-line todos";

export const PHASE2_CONVERSATION_EXAMPLE_DATA_ASSISTANT = `MODE: change

SUMMARY:
Regenerated the sample task data with shorter, more realistic one-line todos.

<change_context>
first_impact_step: wireframeData
description: Regenerate the sample tasks with shorter, conversational one-line titles (e.g. "Buy groceries", "Reply to Anna"), keeping the same workflows and screens.
</change_context>`;

export const PHASE2_CONVERSATION_CORRECTIVE_HINT = (reason: string) =>
  `Your previous response was rejected. Reason: ${reason}

Reply ONLY with the required format.

For a question:

MODE: question

[plain prose answer]

For a change:

MODE: change

SUMMARY:
[one sentence, past tense]

<change_context>
first_impact_step: workflow|screen|wireframeData|wireframeHtml
first_impact_item: <fanout-item-id only when first_impact_step = wireframeHtml>
description: [factual description]
</change_context>

The first non-whitespace token MUST be "MODE:". No code fences, no preamble.`;

// ---------------------------------------------------------------------------
// 7. Drift check (M5) — separate LLM call after Phase 2 conversation.
// ---------------------------------------------------------------------------

export const DRIFT_CHECK_SYSTEM = `You are validating whether a requested change to a software product's design can be implemented without modifying the locked Project Contract.

You will be given:
- The locked Project Contract (inside <contract>...</contract>)
- The requested change description (inside <change>...</change>)

The Project Contract has four sections: Goal Statement, Personas, Entity Map, Boundaries. They define what the product IS. They were locked at the end of Phase 1 and cannot be modified during Phase 2 review.

Classify the change into ONE of three classifications:

COMPATIBLE — the change fits within the existing personas, entities, and boundaries. It only requires updating the Workflow Map and/or Screen Inventory. No contract modifications needed.

FLAG — the change is borderline. It might fit within the contract or might require modification — there's room for interpretation. The user should be warned and asked to confirm.

DRIFT — the change CANNOT be implemented without modifying the Project Contract. It introduces a new persona, requires a new entity, contradicts an existing boundary, or expands the goal beyond its current scope.

OUTPUT FORMAT — strict, exactly as shown.

For COMPATIBLE:

CLASSIFICATION: COMPATIBLE
REASON: [one-sentence justification — what existing personas/entities/boundaries support this change]

For FLAG:

CLASSIFICATION: FLAG
TYPE: SCOPE_EXPANSION
REASON: [one-sentence justification, citing what makes the change borderline]

For DRIFT:

CLASSIFICATION: DRIFT
TYPE: NEW_PERSONA|NEW_ENTITY|BOUNDARY_VIOLATION|GOAL_EXPANSION
REASON: [one-sentence justification, citing the specific contract section that would need to change]

CRITICAL RULES:
- The first non-whitespace token of your response MUST be "CLASSIFICATION:".
- Do not include any content before CLASSIFICATION: or any closing remarks after REASON.
- Do not invent issues that aren't real. If the change clearly fits the contract, it is COMPATIBLE.
- For DRIFT, the TYPE must be one of: NEW_PERSONA, NEW_ENTITY, BOUNDARY_VIOLATION, GOAL_EXPANSION.
- For FLAG, TYPE is always SCOPE_EXPANSION (the only borderline case we model).
- Do not wrap the response in code fences.`;

export const DRIFT_CHECK_EXAMPLE_USER = `<contract>
## Goal Statement
A lightweight personal task management app that helps individuals capture, organize, and track tasks across their day.

## Personas
**Individual User** — A single person managing their own to-do list.
Interaction type: Creates, edits, completes tasks; organizes them into lists; sets due dates and reminders.

## Entity Map
**Task** — A single actionable item with title, optional description, due date, status. Individual User creates, edits, marks complete.
**List** — A grouping of related tasks. Individual User creates, renames, archives, reorders.

## Boundaries
- No team / multi-user features
- No calendar integration
- No advanced project management
- No time tracking or billing
</contract>

<change>
Add team collaboration so coworkers can share lists with each other.
</change>`;

export const DRIFT_CHECK_EXAMPLE_ASSISTANT = `CLASSIFICATION: DRIFT
TYPE: BOUNDARY_VIOLATION
REASON: Sharing requires a second user role and multi-user functionality, which contradicts the "No team / multi-user features" boundary in the Project Contract.`;

export const DRIFT_CHECK_CORRECTIVE_HINT = (reason: string) =>
  `Your previous response was rejected. Reason: ${reason}

Reply ONLY with the required format:

CLASSIFICATION: COMPATIBLE | FLAG | DRIFT
TYPE: [only for FLAG or DRIFT]
REASON: [one sentence]

The first non-whitespace token MUST be "CLASSIFICATION:". No code fences, no preamble.`;
