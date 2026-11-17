export interface Snapshot {
  kind: "github" | "web";
  title: string;
  meta: Record<string, string | number | boolean | null>;
  text: string;
  filesRead: number;
  truncated: boolean;
}

const SKIP_DIR_RE = /(^|\/)(node_modules|\.git|dist|build|out|coverage|\.next|vendor|\.turbo|target|bin|obj|\.cache|storybook-static)(\/|$)/i;
const SKIP_FILE_RE = /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|\.min\.(js|css)|\.map|\.snap|\.d\.ts)$/i;
const SKIP_EXT_RE = /\.(png|jpe?g|gif|webp|svg|ico|bmp|woff2?|ttf|otf|eot|mp4|mov|webm|mp3|wav|ogg|zip|tar|gz|tgz|rar|7z|pdf|exe|dll|so|dylib|class|jar|pyc|sqlite3?|db|bin|wasm|avif|mp4|m4a)$/i;
const BINARY_GUESS_RE = /\.(docx?|xlsx?|pptx?|parquet|pkl|onnx|safetensors|gguf)$/i;

const MAX_FILES = 70;
const MAX_TOTAL_CHARS = 120_000;
const MAX_FILE_CHARS = 25_000;
const MAX_WEB_CHARS = 30_000;

function ghHeaders(): HeadersInit {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "goncy-evaluations",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/** Extrae owner/repo de URLs de GitHub (con o sin .git, /tree/..., /blob/..., trailing slash). */
export function parseGitHubUrl(rawUrl: string): { owner: string; repo: string } | null {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/i, "");
    if (!owner || !repo || repo === "") return null;
    return { owner, repo };
  } catch {
    return null;
  }
}

function priority(path: string): number {
  const p = path.toLowerCase();
  if (/readme/i.test(p)) return 0;
  if (p === "package.json" || /\/package\.json$/.test(p)) return 1;
  if (/(next|vite|webpack|rollup|tsconfig|tailwind|postcss|eslint|prettier|babel|astro|svelte|nuxt)\.?config|dockerfile|\.eslintrc|\.prettierrc|\.nvmrc|netlify\.toml|vercel\.json/i.test(p)) return 2;
  if (/^(src|app|pages|components|lib|server|api|public)\//.test(p)) return 3;
  if (/\.(test|spec)\.[jt]sx?$/.test(p)) return 4;
  if (/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|c|cc|cpp|h|cs|swift|vue|svelte)$/.test(p)) return 5;
  return 6;
}

async function fetchText(url: string, init?: RequestInit, ms = 12_000): Promise<string | null> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(ms), redirect: "follow" });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export async function fetchSnapshot(rawUrl: string, deadlineMs = 20_000): Promise<Snapshot> {
  const gh = parseGitHubUrl(rawUrl);
  if (gh) return fetchGitHubSnapshot(gh.owner, gh.repo, rawUrl, deadlineMs);
  return fetchWebSnapshot(rawUrl);
}

async function fetchGitHubSnapshot(owner: string, repo: string, originalUrl: string, deadlineMs: number): Promise<Snapshot> {
  // 1) Metadata del repo
  let metaRes: Response;
  try {
    metaRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: ghHeaders(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("No se pudo conectar con la API de GitHub (timeout/red).");
  }
  if (metaRes.status === 404) throw new Error(`Repo no encontrado o privado: ${owner}/${repo}. Si es privado agregÃ¡ GITHUB_TOKEN.`);
  if (metaRes.status === 403) throw new Error("Rate limit de la API de GitHub excedido. AgregÃ¡ GITHUB_TOKEN al .env (https://github.com/settings/tokens).");
  if (!metaRes.ok) throw new Error(`GitHub API respondiÃ³ ${metaRes.status} al pedir metadata del repo.`);
  const meta = (await metaRes.json()) as {
    description: string | null;
    language: string | null;
    stargazers_count: number;
    default_branch: string;
    fork: boolean;
    archived: boolean;
  };
  const branch = meta.default_branch || "main";

  // 2) Ãrbol de archivos (recursivo)
  let tree: Array<{ path: string; type: string; size?: number }> = [];
  let truncated = false;
  try {
    const treeRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
      { headers: ghHeaders(), signal: AbortSignal.timeout(12_000) }
    );
    if (treeRes.ok) {
      const treeJson = (await treeRes.json()) as { tree?: Array<{ path: string; type: string; size?: number }>; truncated?: boolean };
      tree = treeJson.tree ?? [];
      truncated = Boolean(treeJson.truncated);
    }
  } catch {
    // seguimos sin Ã¡rbol
  }

  // 3) Filtrar y priorizar archivos
  const candidates = tree
    .filter((t) => t.type === "blob")
    .map((t) => t.path)
    .filter((p) => !SKIP_DIR_RE.test(p) && !SKIP_FILE_RE.test(p) && !SKIP_EXT_RE.test(p) && !BINARY_GUESS_RE.test(p))
    .sort((a, b) => priority(a) - priority(b))
    .slice(0, MAX_FILES * 2); // margen para los que se salteen por tamaÃ±o

  // 4) Bajar contenido de raw.githubusercontent.com (lotes de 6, con deadline global)
  const started = Date.now();
  const picked: Array<{ path: string; content: string }> = [];
  let total = 0;
  for (let i = 0; i < candidates.length && picked.length < MAX_FILES && total < MAX_TOTAL_CHARS; i += 6) {
    if (Date.now() - started > deadlineMs) {
      truncated = true;
      break;
    }
    const batch = candidates.slice(i, i + 6);
    const contents = await Promise.all(
      batch.map(async (path) => {
        const raw = await fetchText(
          `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${path.split("/").map(encodeURIComponent).join("/")}`,
          { signal: AbortSignal.timeout(8_000) },
          8_000
        );
        return { path, content: raw };
      })
    );
    for (const { path, content } of contents) {
      if (!content) continue;
      if (/\0/.test(content.slice(0, 8000))) continue; // binario
      const trimmed = content.length > MAX_FILE_CHARS ? content.slice(0, MAX_FILE_CHARS) + "\n/* ...truncado... */" : content;
      if (total + trimmed.length > MAX_TOTAL_CHARS) {
        truncated = true;
        break;
      }
      picked.push({ path, content: trimmed });
      total += trimmed.length;
      if (picked.length >= MAX_FILES || total >= MAX_TOTAL_CHARS) break;
    }
  }

  const header = [
    `Repositorio: ${owner}/${repo}`,
    `URL: ${originalUrl}`,
    `DescripciÃ³n: ${meta.description ?? "(sin descripciÃ³n)"}`,
    `Lenguaje principal: ${meta.language ?? "(desconocido)"} | â­ ${meta.stargazers_count} | branch: ${branch} | fork: ${meta.fork} | archivado: ${meta.archived}`,
    `Archivos leÃ­dos: ${picked.length}${truncated ? " (Ã¡rbol truncado o presupuesto alcanzado)" : ""}`,
    "",
  ].join("\n");

  const body = picked.map((f) => `===== ${f.path} =====\n${f.content}`).join("\n\n");

  return {
    kind: "github",
    title: `${owner}/${repo}`,
    meta: {
      description: meta.description,
      language: meta.language,
      stars: meta.stargazers_count,
      defaultBranch: branch,
      filesRead: picked.length,
      truncated,
    },
    text: header + body,
    filesRead: picked.length,
    truncated,
  };
}

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "0.0.0.0" || h === "[::1]" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  const m = /^172\.(\d+)\./.exec(h);
  if (m) {
    const second = parseInt(m[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

async function fetchWebSnapshot(rawUrl: string): Promise<Snapshot> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("URL invÃ¡lida.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Solo se permiten URLs http/https.");
  if (isPrivateHost(url.hostname)) throw new Error("Por seguridad no se analizan hosts internos/privados.");

  const html = await fetchText(rawUrl, { headers: { "User-Agent": "goncy-evaluations" } }, 15_000);
  if (!html) throw new Error("No se pudo obtener contenido de la URL (o respondiÃ³ error).");

  // Limpieza bÃ¡sica de HTML â†’ texto
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();

  const truncated = text.length > MAX_WEB_CHARS;
  text = text.slice(0, MAX_WEB_CHARS);

  return {
    kind: "web",
    title: url.hostname,
    meta: { host: url.hostname },
    text: `Sitio web: ${rawUrl}\n\nContenido extraÃ­do (parcial, sin ejecuciÃ³n JS):\n\n${text}`,
    filesRead: 1,
    truncated,
  };
}
