export type ProviderId = "gemini" | "groq";

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  configured: boolean;
  model: string;
}

export type ProjectStatus = "pending" | "running" | "done" | "error";
export type RunStatus = "running" | "done" | "error";

export interface Analysis {
  overall: number; // 0-10
  verdict: string; // aprobado | aceptable con reservas | rechazado
  summary: string;
  strengths: string[];
  weaknesses: string[];
  redFlags: string[];
  requirementsMet: string[];
  requirementsMissing: string[];
  scores: Record<string, number>;
}

export interface ProjectResult {
  id: string;
  url: string;
  name?: string;
  status: ProjectStatus;
  provider?: ProviderId;
  model?: string;
  repoInfo?: {
    description: string | null;
    language: string | null;
    stars: number;
    defaultBranch: string;
    filesRead: number;
    truncated: boolean;
  };
  result?: Analysis;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface Run {
  id: string;
  createdAt: number;
  criteria: string;
  providerIds: ProviderId[];
  status: RunStatus;
  projects: ProjectResult[];
}
