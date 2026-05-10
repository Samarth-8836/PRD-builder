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
 * Honors per-role env-var overrides:
 *   - Fast model:      OPENROUTER_FAST_MODEL / GROQ_FAST_MODEL
 *   - Reasoning model: OPENROUTER_REASONING_MODEL / GROQ_REASONING_MODEL
 * Falls back to the unsuffixed (OPENROUTER_MODEL / GROQ_MODEL) variable for
 * either role when the role-specific override is absent. This lets users
 * keep a single-model setup with the existing env vars while still being
 * able to opt into a faster model for short-form tasks (summarization,
 * diff summaries, drift checks) by setting LLM_*_FAST_MODEL.
 */
export function resolveModel(role: ModelRole = "reasoning"): ResolvedModel {
  const provider = (readEnv("LLM_PROVIDER") ?? "openrouter") as ProviderName;

  if (provider === "openrouter") {
    const roleSuffix = role === "fast" ? "FAST_MODEL" : "REASONING_MODEL";
    const modelId =
      readEnv(`OPENROUTER_${roleSuffix}`) ??
      readEnv("OPENROUTER_MODEL") ??
      "inclusionai/ling-2.6-1t:free";
    return {
      provider,
      baseUrl: readEnv("OPENROUTER_BASE_URL") ?? "https://openrouter.ai/api/v1",
      apiKey: requireEnv("OPENROUTER_API_KEY"),
      modelId,
    };
  }

  if (provider === "groq") {
    const roleSuffix = role === "fast" ? "FAST_MODEL" : "REASONING_MODEL";
    const modelId =
      readEnv(`GROQ_${roleSuffix}`) ??
      readEnv("GROQ_MODEL") ??
      "openai/gpt-oss-120b";
    return {
      provider,
      baseUrl: readEnv("GROQ_BASE_URL") ?? "https://api.groq.com/openai/v1",
      apiKey: requireEnv("GROQ_API_KEY"),
      modelId,
    };
  }

  throw new Error(`Unknown LLM_PROVIDER "${provider}". Use "openrouter" or "groq".`);
}
