import fs from "fs";
import { logger } from "../lib/logger";

export type StepType = "info" | "success" | "error" | "warning";

export interface JobStep {
  time: string;
  message: string;
  type: StepType;
}

export interface ExportJob {
  id: string;
  status: "running" | "done" | "error";
  mode: "download" | "email";
  steps: JobStep[];
  /** Compatibility-only attachment bytes. Browser downloads should use zipFilePath. */
  zipBuffer?: Buffer;
  /** Temporary ZIP file used by manual browser-download jobs. */
  zipFilePath?: string;
  zipSizeBytes?: number;
  error?: string;
  createdAt: Date;
}

const jobs = new Map<string, ExportJob>();

const MAX_JOBS = Math.max(10, Number.parseInt(process.env.EXPORT_JOB_MAX_ENTRIES || "100", 10) || 100);
const MAX_STEPS_PER_JOB = Math.max(20, Number.parseInt(process.env.EXPORT_JOB_MAX_STEPS || "200", 10) || 200);

function pruneCompletedJobs(): void {
  if (jobs.size < MAX_JOBS) return;
  for (const [id, job] of jobs) {
    if (jobs.size < MAX_JOBS) break;
    if (job.status !== "running") deleteJob(id);
  }
}

function removeFileQuietly(filePath: string | undefined): void {
  if (!filePath) return;
  try {
    fs.rmSync(filePath, { force: true });
  } catch (error) {
    logger.warn(`[ExportJob] Failed to remove temporary archive ${filePath}:`, { error: error });
  }
}

export function releaseJobArchive(job: ExportJob): void {
  job.zipBuffer = undefined;
  removeFileQuietly(job.zipFilePath);
  job.zipFilePath = undefined;
  job.zipSizeBytes = undefined;
}

export function deleteJob(id: string): void {
  const job = jobs.get(id);
  if (!job) return;
  releaseJobArchive(job);
  jobs.delete(id);
}

// Clean up jobs older than 30 minutes, including temporary ZIP files. The timer
// is unref'd so it cannot keep a worker alive during deploy or controlled restart.
const cleanupTimer = setInterval(
  () => {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000);
    for (const [id, job] of jobs.entries()) {
      if (job.createdAt < cutoff) deleteJob(id);
    }
  },
  5 * 60 * 1000
);
cleanupTimer.unref?.();

export function createJob(mode: "download" | "email"): ExportJob {
  pruneCompletedJobs();
  const id = `exp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const job: ExportJob = {
    id,
    status: "running",
    mode,
    steps: [],
    createdAt: new Date(),
  };
  jobs.set(id, job);
  return job;
}

export function getJob(id: string): ExportJob | undefined {
  return jobs.get(id);
}

export function addStep(job: ExportJob, message: string, type: StepType = "info") {
  job.steps.push({
    time: new Date().toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
    message,
    type,
  });
  if (job.steps.length > MAX_STEPS_PER_JOB) {
    job.steps.splice(0, job.steps.length - MAX_STEPS_PER_JOB);
  }
}

export function finishJob(job: ExportJob, zipBuffer?: Buffer) {
  job.status = "done";
  job.zipBuffer = zipBuffer;
  job.zipSizeBytes = zipBuffer?.length;
}

export function finishJobWithFile(job: ExportJob, zipFilePath: string, zipSizeBytes: number) {
  releaseJobArchive(job);
  job.status = "done";
  job.zipFilePath = zipFilePath;
  job.zipSizeBytes = zipSizeBytes;
}

export function failJob(job: ExportJob, error: string) {
  releaseJobArchive(job);
  job.status = "error";
  job.error = error;
  addStep(job, `Failed: ${error}`, "error");
}
