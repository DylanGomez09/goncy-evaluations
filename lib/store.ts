import fs from "fs";
import path from "path";
import type { Run } from "./types";

const DATA_DIR = path.join(process.cwd(), ".data");
const DB_FILE = path.join(DATA_DIR, "db.json");

// Estado global en memoria (sobrevive HMR en dev vía globalThis)
const globalStore = globalThis as unknown as {
  __runs?: Run[];
  __activeRunIds?: Set<string>;
};

function load(): Run[] {
  if (globalStore.__runs) return globalStore.__runs;
  try {
    if (fs.existsSync(DB_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf8")) as { runs: Run[] };
      globalStore.__runs = parsed.runs ?? [];
    } else {
      globalStore.__runs = [];
    }
  } catch {
    globalStore.__runs = [];
  }
  return globalStore.__runs;
}

function persist() {
  const runs = load();
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  // Escritura atómica
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ runs }, null, 2), "utf8");
  fs.renameSync(tmp, DB_FILE);
}

export function listRuns(): Run[] {
  return [...load()].sort((a, b) => b.createdAt - a.createdAt);
}

export function getRun(id: string): Run | undefined {
  return load().find((r) => r.id === id);
}

export function insertRun(run: Run) {
  load().unshift(run);
  persist();
}

export function updateRun(id: string, fn: (run: Run) => void) {
  const run = getRun(id);
  if (!run) return;
  fn(run);
  persist();
}

export function deleteRun(id: string) {
  const runs = load();
  const idx = runs.findIndex((r) => r.id === id);
  if (idx >= 0) {
    runs.splice(idx, 1);
    persist();
  }
}

export function isRunActive(id: string): boolean {
  return globalStore.__activeRunIds?.has(id) ?? false;
}

export function markRunActive(id: string, active: boolean) {
  if (!globalStore.__activeRunIds) globalStore.__activeRunIds = new Set();
  if (active) globalStore.__activeRunIds.add(id);
  else globalStore.__activeRunIds.delete(id);
}
