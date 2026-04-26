import { getPrompt } from "@/lib/prompts";
import { parseHtmlDocument, type ScreenSpec } from "@/lib/parsers";
import { execute } from "./executor";

interface RunInput {
  contract: string;
  screens: ScreenSpec[];
  signal?: AbortSignal;
}

/**
 * op-2-3b: generate index.html — the wireframe shell. Top-bar with the
 * product name, a `<nav>` linking to every screen, and a brief landing
 * message. Loads data.js so subsequent navigation can read window.DATA.
 */
export async function runWireframeShell(input: RunInput): Promise<string> {
  const prompt = getPrompt("phase2.wireframe_shell");
  const screensBlock = input.screens
    .map((s) => `- ${s.id} — ${s.purpose}`)
    .join("\n");

  const userBlock = `<contract>
${input.contract.trim()}
</contract>

<screens>
${screensBlock}
</screens>`;

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
