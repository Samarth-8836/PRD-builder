# Chapter 05 — Prompts and parsers

Last touched: 2026-05-09 (M13).

The application's domain knowledge lives in two places:
1. **Prompts** (`src/lib/prompts/`) — what the LLM is told to do.
2. **Parsers** (`src/lib/parsers/`) — how the LLM's output is decoded
   into typed values.

Together they're the editable surface for renaming domain terms or
tweaking artifact structure. The framework code (engine, manager,
runners) doesn't know what "Project Contract" is — only the prompts +
parsers do.

## §5.1 Prompt registry

File: `src/lib/prompts/index.ts`.

```ts
type PromptSlug =
  | "phase1.first_message" | "phase1.conversation" | "phase1.title" | "phase1.validate"
  | "phase2.workflow_discovery" | "phase2.workflow_detail"
  | "phase2.screen_extract" | "phase2.nav_validate" | "phase2.screen_correct"
  | "phase2.conversation" | "phase2.drift_check"
  | "phase2.dummy_data" | "phase2.wireframe_shell" | "phase2.screen_html"
  | "summarize.chat_window" | "summarize.changelog_window" | "summarize.diff_summary"
  | "research_report.outline" | "research_report.section_draft" | "research_report.edit"
  | "research_report.review_chat" | "research_report.drift_check";

interface PromptSpec {
  system: string;
  fewShot?: { user: string; assistant: string }[];
  correctiveHint?: (reason: string) => string;
}

function getPrompt(slug: PromptSlug): PromptSpec;
```

Adding a new prompt = add to the slug union + add to the `REGISTRY`
object in `index.ts` + create the constants in the right per-domain
file (`phase1.ts`, `phase2.ts`, `wireframe.ts`, `summarize.ts`,
`research-report.ts`).

`getPrompt(slug)` throws on unknown slug. Unit tests over the registry
ensure every slug has a spec.

## §5.2 Per-domain prompt files

| File | Slugs | Pipeline |
|---|---|---|
| `phase1.ts` | `phase1.*` | PRD only |
| `phase2.ts` | `phase2.workflow_*`, `phase2.screen_*`, `phase2.nav_validate`, `phase2.conversation`, `phase2.drift_check` | PRD only |
| `wireframe.ts` | `phase2.dummy_data`, `phase2.wireframe_shell`, `phase2.screen_html` | PRD only |
| `summarize.ts` | `summarize.*` | All pipelines |
| `research-report.ts` | `research_report.*` | Research-report only |

The per-domain files export raw constants:
- `<NAME>_SYSTEM` — the system prompt body
- `<NAME>_EXAMPLE_USER` / `<NAME>_EXAMPLE_ASSISTANT` — few-shot pairs
- `<NAME>_CORRECTIVE_HINT(reason: string) => string` — corrective hint
  used by the executor on parse failure

These constants are imported into `index.ts` and assembled into
`PromptSpec` objects. The split keeps each prompt-set in its own file
without one giant index.

## §5.3 Prompt structure conventions

Every prompt's system text follows this loose template:
1. **Role** — "You are doing X for a software product / research
   report".
2. **Inputs** — describe each `<tag>...</tag>` block the user message
   will contain (`<contract>`, `<existing_workflows>`,
   `<change_history>`, `<user_feedback>`, etc.).
3. **Output format** — strict, with an example shape.
4. **Rules** — bullet list of requirements + don'ts.
5. (Sometimes) **Forbidden phrases** — "Do not include preambles like
   'Here is...'", "Do not wrap in code fences".

Few-shot examples use real-looking artifacts. PRD's discovery example
uses the canonical "todo app" contract; research-report's review-chat
examples use a remote-work-economics brief. Realistic > minimal.

`correctiveHint` is invoked on parse failure with the parser's
`error` string. The hint should re-state the format requirements
tersely — not just echo the system prompt. Example:
```
Re-output the response using the strict format:
- For questions: "MODE: question" then a blank line then prose.
- For changes: "MODE: change" then SUMMARY: + sentence + <change_context> block.
No code fences, no preamble.
```

## §5.4 The change-history block

Step prompts that re-run during a cascade get a `<change_history>`
block in the user message. Built by each pipeline's `renderChangeHistory`
helper (a private function in the pipeline config file). Format:

```
<change_history>
Summary of older changes: <rolling summary>

Recent changes:
- <description> (first impact: <stepId>[:<itemId>])
- ...
</change_history>
```

Step prompts treat every entry as a binding requirement: "do not undo
any prior change unless `<user_feedback>` explicitly contradicts it".
This is how user customizations from earlier cascades survive later
regenerations.

## §5.5 Pipeline review-chat config (`buildSystemContext`)

The phase2.conversation / research_report.review_chat prompts have
their few-shots reference specific tag names (`<project_contract>`,
`<workflow_map>`, etc.). The runtime injection of those tags comes
from `pipeline.reviewChat.buildSystemContext(slots)`.

Each pipeline defines this function in its config file. Output is a
string appended to the prompt's `system`. PRD's:
```ts
buildSystemContext: (slots) => `

<project_contract>
${getMarkdownContent(slots, SLOT_PROJECT_CONTRACT)?.trim() ?? ""}
</project_contract>

<workflow_map>...</workflow_map>
... etc.
`
```

If absent: `op-2-9-conversation.ts` falls back to dumping every
populated markdown slot as `<{slotId}>...</{slotId}>`. Acceptable for
quick prototyping but not what the prompt's few-shots will agree with
— provide `buildSystemContext` for any pipeline whose review-chat
prompt expects specific tag names.

## §5.6 Parser registry

Files: `src/lib/parsers/`.

There's no parser registry per se — parsers are imported by name
where needed. The shared types are in `parsers/types.ts`:

```ts
type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const ok = <T>(value: T) => ({ ok: true, value });
const fail = <T = never>(error: string) => ({ ok: false, error });
```

Every parser is `(text: string) => ParseResult<T>`. The executor's
corrective-retry path uses `error` verbatim as the reason — write
errors as instructions ("Expected X header, got Y") not as accusations
("invalid output").

## §5.7 Per-domain parser files

| File | Parses |
|---|---|
| `parsers/contract.ts` | `parseContract(text)` — extracts goal/personas/entityMap/boundaries from the contract markdown |
| `parsers/first-message.ts` | `parseFirstMessage(text)` — `{ summary, contract }` from op-1-0's two-section output |
| `parsers/conversation.ts` | `parseConversationResponse(text)` — `{ mode, answer | summary, contract }` for op-1-1 |
| `parsers/title.ts` | `parseTitle(text)` — trimmed 2-4 word title |
| `parsers/validation.ts` | `parseValidationResult(text)` — `{ status, issues, suggestions }` |
| `parsers/phase2.ts` | `parseWorkflowStubs`, `parseWorkflowDetail`, `parseScreens`, `parseNavValidation`, `parseScreenInventoryDoc` (re-parses the formatted markdown back into ScreenSpec[]), `parseDriftCheck` |
| `parsers/phase2-review.ts` | `parsePhase2Conversation(text, opts)` — `{ mode, answer | summary, description, firstImpactStepId, firstImpactItemId }`. `opts.knownStepIds` validates the step id is one the engine knows. |
| `parsers/wireframe.ts` | `parseDummyData`, `parseHtmlDocument`, `finalizeScreenList` |
| `parsers/research-report.ts` | `parseOutline`, `parseSection`, plus the `OutlineSection` type |

All parsers also export their target types (`ScreenSpec`,
`WorkflowDetail`, `OutlineSection`, etc.) so call-sites can refer to
them.

`parsers/index.ts` is a barrel file: `export * from "./contract"` etc.
All parser imports go through `@/lib/parsers`.

## §5.8 Markdown shape conventions

Most parsers operate on markdown the LLM produces. Conventions:

- **Section headers**: `## <id> — <title>` for outline-style lists
  where each item has a stable id. The em-dash separator is conventional;
  parsers also accept ` - ` and ` : ` as separators (defensive).
- **Bullet lists**: `- **<Name>** — <description>` pattern for
  workflow stubs / screen entries.
- **Multi-section docs**: `**<Section>**` (bold) followed by a body. Used
  by workflow_detail (Pre-conditions / Steps / Exit criteria / Edge cases).
- **Strict markdown**: No code fences around output (LLMs love to wrap
  in ```markdown ... ```). Every prompt explicitly forbids this; parsers
  defensively strip code fences anyway.

## §5.9 When to write a new parser

- The output is a structured shape downstream code reads (a workflow
  list, an outline, a JSON object). Parser belongs in
  `parsers/<domain>.ts`.
- The output is a free-form artifact (the section body, the final
  report text). A trivial trim parser (`(text) => ok(text.trim())`)
  inline in the runner config is fine — see research-report's `edit`
  step.

## §5.10 Why prompts and parsers aren't co-located with steps

A pipeline config could in principle inline its prompts and parsers,
but they're kept separate for two reasons:
1. **Diff hygiene**: Tweaking a prompt is a high-frequency operation.
   Keeping prompts in their own file means a config diff stays small
   and reviewable.
2. **Reuse**: `phase2.conversation` is shared across cascade-trigger
   paths; `summarize.diff_summary` is shared by every pipeline. A
   per-step inlining would force duplication.

The pipeline config references prompts by slug (a `PromptSlug` string
literal). That coupling — slug in config, slug in registry — is the
seam.
