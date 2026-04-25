# PRD-Builder

Chat-driven product-definition tool. Turns one sentence into a clickable HTML wireframe, via four artifacts: Project Contract -> Workflow Map -> Screen Inventory -> Wireframe.

See `build-product.md` for the full spec.

## Setup

```bash
npm install
cp .env.local.example .env.local
# fill in OPENROUTER_API_KEY or GROQ_API_KEY in .env.local
npm run dev
```

Open http://localhost:3000.

## Smoke test

With the dev server running:

```
GET http://localhost:3000/api/test-llm?q=say%20hello
```

Streams a completion from the configured provider as Server-Sent Events. If you see text chunks come back, the LLM wire works.

## Switching providers

Edit `.env.local`:

```
LLM_PROVIDER=groq    # or "openrouter"
```

No code change. No restart needed for env reload in Next dev.

## Current milestone

M0 - scaffolding + LLM smoke test. Phase 1 / Phase 2 logic comes in later milestones.
