export interface ParsedLink {
  url: string;
  name?: string;
}

/** Parser CSV mínimo pero correcto: comillas, comas dentro de comillas, delimitador , o ; autodetectado. */
export function parseCsvText(text: string): string[][] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const delim = (firstLine.match(/;/g) ?? []).length > (firstLine.match(/,/g) ?? []).length ? ";" : ",";

  const rows: string[][] = [];
  let cur = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(cur);
      cur = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cur);
      cur = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else {
      cur += ch;
    }
  }
  if (cur !== "" || row.length > 0) {
    row.push(cur);
    if (row.some((c) => c.trim() !== "")) rows.push(row);
  }
  return rows;
}

const URL_HEADERS = ["url", "link", "enlace", "repo", "repository", "github", "proyecto", "project", "submission", "entrega"];
const NAME_HEADERS = ["nombre", "name", "title", "titulo", "autor", "author", "participant", "participante", "user", "username", "handle", "participante"];

function looksLikeUrl(s: string): boolean {
  return /^(https?:\/\/|www\.|github\.com\/|gitlab\.com\/)/i.test(s.trim());
}

function normalizeUrl(s: string): string {
  let u = s.trim();
  if (/^github\.com\//i.test(u) || /^gitlab\.com\//i.test(u)) u = "https://" + u;
  else if (/^www\./i.test(u)) u = "https://" + u;
  return u;
}

/** Parsea CSV y devuelve la lista de enlaces + nombre opcional. */
export function extractLinksFromCsv(text: string): ParsedLink[] {
  const rows = parseCsvText(text);
  if (rows.length === 0) return [];

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const urlIdxInHeader = header.findIndex((h) => URL_HEADERS.includes(h));
  const nameIdxInHeader = header.findIndex((h) => NAME_HEADERS.includes(h));

  const hasHeader = urlIdxInHeader >= 0 || header.some((h) => URL_HEADERS.includes(h)) || (!looksLikeUrl(rows[0][0] ?? "") && rows[0].length > 0 && !looksLikeUrl(rows[0].join(" ")));

  const startRow = hasHeader && urlIdxInHeader >= 0 ? 1 : 0;
  const urlIdx = urlIdxInHeader >= 0 ? urlIdxInHeader : Math.max(0, rows[0].findIndex((c) => looksLikeUrl(c)));
  const nameIdx = nameIdxInHeader >= 0 ? nameIdxInHeader : -1;

  const out: ParsedLink[] = [];
  const seen = new Set<string>();
  for (let i = startRow; i < rows.length; i++) {
    const r = rows[i];
    let url = (r[urlIdx] ?? "").trim();
    if (!url) {
      // buscar cualquier celda que parezca URL en la fila
      const found = r.find((c) => looksLikeUrl(c));
      if (found) url = found.trim();
    }
    if (!url || !looksLikeUrl(url)) continue;
    url = normalizeUrl(url);
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const name = nameIdx >= 0 ? r[nameIdx]?.trim() || undefined : undefined;
    out.push(name ? { url, name } : { url });
  }
  return out;
}

/** Parsea enlaces pegados a mano (uno por línea, o separados por coma/espacio). */
export function extractLinksFromText(text: string): ParsedLink[] {
  const tokens = text.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);
  const out: ParsedLink[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    if (!looksLikeUrl(t)) continue;
    const url = normalizeUrl(t);
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url });
  }
  return out;
}
