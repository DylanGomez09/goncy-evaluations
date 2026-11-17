"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { extractLinksFromCsv, extractLinksFromText, type ParsedLink } from "@/lib/csvparse";
import type { Run, ProjectResult } from "@/lib/types";

interface ProviderInfo {
  id: "gemini" | "groq";
  name: string;
  configured: boolean;
  model: string;
}
interface RunSummary {
  id: string;
  createdAt: number;
  status: string;
  criteria: string;
  providers: string[];
  total: number;
  done: number;
  errors: number;
  average: number | null;
}

const CRITERIA_PLACEHOLDER = `Ejemplo:
- ¿Cumple todos los requisitos del enunciado del challenge?
- ¿Funciona? ¿El código está completo o es un esqueleto?
- ¿Usa TypeScript correctamente?
- ¿La UI es decente / responsive?
- ¿Hay tests o al menos estructura clara (components, hooks)?
- ¿README explica cómo correrlo?
- Señales de copiado/pega sin entender, código muerto, hacks sucios.`;

const CRITERIA_EXAMPLE = `Evaluá el proyecto entregado para el challenge de programación. Criterios:

1. Cumplimiento de requisitos: el proyecto hace lo que pedía el enunciado (no inventar features ni faltar las esenciales).
2. Funciona y está completo: no es un esqueleto ni tiene partes rotas/hardcodeadas.
3. Calidad de código: estructura, nombres, tipado, manejo de errores, ausencia de hacks.
4. UI/UX: es usable, responsive, con estados de carga/error razonables.
5. DX: README con instrucciones, scripts correctos, dependencias justificadas.
6. Red flags: forks sin cambios, código generado sin entender, secretos commiteados, trampas.

Sé estricto pero justo. Citá archivos concretos como evidencia.`;

function scoreClass(n: number) {
  if (n >= 7) return "score-high";
  if (n >= 4) return "score-mid";
  return "score-low";
}

export default function Home() {
  const [pasteText, setPasteText] = useState("");
  const [csvLinks, setCsvLinks] = useState<ParsedLink[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [criteria, setCriteria] = useState("");
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<Run | null>(null);
  const [sortKey, setSortKey] = useState<"overall" | "name" | "provider">("overall");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [lanes, setLanes] = useState(1);
  const [retryNonce, setRetryNonce] = useState(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);

  const links = useMemo(() => {
    const fromText = extractLinksFromText(pasteText);
    const seen = new Set<string>();
    const out: ParsedLink[] = [];
    for (const l of [...fromText, ...csvLinks]) {
      const k = l.url.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(l);
    }
    return out;
  }, [pasteText, csvLinks]);

  const refreshHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/runs");
      if (!res.ok) return;
      const data = await res.json();
      setRuns(data.runs ?? []);
    } catch { /* sin conexión */ }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/providers");
        const data = await res.json();
        setProviders(data.providers ?? []);
        const sel: Record<string, boolean> = {};
        for (const p of data.providers ?? []) sel[p.id] = p.configured;
        setSelected(sel);
      } catch { /* */ }
    })();
    refreshHistory();
  }, [refreshHistory]);

  // Procesamiento client-driven: 1 lane por IA elegida, cada tick procesa 1 proyecto
  useEffect(() => {
    if (!activeRunId) return;
    if (!activeRun || activeRun.status !== "running") return;
    let cancelled = false;
    const laneCount = Math.max(1, lanes);
    const lane = async () => {
      for (let i = 0; i < 500 && !cancelled; i++) {
        try {
          const res = await fetch(`/api/runs/${activeRunId}/tick`, { method: "POST" });
          if (!res.ok) {
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          const data = await res.json();
          if (data?.status === "done") break;
          await new Promise((r) => setTimeout(r, data?.claimed === undefined ? 1500 : 250));
        } catch {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    };
    Array.from({ length: laneCount }, lane);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRunId, retryNonce, activeRun?.status, lanes]);

  // Polling del run activo hasta que termine
  useEffect(() => {
    if (!activeRunId) return;
    let cancelled = false;
    const fetchRun = async () => {
      try {
        const res = await fetch(`/api/runs/${activeRunId}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setActiveRun(data.run);
        if (data.run?.status !== "running") refreshHistory();
      } catch { /* */ }
    };
    fetchRun();
    if (!activeRun || activeRun.status === "running") {
      const t = setInterval(fetchRun, 2000);
      return () => {
        cancelled = true;
        clearInterval(t);
      };
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRunId, activeRun?.status]);

  const handleFile = useCallback((file: File) => {
    file.text().then((text) => {
      const parsed = extractLinksFromCsv(text);
      setCsvLinks(parsed);
      setFileName(`${file.name} — ${parsed.length} enlaces detectados`);
      if (parsed.length === 0) showToast("No encontré enlaces en ese CSV. ¿Tiene una columna url/link/enlace?");
    });
  }, [showToast]);

  const toggleSort = (key: "overall" | "name" | "provider") => {
    if (sortKey === key) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(key === "overall" ? -1 : 1);
    }
  };

  const sortedProjects = useMemo(() => {
    const ps = activeRun ? [...activeRun.projects] : [];
    ps.sort((a, b) => {
      if (sortKey === "overall") {
        const av = a.result?.overall ?? -1;
        const bv = b.result?.overall ?? -1;
        return (av - bv) * sortDir;
      }
      if (sortKey === "name") {
        return (a.name ?? a.url).localeCompare(b.name ?? b.url) * sortDir;
      }
      return String(a.provider ?? "").localeCompare(String(b.provider ?? "")) * sortDir;
    });
    return ps;
  }, [activeRun, sortKey, sortDir]);

  const rankOf = useMemo(() => {
    const m = new Map<string, number>();
    const byScore = [...(activeRun?.projects ?? [])].sort((a, b) => (b.result?.overall ?? -1) - (a.result?.overall ?? -1));
    byScore.forEach((p, i) => m.set(p.id, i + 1));
    return m;
  }, [activeRun]);

  const startAnalysis = async () => {
    if (links.length === 0) return showToast("Pegá enlaces o subí un CSV primero.");
    if (criteria.trim().length < 10) return showToast("Escribí los criterios de análisis (mínimo 10 caracteres).");
    const chosen = providers.filter((p) => p.configured && selected[p.id]).map((p) => p.id);
    if (chosen.length === 0) return showToast("Elegí al menos una IA configurada (revisá las API keys en .env).");

    setStarting(true);
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ links, criteria: criteria.trim(), providers: chosen }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error ?? "No se pudo iniciar el análisis.");
        return;
      }
      setActiveRunId(data.id);
      setActiveRun(null);
      setExpanded(null);
      setLanes(chosen.length);
      showToast(`Análisis iniciado con ${chosen.join(" + ")} — ${links.length} proyectos. Los reparte entre las IAs elegidas.`);
      refreshHistory();
    } catch {
      showToast("Error de red al iniciar el análisis.");
    } finally {
      setStarting(false);
    }
  };

  const deleteRunById = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await fetch(`/api/runs/${id}`, { method: "DELETE" });
    if (activeRunId === id) {
      setActiveRunId(null);
      setActiveRun(null);
    }
    refreshHistory();
  };

  const progress = activeRun ? { done: activeRun.projects.filter((p) => p.status === "done" || p.status === "error").length, total: activeRun.projects.length } : null;
  const avg = activeRun ? (() => {
    const d = activeRun.projects.filter((p) => p.result);
    return d.length ? d.reduce((a, p) => a + (p.result?.overall ?? 0), 0) / d.length : null;
  })() : null;

  return (
    <main className="container">
      <header className="app">
        <div className="brand">
          <div className="logo" aria-hidden="true">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
              <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" stroke="#fff" strokeWidth="1.6" strokeLinecap="round"/>
              <rect x="9" y="3" width="6" height="4" rx="1.2" fill="#fff" fillOpacity="0.95"/>
              <path d="M9.5 13.5l2 2 3.5-4" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <div>
            <h1>Goncy<span>Evaluations</span></h1>
            <p>Subí el CSV con los enlaces, definí los criterios y dejá que una o dos IAs hagan el primer review de cada proyecto.</p>
          </div>
        </div>
        <span className="badge"><span className="pulse" /> GitHub público · multi-IA en paralelo</span>
      </header>

      <div className="steps" aria-hidden="true">
        <div className="step"><span className="n">1</span> Subí el CSV o pegá los enlaces</div>
        <div className="step"><span className="n">2</span> Escribí qué debe analizar la IA</div>
        <div className="step"><span className="n">3</span> Las IAs reparten los proyectos</div>
        <div className="step"><span className="n">4</span> Ranking, reportes y exportación</div>
      </div>

      <div className="grid">
        {/* ============ Panel izquierdo: nuevo análisis ============ */}
        <section className="card">
          <div className="card-title-row"><h2>Nuevo análisis</h2><span className="step-tag">setup</span></div>
          <p className="hint">Pegá los enlaces (uno por línea) y/o subí un CSV con una columna <strong>url</strong> / <strong>link</strong> / <strong>enlace</strong> (nombre opcional). Se deduplican automáticamente.</p>

          <label className="fld" htmlFor="links">Enlaces</label>
          <textarea
            id="links"
            className="mono"
            rows={6}
            placeholder={"https://github.com/usuario/proyecto-1\nhttps://github.com/usuario/proyecto-2\nhttps://mi-demo.vercel.app"}
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
          />

          <div
            className={`dropzone ${dragOver ? "drag" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files?.[0];
              if (f) handleFile(f);
            }}
            onClick={() => document.getElementById("csv-input")?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") document.getElementById("csv-input")?.click(); }}
          >
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 16V4m0 0L8 8m4-4l4 4" stroke="#8b94a7" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M4 15v3a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-3" stroke="#8b94a7" strokeWidth="1.6" strokeLinecap="round"/>
            </svg>
            <strong>Subí el CSV</strong> o arrastralo acá<br />
            <span style={{ fontSize: 11 }}>detecta delimitador , o ; — columna url/link/enlace (+ nombre/autor opcional)</span>
            {fileName && <div className="file">✓ {fileName}</div>}
            <input
              id="csv-input"
              type="file"
              accept=".csv,text/csv,text/plain"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
                e.target.value = "";
              }}
            />
          </div>

          {links.length > 0 && (
            <>
              <div className="count-pill">{links.length} enlace{links.length === 1 ? "" : "s"} listo{links.length === 1 ? "" : "s"} para analizar</div>
              <div className="link-preview">
                {links.slice(0, 24).map((l) => (
                  <span key={l.url} className="chip" title={l.url}>{l.name ? `${l.name} — ` : ""}{l.url.replace(/^https?:\/\//, "")}</span>
                ))}
                {links.length > 24 && <span className="chip">+{links.length - 24} más…</span>}
              </div>
            </>
          )}

          <label className="fld" htmlFor="criteria" style={{ marginTop: 18 }}>¿Qué tiene que analizar la IA? (criterios / requisitos del challenge)</label>
          <textarea
            id="criteria"
            rows={7}
            placeholder={CRITERIA_PLACEHOLDER}
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
          />
          <button type="button" className="btn-sm" style={{ marginTop: 8 }} onClick={() => setCriteria(CRITERIA_EXAMPLE)}>
            Cargar criterios de ejemplo
          </button>

          <label className="fld" style={{ marginTop: 18 }}>IAs a usar (reparte los proyectos entre ellas para no quemar la cuota de cada una)</label>
          <div className="providers">
            {providers.map((p) => (
              <label
                key={p.id}
                className={`provider ${p.configured ? (selected[p.id] ? "enabled" : "") : "disabled"}`}
                title={p.configured ? "Activada para este análisis" : "Falta la API key en el .env.local"}
              >
                <input
                  type="checkbox"
                  disabled={!p.configured}
                  checked={Boolean(selected[p.id]) && p.configured}
                  onChange={(e) => setSelected((s) => ({ ...s, [p.id]: e.target.checked }))}
                />
                <span>
                  <span className="p-row"><span className={`ai-dot ai-${p.id}`} /><span className="p-name">{p.name}</span></span>
                  <br />
                  <span className="p-model">{p.model}</span>
                  <div className={`p-state ${p.configured ? "ok" : "missing"}`}>
                    {p.configured ? "✓ API key cargada" : "⚠ falta API key en .env"}
                  </div>
                </span>
              </label>
            ))}
            {providers.length === 0 && <div className="hint">Cargando proveedores…</div>}
          </div>

          <button className="primary" onClick={startAnalysis} disabled={starting || links.length === 0}>
            {starting ? "Iniciando…" : `Analizar ${links.length || ""} proyecto${links.length === 1 ? "" : "s"} →`}
          </button>
        </section>

        {/* ============ Panel derecho: historial ============ */}
        <aside className="card">
          <div className="result-header">
            <div className="card-title-row" style={{ margin: 0 }}><h2>Historial</h2><span className="step-tag">local</span></div>
            <button className="btn-sm" onClick={refreshHistory}>↻ Actualizar</button>
          </div>
          <p className="hint">Las corridas quedan guardadas localmente en <code>.data/db.json</code>. Podés reabrirlas, compararlas o borrarlas.</p>
          <div className="history">
            {runs.length === 0 && (
              <div className="empty">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" style={{ margin: "0 auto 10px", opacity: .55 }} aria-hidden="true">
                  <path d="M3 7a2 2 0 0 1 2-2h6l2 2h6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" stroke="#8b94a7" strokeWidth="1.5" strokeLinejoin="round"/>
                  <path d="M9.5 13.5l1.8 1.8 3.2-3.6" stroke="#8b94a7" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Todavía no hay corridas.<br />Subí un CSV y lanzá la primera.
              </div>
            )}
            {runs.map((r) => (
              <div
                key={r.id}
                className={`history-item ${activeRunId === r.id ? "active" : ""}`}
                onClick={() => { setActiveRunId(r.id); setExpanded(null); }}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter") { setActiveRunId(r.id); setExpanded(null); } }}
              >
                <div className="row">
                  <span className="date">{new Date(r.createdAt).toLocaleString("es-AR")}</span>
                  <button className="icon-btn" title="Borrar corrida" onClick={(e) => deleteRunById(r.id, e)}>🗑</button>
                </div>
                <div className="meta">
                  {r.done}/{r.total} analizados · {r.errors} errores · promedio {r.average !== null ? r.average.toFixed(1) : "—"} · [{r.providers.join(" + ")}]
                  {r.status === "running" ? " · ⏳ en curso…" : ""}
                </div>
              </div>
            ))}
          </div>
        </aside>
      </div>

      {/* ============ Resultados ============ */}
      {activeRun && (
        <section className="card results">
          <div className="result-header">
            <div>
              <div className="card-title-row"><h2>Resultado</h2><span className="step-tag">{activeRun.status === "running" ? "en curso" : "finalizado"}</span></div>
              <p className="hint" style={{ margin: 0 }}>{new Date(activeRun.createdAt).toLocaleString("es-AR")} · {activeRun.status === "running" ? "Analizando… (se actualiza solo)" : "Análisis terminado."} Click en una fila para ver el reporte completo.</p>
            </div>
            <div className="exports">
              {activeRun.status === "done" && activeRun.projects.some((p) => p.status === "error") && (
                <button
                  className="btn-sm"
                  onClick={async () => {
                    const r = await fetch(`/api/runs/${activeRun.id}/retry`, { method: "POST" });
                    const d = await r.json();
                    showToast(`${d.requeued} proyecto(s) re-encolados para reanálisis`);
                    setRetryNonce((n) => n + 1);
                    refreshHistory();
                  }}
                >
                  ↻ Reintentar fallidos ({activeRun.projects.filter((p) => p.status === "error").length})
                </button>
              )}
              <a className="btn-sm" href={`/api/runs/${activeRun.id}/export?format=csv`}>⬇ CSV</a>
              <a className="btn-sm" href={`/api/runs/${activeRun.id}/export?format=md`}>⬇ Markdown</a>
              <a className="btn-sm" href={`/api/runs/${activeRun.id}/export?format=json`}>⬇ JSON</a>
            </div>
          </div>

          <div className="stats">
            <div className="stat"><div className="k">Proyectos</div><div className="v accent">{activeRun.projects.length}</div></div>
            <div className="stat"><div className="k">Procesados</div><div className="v">{progress?.done ?? 0}</div></div>
            <div className="stat"><div className="k">Promedio</div><div className="v accent">{avg !== null ? avg.toFixed(1) : "—"}</div></div>
            <div className="stat"><div className="k">Errores</div><div className="v bad">{activeRun.projects.filter((p) => p.status === "error").length}</div></div>
          </div>

          {activeRun.status === "running" && progress && (
            <div className="progress" aria-label="progreso">
              <div style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
            </div>
          )}

          <div className="table-wrap">
          <table className="ranking">
            <thead>
              <tr>
                <th>#</th>
                <th onClick={() => toggleSort("name")}>Proyecto {sortKey === "name" ? (sortDir === 1 ? "↑" : "↓") : ""}</th>
                <th onClick={() => toggleSort("overall")}>Nota</th>
                <th>Veredicto</th>
                <th onClick={() => toggleSort("provider")}>IA {sortKey === "provider" ? (sortDir === 1 ? "↑" : "↓") : ""}</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {sortedProjects.map((p) => (
                <ProjectRow
                  key={p.id}
                  p={p}
                  rank={rankOf.get(p.id) ?? 0}
                  expanded={expanded === p.id}
                  onToggle={() => setExpanded((cur) => (cur === p.id ? null : p.id))}
                />
              ))}
            </tbody>
          </table>
          </div>
        </section>
      )}

      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}

function ProjectRow({ p, rank, expanded, onToggle }: {
  p: ProjectResult;
  rank: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const r = p.result;
  return (
    <>
      <tr className="data-row" onClick={onToggle}>
        <td><span className={`rank-num ${rank <= 3 && r ? "top" : ""}`}>{r ? `#${rank}` : "—"}</span></td>
        <td>
          <a href={p.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: "inherit" }}>
            {p.name ?? p.url.replace(/^https?:\/\//, "")}
          </a>
          {p.repoInfo && (
            <div style={{ fontSize: 11, color: "var(--muted)" }}>
              {p.repoInfo.description ?? "sin descripción"} · {p.repoInfo.language ?? "?"} · ⭐ {p.repoInfo.stars} · {p.repoInfo.filesRead} archivos leídos{p.repoInfo.truncated ? " (truncado)" : ""}
            </div>
          )}
        </td>
        <td>{r ? <span className={`score-badge ${scoreClass(r.overall)}`}>{r.overall}</span> : "—"}</td>
        <td>{r?.verdict ?? "—"}</td>
        <td>{p.provider ? <span className="provider-tag">{p.provider}</span> : "—"}</td>
        <td><span className={`status-dot st-${p.status}`} />{p.status === "done" ? "listo" : p.status === "running" ? "analizando…" : p.status === "error" ? "error" : "pendiente"}</td>
      </tr>
      {expanded && (
        <tr className="detail-row">
          <td colSpan={6}>
            <div className="detail">
              {p.error && <div className="error-box">⚠ {p.error}</div>}
              {r && (
                <>
                  <p className="summary">{r.summary}</p>
                  {Object.keys(r.scores).length > 0 && (
                    <>
                      <h4>Notas por criterio</h4>
                      <ul>{Object.entries(r.scores).map(([k, v]) => <li key={k}>{k}: <strong>{v}/10</strong></li>)}</ul>
                    </>
                  )}
                  <div className="detail-cols">
                    <div>
                      <h4>✅ Requisitos cumplidos</h4>
                      {r.requirementsMet.length ? <ul>{r.requirementsMet.map((s, i) => <li key={i}>{s}</li>)}</ul> : <p className="hint">—</p>}
                    </div>
                    <div>
                      <h4>❌ No cumplidos / no verificables</h4>
                      {r.requirementsMissing.length ? <ul>{r.requirementsMissing.map((s, i) => <li key={i}>{s}</li>)}</ul> : <p className="hint">—</p>}
                    </div>
                  </div>
                  <div className="detail-cols">
                    <div>
                      <h4>💪 Fortalezas</h4>
                      {r.strengths.length ? <ul>{r.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul> : <p className="hint">—</p>}
                    </div>
                    <div>
                      <h4>🔧 Debilidades</h4>
                      {r.weaknesses.length ? <ul>{r.weaknesses.map((s, i) => <li key={i}>{s}</li>)}</ul> : <p className="hint">—</p>}
                    </div>
                  </div>
                  {r.redFlags.length > 0 && (
                    <>
                      <h4>🚩 Red flags</h4>
                      <ul>{r.redFlags.map((s, i) => <li key={i} className="redflag">{s}</li>)}</ul>
                    </>
                  )}
                </>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
