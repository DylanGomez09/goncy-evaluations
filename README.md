# Goncy Evaluations

Evaluador masivo de proyectos de challenges. Subís un CSV (o pegás los enlaces), escribís los criterios y la IA analiza cada proyecto (GitHub público, o URLs web como fallback) generando un ranking comparativo con reportes individuales.

## Uso

```bash
npm install
# 1) copiar .env.example → .env.local y pegar las API keys
# 2) npm run dev   →   http://localhost:3000
```

### API keys (.env.local)

| Variable | Para qué |
|---|---|
| `GEMINI_API_KEY` | Gemini (Google AI Studio, tier gratis). Key: https://aistudio.google.com/apikey |
| `GEMINI_MODEL` | Por defecto `gemini-3.5-flash-lite` (500 req/día gratis). `gemini-3.8-flash` es más capaz pero solo ~20/día. |
| `GROQ_API_KEY` | Groq (tier gratis). Key: https://console.groq.com/keys |
| `GROQ_MODEL` | Por defecto `openai/gpt-oss-120b` |
| `GITHUB_TOKEN` | Opcional. Sube el rate limit de GitHub de 60 a 5000 req/h. https://github.com/settings/tokens (sin scopes para repos públicos) |

**Usá las DOS IAs a la vez**: si ambas keys están configuradas, la app reparte los proyectos en paralelo entre Gemini y Groq (cada una toma el siguiente disponible), así no quemás la cuota de ninguna. Podés prender/apagar cada una desde la UI.

## Features

- Entrada por CSV (upload/drag&drop, delimitador `,`/`;` autodetectado, columna `url`/`link`/`enlace` + `nombre`/`autor` opcional) **o** pegado de enlaces. Dedupe automático.
- Prompt de criterios libre (qué tiene que evaluar la IA), con ejemplo cargable.
- Análisis paralelo multi-proveedor con colas, backoff ante rate limits (429/413) leyendo `retry-after`.
- Para repos GitHub: metadata + árbol + contenido de archivos relevantes (README, package.json, configs, src), con presupuesto de tokens. Para URLs web: extracción de texto (sin screenshots ni JS).
- Ranking ordenable (nota / nombre / proveedor), reporte detallado expandible por proyecto (requisitos cumplidos/faltantes, strengths/weaknesses, red flags, nota por criterio).
- Exportación **CSV / Markdown / JSON** e **historial** persistente en `.data/db.json` (borrar corridas incluido).

## Limitaciones (v1)

- Repos privados solo con `GITHUB_TOKEN` con permisos.
- Los tiers gratis cambian seguido; si un modelo se depreca ajustá `GEMINI_MODEL` / `GROQ_MODEL`.
- La IA evalúa código y contenido; no ejecuta los proyectos ni abre el navegador.

## Producción (Vercel)

La app es **serverless-compatible**: no usa memoria compartida ni filesystem con estado. El procesamiento es *client-driven* — el navegador llama a `POST /api/runs/:id/tick` en loop (2 lanes, una por IA) y cada tick analiza **un** proyecto dentro del request, con locks `SET NX`, colas atómicas (`SPOP`) y barrido de jobs huérfanos.

Para desplegar en Vercel:

1. Importá el repo en Vercel (New Project → Import Git Repository).
2. **Agregá las env vars** en Project → Settings → Environment Variables (Production):
   - `GEMINI_API_KEY` y `GROQ_API_KEY` (tus claves), `GITHUB_TOKEN` opcional
3. **Creá la base Redis**: Project → Storage → Create Database → **Redis (Upstash)** → Connect to Project. Esto agrega solo `UPSTASH_REDIS_REST_URL` y `UPSTASH_REDIS_REST_TOKEN`. Sin esto el deploy renderiza pero las corridas fallan.
4. **Redeploy** (las env vars aplican a deploys nuevos).
5. Si una corrida quedó con errores (rate limit, etc.): botón **↻ Reintentar fallidos** en el resultado.

Plan Hobby de Vercel: cada tick tiene 60s de tope — alcanza para el flujo típico (leer repo + 1 llamada a la IA). Si un proyecto es enorme, el snapshot se trunca solo.

En **local** no hace falta Redis: sin esas vars, usa `.data/db.json` como siempre.
