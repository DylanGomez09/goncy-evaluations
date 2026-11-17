import { NextRequest, NextResponse } from "next/server";
import { listRuns, insertRun } from "@/lib/store";
import { runAnalysis } from "@/lib/analyze";
import { getProviderConfig } from "@/lib/providers";
import type { ProviderId, Run } from "@/lib/types";
import crypto from "crypto";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function summarize(run: Run) {
  const done = run.projects.filter((p) => p.status === "done");
  const avg = done.length ? done.reduce((a, p) => a + (p.result?.overall ?? 0), 0) / done.length : null;
  return {
    id: run.id,
    createdAt: run.createdAt,
    status: run.status,
    criteria: run.criteria.slice(0, 140),
    providers: run.providerIds,
    total: run.projects.length,
    done: done.length,
    errors: run.projects.filter((p) => p.status === "error").length,
    average: avg,
  };
}

export async function GET() {
  const runs = listRuns();
  return NextResponse.json({ runs: runs.map(summarize) });
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body JSON inválido." }, { status: 400 });
  }
  const { links, criteria, providers } = body as {
    links?: Array<{ url: string; name?: string }>;
    criteria?: string;
    providers?: ProviderId[];
  };

  if (!Array.isArray(links) || links.length === 0) {
    return NextResponse.json({ error: "No se recibieron enlaces." }, { status: 400 });
  }
  if (!criteria || typeof criteria !== "string" || criteria.trim().length < 10) {
    return NextResponse.json({ error: "Escribí los criterios del análisis (mínimo 10 caracteres)." }, { status: 400 });
  }

  const requested = Array.isArray(providers) && providers.length > 0 ? providers : (Object.keys(getProviderConfig()) as ProviderId[]);
  const cfg = getProviderConfig();
  const usable = requested.filter((id) => cfg[id]?.apiKey);
  if (usable.length === 0) {
    return NextResponse.json({ error: "Ningún proveedor seleccionado tiene API key configurada en el .env." }, { status: 400 });
  }

  const run: Run = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    criteria: criteria.trim(),
    providerIds: usable,
    status: "running",
    projects: links.slice(0, 100).map((l, i) => ({
      id: `${i}-${crypto.randomUUID().slice(0, 8)}`,
      url: l.url,
      name: l.name,
      status: "pending",
    })),
  };

  insertRun(run);

  // Disparar el análisis en background (no bloquea la respuesta)
  runAnalysis(run.id).catch((e) => console.error("runAnalysis falló:", e));

  return NextResponse.json({ id: run.id });
}
