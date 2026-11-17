import fs from "fs";
import path from "path";
import { Redis } from "@upstash/redis";
import type { Run, ProjectResult, ProviderId } from "./types";

export type Backend = "upstash" | "file";

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
export const backend: Backend = REDIS_URL && REDIS_TOKEN ? "upstash" : "file";

const redis = backend === "upstash" ? new Redis({ url: REDIS_URL!, token: REDIS_TOKEN! }) : null;

const META = (id: string) => `ge:run:${id}:meta`;
const PROJ = (id: string, i: number) => `ge:run:${id}:proj:${i}`;
const PENDING = (id: string) => `ge:run:${id}:pending`;
const LOCK = (id: string, i: number) => `ge:run:${id}:lock:${i}`;
const INDEX = "ge:runs:index";
const STALE_MS = 8 * 60 * 1000; // 8 min: una función que murió a la mitad
const LOCK_TTL_S = 240;

export interface RunMeta {
  id: string;
  createdAt: number;
  criteria: string;
  providerIds: ProviderId[];
  projectCount: number;
  status: "running" | "done";
}

// ============================================================
// Utilidades comunes
// ============================================================

function computeStatus(projects: ProjectResult[]): "running" | "done" {
  return projects.every((p) => p.status === "done" || p.status === "error") ? "done" : "running";
}

export function assembleRun(meta: RunMeta, projects: ProjectResult[]): Run {
  return {
    id: meta.id,
    createdAt: meta.createdAt,
    criteria: meta.criteria,
    providerIds: meta.providerIds,
    status: computeStatus(projects),
    projects,
  };
}

// ============================================================
// Backend Upstash / Redis (Vercel serverless)
// ============================================================

const redisStore = {
  async create(meta: RunMeta, projects: ProjectResult[]) {
    const r = redis!;
    const tx = r.multi();
    tx.set(META(meta.id), JSON.stringify(meta));
    for (const p of projects) {
      const i = Number(p.id.split("-")[0]);
      tx.set(PROJ(meta.id, i), JSON.stringify(p));
    }
    for (let i = 0; i < projects.length; i++) tx.sadd(PENDING(meta.id), String(i));
    tx.zadd(INDEX, { score: meta.createdAt, member: meta.id });
    await tx.exec();
  },

  async getMeta(id: string): Promise<RunMeta | null> {
    const raw = await redis!.get<string>(META(id));
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : (raw as unknown as RunMeta);
  },

  async setMeta(meta: RunMeta) {
    await redis!.set(META(meta.id), JSON.stringify(meta));
  },

  async getProjects(id: string, n: number): Promise<ProjectResult[]> {
    if (n === 0) return [];
    const keys = Array.from({ length: n }, (_, i) => PROJ(id, i));
    const raws = await redis!.mget<(string | null)[]>(...keys);
    return raws.map((raw) => {
      if (!raw) return null;
      return typeof raw === "string" ? JSON.parse(raw) : (raw as unknown as ProjectResult);
    }) as ProjectResult[];
  },

  async setProject(id: string, index: number, project: ProjectResult) {
    await redis!.set(PROJ(id, index), JSON.stringify(project));
  },

  async popPending(id: string): Promise<number | null> {
    const v = await redis!.spop(PENDING(id));
    if (v === null || v === undefined) return null;
    const idx = parseInt(String(v), 10);
    return Number.isNaN(idx) ? null : idx;
  },

  async pushPending(id: string, index: number) {
    await redis!.sadd(PENDING(id), String(index));
  },

  async tryLock(id: string, index: number): Promise<boolean> {
    const res = await redis!.set(LOCK(id, index), "1", { nx: true, ex: LOCK_TTL_S });
    return res === "OK";
  },

  async unlock(id: string, index: number) {
    await redis!.del(LOCK(id, index));
  },

  async listIndex(limit = 50): Promise<string[]> {
    const ids = await redis!.zrange<string[]>(INDEX, 0, limit - 1, { rev: true });
    return ids ?? [];
  },

  async deleteRun(id: string, projectCount: number) {
    const r = redis!;
    const tx = r.multi();
    tx.del(META(id), PENDING(id));
    for (let i = 0; i < projectCount; i++) tx.del(PROJ(id, i), LOCK(id, i));
    tx.zrem(INDEX, id);
    await tx.exec();
  },
};

// ============================================================
// Backend archivo (.data/db.json) — desarrollo local
// ============================================================

const DATA_DIR = path.join(process.cwd(), ".data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const claimed = new Set<string>(); // locks en memoria (proceso único)

const globalStore = globalThis as unknown as { __fileRuns?: Run[] };

function loadFile(): Run[] {
  if (globalStore.__fileRuns) return globalStore.__fileRuns;
  try {
    if (fs.existsSync(DB_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf8")) as { runs: Run[] };
      globalStore.__fileRuns = parsed.runs ?? [];
      // Migración: runs viejas sin claimedAt quedan como están, todo bien.
    } else {
      globalStore.__fileRuns = [];
    }
  } catch {
    globalStore.__fileRuns = [];
  }
  return globalStore.__fileRuns;
}

function persistFile() {
  const runs = loadFile();
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ runs }, null, 2), "utf8");
  fs.renameSync(tmp, DB_FILE);
}

const fileStore = {
  async create(meta: RunMeta, projects: ProjectResult[]) {
    loadFile().unshift({
      id: meta.id,
      createdAt: meta.createdAt,
      criteria: meta.criteria,
      providerIds: meta.providerIds,
      status: "running",
      projects,
    });
    persistFile();
  },

  async getMeta(id: string): Promise<RunMeta | null> {
    const run = loadFile().find((r) => r.id === id);
    if (!run) return null;
    return {
      id: run.id,
      createdAt: run.createdAt,
      criteria: run.criteria,
      providerIds: run.providerIds,
      projectCount: run.projects.length,
      status: computeStatus(run.projects),
    };
  },

  async setMeta(_meta: RunMeta) {
    // status se computa siempre en archivo; nada que guardar
  },

  async getProjects(id: string, n: number): Promise<ProjectResult[]> {
    const run = loadFile().find((r) => r.id === id);
    if (!run) return [];
    return run.projects.slice(0, n);
  },

  async setProject(id: string, index: number, project: ProjectResult) {
    const run = loadFile().find((r) => r.id === id);
    if (run) run.projects[index] = project;
    persistFile();
  },

  async popPending(id: string): Promise<number | null> {
    const run = loadFile().find((r) => r.id === id);
    if (!run) return null;
    for (let i = 0; i < run.projects.length; i++) {
      if (run.projects[i].status !== "pending") continue;
      const key = `${id}:${i}`;
      if (claimed.has(key)) continue;
      claimed.add(key);
      return i;
    }
    return null;
  },

  async pushPending(_id: string, _index: number) {
    // en archivo, "pendiente" es el status del proyecto; nada que hacer
  },

  async tryLock(id: string, index: number): Promise<boolean> {
    const key = `${id}:${index}`;
    if (claimed.has(key)) return true; // ya somos nosotros los que popeamos
    claimed.add(key);
    return true;
  },

  async unlock(id: string, index: number) {
    claimed.delete(`${id}:${index}`);
  },

  async listIndex(limit = 50): Promise<string[]> {
    return [...loadFile()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((r) => r.id);
  },

  async deleteRun(id: string) {
    const runs = loadFile();
    const i = runs.findIndex((r) => r.id === id);
    if (i >= 0) {
      runs.splice(i, 1);
      persistFile();
    }
  },
};

// ============================================================
// API pública unificada
// ============================================================

const store = () => (backend === "upstash" ? redisStore : fileStore);

export async function createRun(meta: RunMeta, projects: ProjectResult[]) {
  await store().create(meta, projects);
}

export async function getRun(id: string): Promise<Run | undefined> {
  const s = store();
  const meta = await s.getMeta(id);
  if (!meta) return undefined;
  const projects = await s.getProjects(id, meta.projectCount);
  return assembleRun(meta, projects);
}

export async function listRuns(): Promise<Run[]> {
  const s = store();
  const ids = await s.listIndex(50);
  const out: Run[] = [];
  for (const id of ids) {
    const run = await getRun(id);
    if (run) out.push(run);
  }
  return out;
}

export async function deleteRun(id: string) {
  const s = store();
  const meta = await s.getMeta(id);
  if (!meta) return;
  if (backend === "upstash") await (s as typeof redisStore).deleteRun(id, meta.projectCount);
  else await (s as typeof fileStore).deleteRun(id);
}

/** Barrido de proyectos 'running' huérfanos (función serverless que murió). */
export async function sweepStale(id: string): Promise<number> {
  const s = store();
  const meta = await s.getMeta(id);
  if (!meta) return 0;
  const projects = await s.getProjects(id, meta.projectCount);
  const now = Date.now();
  let requeued = 0;
  for (let i = 0; i < projects.length; i++) {
    const p = projects[i];
    if (p.status === "running" && p.claimedAt && now - p.claimedAt > STALE_MS) {
      const fresh: ProjectResult = { ...p, status: "pending", claimedAt: undefined, error: undefined };
      await s.setProject(id, i, fresh);
      await s.pushPending(id, i);
      requeued++;
    }
  }
  return requeued;
}

export async function requeueFailed(id: string): Promise<number> {
  const s = store();
  const meta = await s.getMeta(id);
  if (!meta) return 0;
  const projects = await s.getProjects(id, meta.projectCount);
  const now = Date.now();
  let n = 0;
  for (let i = 0; i < projects.length; i++) {
    const p = projects[i];
    const isError = p.status === "error";
    const isStaleRunning = p.status === "running" && p.claimedAt && now - p.claimedAt > STALE_MS;
    if (isError || isStaleRunning) {
      const fresh: ProjectResult = { ...p, status: "pending", claimedAt: undefined, error: undefined, result: undefined, finishedAt: undefined };
      await s.setProject(id, i, fresh);
      await s.pushPending(id, i);
      n++;
    }
  }
  return n;
}

export async function popPendingProject(id: string) {
  const s = store();
  const meta = await s.getMeta(id);
  if (!meta) return { meta: null, index: null, project: null } as const;
  const index = await s.popPending(id);
  if (index === null) return { meta, index: null, project: null } as const;
  const ok = await s.tryLock(id, index);
  if (!ok) {
    await s.pushPending(id, index);
    return { meta, index: null, project: null } as const;
  }
  const projects = await s.getProjects(id, meta.projectCount);
  const project = projects[index];
  if (!project || project.status !== "pending") {
    await s.unlock(id, index);
    return { meta, index: null, project: null } as const;
  }
  return { meta, index, project } as const;
}

export async function saveProjectAndUnlock(id: string, index: number, project: ProjectResult) {
  const s = store();
  await s.setProject(id, index, project);
  await s.unlock(id, index);
}

/** Guarda el proyecto SIN liberar el lock (para marcarlo running). */
export async function setProjectOnly(id: string, index: number, project: ProjectResult) {
  const s = store();
  await s.setProject(id, index, project);
}

export async function unlockProject(id: string, index: number) {
  const s = store();
  await s.unlock(id, index);
}

export async function finalizeIfDone(id: string): Promise<"running" | "done"> {
  const s = store();
  const meta = await s.getMeta(id);
  if (!meta) return "done";
  const projects = await s.getProjects(id, meta.projectCount);
  const status = computeStatus(projects);
  if (status === "done" && meta.status !== "done") {
    await s.setMeta({ ...meta, status: "done" });
  }
  return status;
}

export async function countRemaining(id: string): Promise<number> {
  const s = store();
  const meta = await s.getMeta(id);
  if (!meta) return 0;
  const projects = await s.getProjects(id, meta.projectCount);
  return projects.filter((p) => p.status !== "done" && p.status !== "error").length;
}
