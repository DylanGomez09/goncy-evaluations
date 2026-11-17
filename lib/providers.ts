import type { ProviderId, ProviderInfo } from "./types";

export interface ProviderConfig {
  id: ProviderId;
  name: string;
  baseURL: string;
  model: string;
  apiKey: string | undefined;
}

function stripSlash(url: string) {
  return url.replace(/\/+$/, "");
}

export function getProviderConfig(): Record<ProviderId, ProviderConfig> {
  return {
    gemini: {
      id: "gemini",
      name: "Gemini (Google AI Studio)",
      baseURL: stripSlash(process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai/"),
      model: process.env.GEMINI_MODEL || "gemini-3.5-flash-lite",
      apiKey: process.env.GEMINI_API_KEY?.trim() || undefined,
    },
    groq: {
      id: "groq",
      name: "Groq",
      baseURL: stripSlash(process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1"),
      model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
      apiKey: process.env.GROQ_API_KEY?.trim() || undefined,
    },
  };
}

export function getProviderInfo(): ProviderInfo[] {
  const cfg = getProviderConfig();
  return (Object.values(cfg) as ProviderConfig[]).map((p) => ({
    id: p.id,
    name: p.name,
    configured: Boolean(p.apiKey),
    model: p.model,
  }));
}
