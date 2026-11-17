import { getRun, updateRun, markRunActive } from "./store";
import { getProviderConfig } from "./providers";
import { fetchSnapshot } from "./github";
import { chatCompletion, extractJson, normalizeAnalysis, SYSTEM_PROMPT } from "./llm";
import type { ProviderConfig } from "./providers";

/**
 * Motor de análisis. Reparte los proyectos entre los proveedores configurados
 * con workers en paralelo: cada provider toma el siguiente proyecto disponible,
 * así cada cuota se consume a la mitad (o 1/N si hubiera N providers).
 */
export async function runAnalysis(runId: string): Promise<void> {
  markRunActive(runId, true);
  try {
    const run = getRun(runId);
    if (!run) return;

    const cfgs = run.providerIds
      .map((id) => getProviderConfig()[id])
      .filter((c): c is ProviderConfig => Boolean(c?.apiKey));

    if (cfgs.length === 0) {
      updateRun(runId, (r) => {
        r.status = "error";
        for (const p of r.projects) {
          p.status = "error";
          p.error = "Ningún proveedor configurado (faltan API keys en .env).";
        }
      });
      return;
    }

    // Contador compartido: cada worker toma el próximo índice libre
    let next = 0;

    const worker = async (cfg: ProviderConfig) => {
      for (;;) {
        const index = next++;
        const current = getRun(runId);
        if (!current || index >= current.projects.length) return;
        const project = current.projects[index];

        updateRun(runId, (r) => {
          const p = r.projects[index];
          p.status = "running";
          p.provider = cfg.id;
          p.model = cfg.model;
          p.startedAt = Date.now();
          p.error = undefined;
        });

        try {
          const snapshot = await fetchSnapshot(project.url);

          const userPrompt = `## Criterios del evaluador (organizadores del challenge)

${run.criteria}

## Proyecto a evaluar

${snapshot.text}

---
Evaluá el proyecto contra los criterios. Devolvé SOLO el JSON pedido.`;

          const raw = await chatCompletion(cfg, SYSTEM_PROMPT, userPrompt);
          const analysis = normalizeAnalysis(extractJson(raw));

          updateRun(runId, (r) => {
            const p = r.projects[index];
            p.status = "done";
            p.result = analysis;
            p.finishedAt = Date.now();
            p.repoInfo = {
              description: (snapshot.meta.description as string | null) ?? null,
              language: (snapshot.meta.language as string | null) ?? null,
              stars: Number(snapshot.meta.stars ?? 0),
              defaultBranch: String(snapshot.meta.defaultBranch ?? ""),
              filesRead: snapshot.filesRead,
              truncated: snapshot.truncated,
            };
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          updateRun(runId, (r) => {
            const p = r.projects[index];
            p.status = "error";
            p.error = msg;
            p.finishedAt = Date.now();
          });
        }
      }
    };

    await Promise.all(cfgs.map((cfg) => worker(cfg)));

    updateRun(runId, (r) => {
      r.status = "done";
    });
  } catch (e) {
    updateRun(runId, (r) => {
      r.status = "error";
      const msg = e instanceof Error ? e.message : String(e);
      for (const p of r.projects) {
        if (p.status === "pending" || p.status === "running") {
          p.status = "error";
          p.error = msg;
        }
      }
    });
  } finally {
    markRunActive(runId, false);
  }
}
