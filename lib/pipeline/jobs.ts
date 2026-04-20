import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { ensureDir, fileExists, readJsonFile, writeJsonFile } from "@/lib/pipeline/fs";
import {
  getJobConfigPath,
  getJobDir,
  getJobInputAudioPath,
  getJobsRootDir
} from "@/lib/pipeline/paths";
import { initState } from "@/lib/pipeline/state";
import { PipelineConfig, PipelineOptions } from "@/lib/pipeline/types";

export async function createJobId() {
  return randomUUID();
}

export async function ensureJobsRoot() {
  await ensureDir(getJobsRootDir());
}

export async function writeJobConfig(jobId: string, config: PipelineConfig) {
  const configPath = getJobConfigPath(jobId);
  await ensureDir(path.dirname(configPath));
  await writeJsonFile(configPath, config);
}

export async function saveUploadedAudio(jobId: string, file: File) {
  const bytes = Buffer.from(await file.arrayBuffer());
  const target = getJobInputAudioPath(jobId);
  await ensureDir(path.dirname(target));
  await fs.writeFile(target, bytes);
  return target;
}

export async function initJob(jobId: string, options: PipelineOptions, sourceAudioPath: string) {
  const outputDir = getJobDir(jobId);
  const config: PipelineConfig = { jobId, sourceAudioPath, outputDir, options };
  await writeJobConfig(jobId, config);
  await initState(jobId, options.nSegments, options);
  return config;
}

export function launchJobProcess(jobId: string) {
  const child = spawn("npm", ["run", "pipeline:run", "--", jobId], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

export async function readJobState(jobId: string) {
  const statePath = path.join(getJobDir(jobId), "state.json");
  if (!(await fileExists(statePath))) {
    return null;
  }
  return readJsonFile(statePath);
}

export async function listJobs() {
  await ensureJobsRoot();
  const items = await fs.readdir(getJobsRootDir(), { withFileTypes: true });
  const jobs = items.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  jobs.sort();
  jobs.reverse();
  return jobs;
}

export function isValidJobId(jobId: string) {
  return /^[a-zA-Z0-9-]+$/.test(jobId);
}

export async function deleteJob(jobId: string) {
  if (!isValidJobId(jobId)) {
    throw new Error("Invalid jobId");
  }

  const jobDir = getJobDir(jobId);
  const relative = path.relative(getJobsRootDir(), jobDir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Invalid jobId");
  }

  if (!(await fileExists(jobDir))) {
    return false;
  }

  await fs.rm(jobDir, { recursive: true, force: false });
  return true;
}
