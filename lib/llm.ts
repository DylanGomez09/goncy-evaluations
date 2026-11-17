import type { ProviderConfig } from "./providers";
import type { Analysis } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function backoffFromHeaders(res: Response): number {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (!Number.isNaN(secs)) return Math.min(Math.max(secs * 1000, 2000), 60_000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 2000), 60_000);
  }
  const reset = res.headers.get("x-ratelimit-reset-requests") || res.headers.get("x-ratelimit-reset-tokens");
  // formatos tipo "2m59s" o segundos
  if (reset) {
    const m = /(\d+(?:\.\d+)?)\s*(ms|s|m)?/.exec(reset);
    if (m) {
      const v = parseFloat(m[1]);
      const unit = m[2] || "s";
      const ms = unit === "ms" ? v : unit === "m" ? v * 60_000 : v * 1000;
      return Math.min(Math.max(ms, 2000), 60_000);
    }
  }
  return 15_000;
}

export interface ChatResult {
  content: string;
}

export async function chatCompletion(cfg: ProviderConfig, system: string, user: string): Promise<string> {
  const maxAttempts = 4;
  let lastError = "Error desconocido";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response | null = null;
    try {
      res = await fetch(`${cfg.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0.2,
          max_tokens: 2500,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (e) {
      lastError = `Red/timeout al llamar a ${cfg.name}: ${e instanceof Error ? e.message : String(e)}`;
      if (attempt < maxAttempts) {
        await sleep(5000 * attempt);
        continue;
      }
      throw new Error(lastError);
    }

    if (res.status === 429 || res.status === 413) {
      const wait = backoffFromHeaders(res);
      lastError = `${cfg.name}: rate limit (HTTP ${res.status}). Esperando ${Math.round(wait / 1000)}s…`;
      if (attempt < maxAttempts) {
        await sleep(wait);
        continue;
      }
      throw new Error(`${cfg.name} sigue con rate limit después de ${maxAttempts} intentos. Probá de nuevo más tarde o reducí la concurrencia.`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      lastError = `${cfg.name} HTTP ${res.status}: ${body.slice(0, 300)}`;
      // 4xx no reintentables (salvo 429/413 ya manejados, y 408)
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 409) {
        throw new Error(lastError);
      }
      if (attempt < maxAttempts) {
        await sleep(4000 * attempt);
        continue;
      }
      throw new Error(lastError);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error(`${cfg.name} devolvió una respuesta vacía.`);
    }
    return content;
  }
  throw new Error(lastError);
}

/** Extrae el primer objeto JSON del texto (tolera code fences y texto extra). */
export function extractJson(raw: string): unknown {
  let s = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(s.slice(start, end + 1));
    }
    throw new Error("La IA no devolvió JSON válido.");
  }
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === "string").map((x) => String(x).trim()).filter(Boolean).slice(0, 30);
}

export function normalizeAnalysis(raw: unknown): Analysis {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const scoresRaw = (obj.scores ?? {}) as Record<string, unknown>;
  const scores: Record<string, number> = {};
  for (const [k, v] of Object.entries(scoresRaw)) {
    const n = Number(v);
    if (!Number.isNaN(n)) scores[k] = Math.min(10, Math.max(0, Math.round(n * 10) / 10));
  }
  const overallNum = Number(obj.overall);
  return {
    overall: Number.isNaN(overallNum) ? 0 : Math.min(10, Math.max(0, Math.round(overallNum * 10) / 10)),
    verdict: typeof obj.verdict === "string" ? obj.verdict.slice(0, 80) : "sin veredicto",
    summary: typeof obj.summary === "string" ? obj.summary.slice(0, 2000) : "",
    strengths: asStringArray(obj.strengths),
    weaknesses: asStringArray(obj.weaknesses),
    redFlags: asStringArray(obj.redFlags),
    requirementsMet: asStringArray(obj.requirementsMet),
    requirementsMissing: asStringArray(obj.requirementsMissing),
    scores,
  };
}

export const SYSTEM_PROMPT = `Sos un evaluador técnico senior, estricto y justo, revisando un proyecto entregado para un challenge de programación.

Tu tarea: analizar el contenido del proyecto (código, README, configs o contenido web) y compararlo contra los requisitos que te da el evaluador humano.

Respondé EXCLUSIVAMENTE con un objeto JSON válido, sin markdown, con esta forma exacta:
{
  "overall": <número 0-10, nota global>,
  "verdict": "<aprobado | aceptable con reservas | rechazado>",
  "summary": "<2-4 frases con el diagnóstico general>",
  "strengths": ["..."],
  "weaknesses": ["..."],
  "redFlags": ["<problemas graves: seguridad, trampa, no es el trabajo del participante, etc.>"],
  "requirementsMet": ["<requisitos cumplidos, según el prompt de criterios>"],
  "requirementsMissing": ["<requisitos NO cumplidos o no verificables>"],
  "scores": { "<criterio corto>": <0-10> }
}

Reglas:
- Basate SOLO en la evidencia del contenido entregado. No inventes capacidades.
- Si algo no se puede verificar (ej: "deploy funcionando"), ponelo en requirementsMissing como "no verificable desde el contenido".
- Si el contenido está vacío, es un fork sin cambios, o no corresponde al challenge, decilo en redFlags y bajá la nota.
- Escribí en español. Sé concreto: citá archivos o patrones que viste.`;
