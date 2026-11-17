import * as storage from "./storage";
import { getProviderConfig } from "./providers";
import { fetchSnapshot } from "./github";
import { chatCompletion, extractJson, normalizeAnalysis, SYSTEM_PROMPT } from "./llm";
import type { ProjectResult } from "./types";

export interface TickResult {
  status: "running" | "done" | "not_found";
  claimed?: number;
  remaining?: number;
}

/**
 * Procesa UNA unidad de trabajo del run: toma el siguiente proyecto pendiente,
 * lo analiza completo (snapshot + LLM) y lo guarda. Pensada para correr dentro
 * de un request serverless — sin estado compartido en memoria.
 */
export async function tick(id: string): Promise<TickResult> {
  await storage.sweepStale(id);

  const { meta, index, project } = await storage.popPendingProject(id);
  if (!meta) return { status: "not_found" };
  if (index === null || !project) {
    const status = await storage.finalizeIfDone(id);
    return { status, remaining: await storage.countRemaining(id) };
  }

  const provider = meta.providerIds[index % meta.providerIds.length];
  const cfg = getProviderConfig()[provider];
  const base: ProjectResult = {
    ...project,
    status: "running",
    provider,
    model: cfg?.model,
    claimedAt: Date.now(),
    error: undefined,
  };

  // Marcar running manteniendo el lock
  await storage.setProjectOnly(id, index, base);

  try {
    if (!cfg?.apiKey) {
      throw new Error(`Falta API key para ${provider} en el .env`);
    }

    const snapshot = await fetchSnapshot(base.url, 20_000);

    const userPrompt = `## Criterios del evaluador (organizadores del challenge)

${meta.criteria}

## Proyecto a evaluar

${snapshot.text}

---
Evaluá el proyecto contra los criterios. Devolvé SOLO el JSON pedido.`;

    const raw = await chatCompletion(cfg, SYSTEM_PROMPT, userPrompt, { timeoutMs: 30_000, attempts: 2 });
    const analysis = normalizeAnalysis(extractJson(raw));

    await storage.saveProjectAndUnlock(id, index, {
      ...base,
      status: "done",
      result: analysis,
      finishedAt: Date.now(),
      repoInfo: {
        description: (snapshot.meta.description as string | null) ?? null,
        language: (snapshot.meta.language as string | null) ?? null,
        stars: Number(snapshot.meta.stars ?? 0),
        defaultBranch: String(snapshot.meta.defaultBranch ?? ""),
        filesRead: snapshot.filesRead,
        truncated: snapshot.truncated,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await storage.saveProjectAndUnlock(id, index, { ...base, status: "error", error: msg, finishedAt: Date.now() });
  }

  const status = await storage.finalizeIfDone(id);
  return { status, claimed: index, remaining: await storage.countRemaining(id) };
}
