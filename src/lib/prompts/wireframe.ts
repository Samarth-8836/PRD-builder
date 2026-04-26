/**
 * Phase 2 Stage 2 (Wireframe) prompts. Three LLM-driven steps:
 *   - dummy_data:      contract + screen inventory -> realistic sample JSON
 *   - wireframe_shell: contract + screen list -> index.html (top nav + landing)
 *   - screen_html:     one screen spec + data shape -> <screen-id>.html
 *
 * The shell + screens use a crude/wireframe aesthetic intentionally: system
 * fonts, gray borders, no decoration. The point is to verify structure,
 * not visual polish.
 *
 * The two "code-only" steps from the spec (smoke test, data.js assembly)
 * happen outside this file.
 */

// ---------------------------------------------------------------------------
// 1. Dummy data
// ---------------------------------------------------------------------------

export const DUMMY_DATA_SYSTEM = `You are generating realistic sample data for the entities of a software product. The data will populate a clickable wireframe so the user can see realistic content (not "Lorem ipsum" or "Item 1, Item 2, Item 3").

You will be given the Project Contract inside <contract>...</contract> and the Screen Inventory inside <screen_inventory>...</screen_inventory>.

OUTPUT FORMAT — strict JSON, exactly one object. No code fences, no prose, no preamble. The first non-whitespace character MUST be \`{\`.

The object has one key per entity defined in the contract's Entity Map. Each key is lowercase plural (e.g. "tasks", "lists", "users"). Each value is an array of 3 to 8 sample instances.

Each instance is an object with:
- "id": short kebab-case string (e.g. "t-001", "list-home")
- domain-appropriate fields named in lower_snake_case (e.g. "title", "description", "due_date", "status", "list_id")

Requirements:
- Content must feel real (e.g. "Buy groceries", "Finish the deck for Tuesday's meeting" — NOT "Task 1", "Sample Task A").
- Reference IDs across entities: a Task with list_id "list-home" must point at a real list in the lists array.
- Include a mix of states: some tasks done, some not; some past-due, some upcoming.
- Keep total output under ~120 lines of JSON to fit token limits.
- Output strict JSON only. No comments, no trailing commas, no JS expressions.`;

export const DUMMY_DATA_CORRECTIVE_HINT = (reason: string) =>
  `Your previous response was rejected. Reason: ${reason}

Reply ONLY with a single strict JSON object. The first non-whitespace character MUST be \`{\`. No code fences, no prose, no comments, no trailing commas.

Top-level keys are lowercase plural entity names. Each value is an array of 3-8 instances. Each instance has an "id" field.`;

// ---------------------------------------------------------------------------
// 2. Wireframe shell — index.html
// ---------------------------------------------------------------------------

export const WIREFRAME_SHELL_SYSTEM = `You are generating the index.html for a clickable wireframe of a software product. The page is the entry point — a top-level shell with global navigation and a brief landing message.

You will be given the Project Contract inside <contract>...</contract> and the list of screens (with ids and purposes) inside <screens>...</screens>.

OUTPUT FORMAT — strict HTML5, a single complete document. No prose, no preamble, no code fences. The first non-whitespace token MUST be \`<!doctype\` or \`<html\`.

The document MUST include:
- \`<!doctype html>\` and \`<html lang="en">\`
- \`<head>\` with \`<meta charset="utf-8">\`, a \`<title>\` derived from the Goal Statement, and a single \`<style>\` block of inline CSS
- \`<body>\` with:
  - a \`<header>\` containing the product name as an \`<h1>\`
  - a \`<nav>\` with one \`<a href="{screen-id}.html">\` per screen (use the screen's id as the href filename and its purpose as link text or title)
  - a \`<main>\` with a short welcome message ("Click a screen above to start")
  - \`<script src="data.js"></script>\` just before \`</body>\`

DESIGN — wireframe aesthetic, intentionally crude:
- System font: \`font-family: ui-sans-serif, system-ui, sans-serif;\`
- Light backgrounds, gray borders (\`#ddd\`, \`#999\`), no shadows or gradients
- Generous padding, simple block layout
- Nav links styled as bordered chips, not buttons
- No images, no SVG icons, no fancy hover effects

Output the HTML only. Nothing before \`<!doctype html>\` and nothing after \`</html>\`.`;

export const WIREFRAME_SHELL_CORRECTIVE_HINT = (reason: string) =>
  `Your previous response was rejected. Reason: ${reason}

Reply ONLY with a complete HTML5 document. The first non-whitespace token MUST be \`<!doctype\` or \`<html\`. The document must include \`<head>\`, \`<body>\`, \`<header>\`, \`<nav>\`, \`<main>\`, and \`<script src="data.js"></script>\`. Nothing before \`<!doctype html>\` and nothing after \`</html>\`.`;

// ---------------------------------------------------------------------------
// 3. Per-screen HTML
// ---------------------------------------------------------------------------

export const SCREEN_HTML_SYSTEM = `You are generating the static HTML for ONE screen of a clickable wireframe. The wireframe is intentionally crude — focus on structure, not visual polish.

You will be given:
- The Project Contract inside <contract>...</contract>
- The full list of screens (id + purpose) inside <screens>...</screens>
- The screen you are generating inside <screen>...</screen>, including its id, purpose, what it shows, and which screen ids it must navigate to (Nav)
- A summary of the dummy data shape inside <data_shape>...</data_shape> — keys with one example object each. The actual data is loaded at runtime from data.js as \`window.DATA\`.

OUTPUT FORMAT — strict HTML5, a single complete document. No prose, no preamble, no code fences. The first non-whitespace token MUST be \`<!doctype\` or \`<html\`.

The document MUST include:
- \`<!doctype html>\` and \`<html lang="en">\`
- \`<head>\` with \`<meta charset="utf-8">\`, a \`<title>\` like "{Product Name} — {screen purpose}", and a \`<style>\` block of inline CSS using the same crude wireframe aesthetic as the shell
- \`<body>\` with:
  - a \`<header>\` repeating the product name as an \`<h1>\` plus a top-level back link to \`index.html\`
  - a \`<nav>\` with one \`<a href="{nav-target}.html">\` per Nav target listed for this screen (so the user can move between screens)
  - a \`<main>\` containing the screen's specific content per its Purpose and Shows description
  - \`<script src="data.js"></script>\` immediately followed by an inline \`<script>\` that reads relevant arrays from \`window.DATA\` and renders them into the page (e.g. populates a \`<ul id="task-list">\` with one \`<li>\` per task). Use vanilla DOM API, no frameworks.

DESIGN — same crude wireframe aesthetic:
- System font, gray borders, generous padding, no images, no shadows
- List items as plain rows with a divider line, not cards with shadows
- Buttons styled as small bordered rectangles, not filled blue
- Form inputs are plain \`<input>\` and \`<textarea>\` with thin borders

CONTENT FAITHFULNESS:
- The Shows description tells you what data this screen displays. Render it from window.DATA.
- For terminal/modal screens with empty Nav, omit the \`<nav>\` block but keep the back-to-home link in the header.
- For screens that require user input (forms), include the visible inputs but the Submit button is just a non-functional placeholder — the wireframe is read-only.

Output the HTML only. Nothing before \`<!doctype html>\` and nothing after \`</html>\`.`;

export const SCREEN_HTML_CORRECTIVE_HINT = (reason: string) =>
  `Your previous response was rejected. Reason: ${reason}

Reply ONLY with a complete HTML5 document. The first non-whitespace token MUST be \`<!doctype\` or \`<html\`. The document must include \`<head>\`, \`<body>\`, \`<header>\`, \`<main>\`, and \`<script src="data.js"></script>\`. Nothing before \`<!doctype html>\` and nothing after \`</html>\`.`;
