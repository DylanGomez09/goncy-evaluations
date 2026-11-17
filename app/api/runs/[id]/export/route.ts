import { NextRequest, NextResponse } from "next/server";
import { getRun } from "@/lib/store";

export const dynamic = "force-dynamic";

function csvEscape(v: unknown): string {
  const s = String(v ?? "");
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function verdictRank(p: { result?: { overall: number } }): number {
  return p.result?.overall ?? -1;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const format = req.nextUrl.searchParams.get("format") ?? "json";
  const run = getRun(id);
  if (!run) return NextResponse.json({ error: "Run no encontrado." }, { status: 404 });

  const sorted = [...run.projects].sort((a, b) => verdictRank(b) - verdictRank(a));

  if (format === "csv") {
    const header = [
      "rank", "url", "nombre", "proveedor", "modelo", "overall_0_10", "veredicto",
      "requisitos_cumplidos", "requisitos_faltantes", "red_flags", "resumen",
    ];
    const lines = [header.join(",")];
    sorted.forEach((p, i) => {
      const r = p.result;
      lines.push(
        [
          i + 1,
          csvEscape(p.url),
          csvEscape(p.name),
          csvEscape(p.provider),
          csvEscape(p.model),
          r ? r.overall : "",
          csvEscape(r?.verdict),
          csvEscape(r?.requirementsMet.join(" | ")),
          csvEscape(r?.requirementsMissing.join(" | ")),
          csvEscape(r?.redFlags.join(" | ")),
          csvEscape(r?.summary),
        ].join(",")
      );
    });
    return new NextResponse(lines.join("\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="goncy-evaluations-${run.id.slice(0, 8)}.csv"`,
      },
    });
  }

  if (format === "md") {
    const lines: string[] = [
      `# Goncy Evaluations — reporte ${new Date(run.createdAt).toLocaleString("es-AR")}`,
      "",
      `**Proveedores:** ${run.providerIds.join(", ")}`,
      "",
      "## Criterios",
      "",
      run.criteria,
      "",
      "## Ranking",
      "",
      "| # | Proyecto | Nota | Veredicto | Proveedor |",
      "|---|---|---|---|---|",
    ];
    sorted.forEach((p, i) => {
      const name = p.name ?? p.url.replace(/^https?:\/\//, "");
      lines.push(`| ${i + 1} | [${name}](${p.url}) | ${p.result ? p.result.overall : "—"} | ${p.result?.verdict ?? p.status} | ${p.provider ?? ""} |`);
    });
    lines.push("", "## Detalle por proyecto", "");
    for (const p of sorted) {
      lines.push(`### ${p.name ?? p.url} — ${p.result ? `${p.result.overall}/10 (${p.result.verdict})` : `sin análisis (${p.status})`}`);
      lines.push(`- URL: ${p.url}`);
      if (p.provider) lines.push(`- Analizado por: ${p.provider} (${p.model ?? ""})`);
      if (p.error) lines.push(`- Error: ${p.error}`);
      if (p.result) {
        lines.push(`- Resumen: ${p.result.summary}`);
        if (p.result.strengths.length) {
          lines.push("- Fortalezas:");
          p.result.strengths.forEach((s) => lines.push(`  - ${s}`));
        }
        if (p.result.weaknesses.length) {
          lines.push("- Debilidades:");
          p.result.weaknesses.forEach((s) => lines.push(`  - ${s}`));
        }
        if (p.result.requirementsMet.length) {
          lines.push("- Requisitos cumplidos:");
          p.result.requirementsMet.forEach((s) => lines.push(`  - ${s}`));
        }
        if (p.result.requirementsMissing.length) {
          lines.push("- Requisitos NO cumplidos / no verificables:");
          p.result.requirementsMissing.forEach((s) => lines.push(`  - ${s}`));
        }
        if (p.result.redFlags.length) {
          lines.push("- 🚩 Red flags:");
          p.result.redFlags.forEach((s) => lines.push(`  - ${s}`));
        }
        if (Object.keys(p.result.scores).length) {
          lines.push("- Notas por criterio:");
          for (const [k, v] of Object.entries(p.result.scores)) lines.push(`  - ${k}: ${v}/10`);
        }
      }
      lines.push("");
    }
    return new NextResponse(lines.join("\n"), {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="goncy-evaluations-${run.id.slice(0, 8)}.md"`,
      },
    });
  }

  // json
  return new NextResponse(JSON.stringify(run, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="goncy-evaluations-${run.id.slice(0, 8)}.json"`,
    },
  });
}
