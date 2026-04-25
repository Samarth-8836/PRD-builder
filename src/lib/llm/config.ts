export type ProviderName = "openrouter" | "groq";

export interface ResolvedModel {
  provider: ProviderName;
  baseUrl: string;
  apiKey: string;
  modelId: string;
}

export type ModelRole = "fast" | "reasoning";

function readEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

function requireEnv(name: string): string {
  const v = readEnv(name);
  if (!v) {
    throw new Error(
      `Missing env var ${name}. Copy .env.local.example to .env.local and fill it in.`
    );
  }
  return v;
}

/**
 * Resolves the active model for a given role.
 *
 * In iteration 1 the role is ignored (single model for everything). The
 * shape is kept so iteration 2 can introduce fast vs reasoning models and
 * the LLM Configuration store (Module 14) without changing callers.
 */
export function resolveModel(_role: ModelRole = "reasoning"): ResolvedModel {
  const provider = (readEnv("LLM_PROVIDER") ?? "openrouter") as ProviderName;

  if (provider === "openrouter") {
    return {
      provider,
      baseUrl: readEnv("OPENROUTER_BASE_URL") ?? "https://openrouter.ai/api/v1",
      apiKey: requireEnv("OPENROUTER_API_KEY"),
      modelId: readEnv("OPENROUTER_MODEL") ?? "inclusionai/ling-2.6-1t:free",
    };
  }

  if (provider === "groq") {
    return {
      provider,
      baseUrl: readEnv("GROQ_BASE_URL") ?? "https://api.groq.com/openai/v1",
      apiKey: requireEnv("GROQ_API_KEY"),
      modelId: readEnv("GROQ_MODEL") ?? "openai/gpt-oss-120b",
    };
  }

  throw new Error(`Unknown LLM_PROVIDER "${provider}". Use "openrouter" or "groq".`);
}
