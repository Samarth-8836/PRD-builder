import { getPrompt } from "@/lib/prompts";
import {
  parseHtmlDocument,
  type DummyData,
  type ScreenSpec,
} from "@/lib/parsers";
import { execute } from "./executor";

interface RunInput {
  contract: string;
  screens: ScreenSpec[];
  screen: ScreenSpec;
  data: DummyData;
  signal?: AbortSignal;
}

/**
 * op-2-3c: generate the static HTML for ONE screen. Called once per
 * screen by the wireframe stage runner, fanned out via Module 9 (DAG)
 * with bounded concurrency for free-tier TPM safety.
 *
 * The model receives a *shape summary* of the dummy data (one example
 * instance per entity) rather than the full payload — that's enough for
 * it to write the inline JS that reads from window.DATA, and keeps the
 * per-call token cost low.
 */
export async function runScreenHtml(input: RunInput): Promise<string> {
  const prompt = getPrompt("phase2.screen_html");
  const screensBlock = input.screens
    .map((s) => `- ${s.id} — ${s.purpose}`)
    .join("\n");

  const navTargets = input.screen.nav.length === 0 ? "(none)" : input.screen.nav.join(", ");
  const screenBlock = `id: ${input.screen.id}
purpose: ${input.screen.purpose}
shows: ${input.screen.shows}
nav: ${navTargets}`;

  const dataShape = formatDataShape(input.data);

  const userBlock = `<contract>
${input.contract.trim()}
</contract>

<screens>
${screensBlock}
</screens>

<screen>
${screenBlock}
</screen>

<data_shape>
${dataShape}
</data_shape>`;

  const { value } = await execute({
    system: prompt.system,
    messages: [{ role: "user", content: userBlock }],
    correctiveHint: prompt.correctiveHint,
    parser: parseHtmlDocument,
    signal: input.signal,
    maxAttempts: 2,
  });
  return value;
}

/**
 * Compact JSON snapshot of the dummy data showing one example per entity.
 * Keeps per-call tokens small while letting the model see the keys it can
 * reach via window.DATA. Includes the array length so the model knows
 * how many instances will exist at runtime.
 */
function formatDataShape(data: DummyData): string {
  const lines: string[] = ["{"];
  const keys = Object.keys(data);
  keys.forEach((k, i) => {
    const v = data[k];
    if (Array.isArray(v) && v.length > 0) {
      const sample = JSON.stringify(v[0], null, 2);
      lines.push(`  "${k}": [ /* ${v.length} items, e.g. */ ${sample}${i < keys.length - 1 ? "," : ""}`);
      lines.push(`  ]`);
    } else {
      const valStr = JSON.stringify(v, null, 2);
      lines.push(`  "${k}": ${valStr}${i < keys.length - 1 ? "," : ""}`);
    }
  });
  lines.push("}");
  return lines.join("\n");
}
