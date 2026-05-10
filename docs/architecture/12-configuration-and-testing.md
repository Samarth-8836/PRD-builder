# Chapter 12 — Configuration and testing

Last touched: 2026-05-09 (M13).

## §12.1 Environment variables

All env vars are read from `.env.local` at the repo root in dev. In
production, the host's environment.

### LLM provider selection

| Var | Default | Purpose |
|---|---|---|
| `LLM_PROVIDER` | `openrouter` | One of `openrouter` or `groq`. Selects which provider's env vars are read. |

### OpenRouter

| Var | Default | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | (required) | Provider API key |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | Override for proxies |
| `OPENROUTER_MODEL` | `inclusionai/ling-2.6-1t:free` | Generic fallback model |
| `OPENROUTER_FAST_MODEL` | (falls back to `OPENROUTER_MODEL`) | Used when a step / op declares `role: "fast"` |
| `OPENROUTER_REASONING_MODEL` | (falls back to `OPENROUTER_MODEL`) | Used when a step / op declares `role: "reasoning"` (default) |

### Groq

| Var | Default | Purpose |
|---|---|---|
| `GROQ_API_KEY` | (required if `LLM_PROVIDER=groq`) | Provider API key |
| `GROQ_BASE_URL` | `https://api.groq.com/openai/v1` | Override |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | Generic fallback model |
| `GROQ_FAST_MODEL` / `GROQ_REASONING_MODEL` | (falls back to `GROQ_MODEL`) | Per-role overrides |

### Storage

There's no env var for storage path. `FileStorage` defaults to
`<repoRoot>/data/sessions/`. Override only by editing
`getStorage()` in `src/lib/storage/index.ts` (e.g., for a deployed
instance).

### Required env vars by scenario

**Local dev (free tier, single model):**
```
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-...
```

**Local dev (per-role split, mixed providers — not supported by
config; pick one provider):**
The provider applies to both roles. To use different providers per
role you'd need to extend `resolveModel`. Out of scope for now.

**Local dev (per-role split, same provider):**
```
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_FAST_MODEL=anthropic/claude-3-haiku
OPENROUTER_REASONING_MODEL=anthropic/claude-3-opus
```

`.env.local.example` (if present) lists these vars; copy to
`.env.local` and fill in.

## §12.2 Dev workflow

### Initial setup

```bash
npm install
cp .env.local.example .env.local   # then edit
mkdir -p data/sessions             # if it doesn't exist
```

### Running the dev server

```bash
npm run dev
# open http://localhost:3000
```

Hot reload works for everything except some Node-side caches (the
SessionManager singleton, the engine cache). If you change those,
restart.

### Type-checking

```bash
npm run typecheck
# or: npx tsc --noEmit
```

Run before every commit. The CI does too (in spirit — there's no real
CI in this repo).

### Production build

```bash
npm run build
# then to serve:
npm run start
```

### Pipeline unit tests

```bash
npm run test:pipeline
```

Runs the Node test runner over `src/lib/pipeline/__tests__/*.test.ts`.

Coverage:
- `topo.test.ts` — topo order, descendants, `nextRunnableStep`,
  validation (cycles, missing deps).
- `state.test.ts` — `describeLifecycle` edge cases.
- `preview.test.ts` — `previewCascade` impact computation.
- `fixture.ts` — a no-op pipeline fixture mirroring PRD's shape (4
  steps, 5 slots) used by all three test files. Real PRD pipeline
  isn't used in tests because instantiating it pulls in the prompts +
  operations which complicate the test loader.

30 tests across 7 suites. ~200ms total. No LLM calls.

If you add a new test: place it in `__tests__/`, use the fixture
unless you specifically need PRD or research-report. The fixture
exports `FIXTURE_STEP_IDS`, `FIXTURE_SLOT_IDS`, and
`makeFixturePipeline()`.

### Manual test guides

Every milestone (M1-M13) has a `docs/m{N}-manual-tests.md`. They
document what changed in that milestone and walk through the smoke
test the user runs before pushing to origin.

The pattern (use this for your own pipelines):
1. **What changed** — bullet list of new files / behaviors.
2. **What stays unchanged** — explicit non-changes (regression check
   anchor).
3. **Verification (no LLM calls)** — typecheck / tests / build.
4. **Test 1, Test 2, ...** — numbered manual scenarios.
5. **Known limitations** — what's intentionally out of scope.

## §12.3 Linting

The repo uses Next.js's bundled ESLint config:

```bash
npm run lint
```

The runner is interactive (prompts for setup) since Next 16
deprecation; in practice we don't run it as a hard gate.

## §12.4 Git workflow (per `project_git_workflow.md` in memory)

- One branch per milestone: `M<n>-<slug>` off the previous milestone.
- `main` stays at M7 until M13 is confirmed.
- Push to origin after the user smoke-tests each milestone.
- No force-pushes. No merges-into-main during the refactor (only
  fast-forward eventually).

## §12.5 Adding a new test

For pipeline-engine tests:
- File: `src/lib/pipeline/__tests__/<name>.test.ts`.
- Import the fixture, build the engine, exercise the public API.
- Use `node:assert/strict` and `node:test`.

For operation tests (currently none):
- Would require a mock LLM provider. Out of scope; manual tests cover
  this via end-to-end flow.

For UI tests (currently none):
- Out of scope. The app is small enough that manual smoke is faster
  than fixturing React Testing Library + a mock SSE stream.

## §12.6 Debugging

### Server-side
- `console.log` in route handlers + ops appears in the Next.js dev
  server output.
- LLM call payloads can be inspected by adding a `console.log` inside
  `streamCompletion` (`src/lib/llm/provider.ts`).
- Storage writes can be inspected by tail-ing
  `data/sessions/<id>.json` (it's pretty-printed JSON).

### Client-side
- Browser DevTools Network tab → look at the SSE response stream for
  `/api/chat`, `/api/approve`, etc.
- Zustand DevTools (browser extension) reads each store directly.
- The session JSON also matters client-side after `loadSession`.

### Specific scenarios
- "Cascade preview never appears": check the Network tab for the
  `cascade_preview` event. If absent, the drift check probably
  returned non-COMPATIBLE; check the `drift` event.
- "Tab pinned on wrong slot": `syncActiveTabToState` should fire on
  every meta + state event. Check the Network tab; if events are
  there, check the function logic.
- "Diff summaries never appear": `fireDiffSummary` is fire-and-forget.
  Check the dev server console for any `console.warn` from the
  swallowed errors. If LLM calls are failing, the diff summaries die
  silently.

## §12.7 Performance characteristics

The app is single-user. Performance budget is human-paced — no
concurrent requests, no scaling concerns.

- **Per-LLM-call latency** dominates. Free-tier models can take 5-30s
  per call. The fanout substeps (workflow_detail, screen_html) run
  serially (concurrency=1) for free-tier safety.
- **Storage writes** are sub-millisecond. JSON serialization +
  `fs.rename` is fast.
- **Engine computation** (topo, descendants, previewCascade) is O(N)
  in steps — negligible at any realistic pipeline size.
- **Session JSON size**: dominated by chat + slots. A complete PRD
  session is ~40-100 KB on disk. ChangeLog with diff summaries adds a
  few KB per cascade.

## §12.8 What CI should do (if added)

- `npm run typecheck` — must be clean.
- `npm run test:pipeline` — 30/30 must pass.
- `npm run build` — must succeed.
- Optionally lint.

There's no end-to-end test infra. Adding it would require a mock LLM
provider + Playwright setup; the cost-benefit hasn't justified it
yet for a single-user dev tool.

## §12.9 Deployment notes (if ever)

If deploying:
- Set `LLM_PROVIDER`, `LLM_*_API_KEY`, `LLM_*_MODEL` (or per-role
  variants) in the host env.
- Mount a persistent volume at `<repoRoot>/data/sessions/`. The
  app crashes on read errors but writes are atomic so concurrent
  rolling deploys don't corrupt files mid-write.
- Single-user concurrency is enforced in-process. Deploying multiple
  replicas would require an external lock (Redis, file-system
  lock, etc.). Not currently supported.
- `runtime: "nodejs"` everywhere — no edge-runtime adaptation needed
  / possible.
