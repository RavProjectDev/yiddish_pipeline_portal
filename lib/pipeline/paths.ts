import path from "node:path";

const ROOT = process.cwd();
const JOBS_ROOT = path.join(ROOT, "pipeline", "jobs");

export function getJobsRootDir() {
  return JOBS_ROOT;
}

export function getJobDir(jobId: string) {
  return path.join(JOBS_ROOT, jobId);
}

export function getJobConfigPath(jobId: string) {
  return path.join(getJobDir(jobId), "config.json");
}

export function getJobStatePath(jobId: string) {
  return path.join(getJobDir(jobId), "state.json");
}

export function getJobInputAudioPath(jobId: string) {
  return path.join(getJobDir(jobId), "input", "source.mp3");
}

export function getPlanPath(jobId: string) {
  return path.join(getJobDir(jobId), "plan.json");
}

export function getSegmentDir(jobId: string, index: number) {
  return path.join(getJobDir(jobId), `segment_${String(index).padStart(3, "0")}`);
}

export function getSegmentLogsDir(jobId: string, index: number) {
  return path.join(getSegmentDir(jobId, index), "logs");
}
