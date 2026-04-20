import { getJobStatePath } from "@/lib/pipeline/paths";
import { ensureDir, readJsonFile, writeJsonFile } from "@/lib/pipeline/fs";
import { PipelineOptions, PipelineState, SegmentState, StepName, StepStatus } from "@/lib/pipeline/types";
import path from "node:path";

const STEPS: StepName[] = ["audio", "sofer", "translate", "whisper", "align"];

function emptySegmentState(): SegmentState {
  return {
    audio: "PENDING",
    sofer: "PENDING",
    translate: "PENDING",
    whisper: "PENDING",
    align: "PENDING"
  };
}

export async function initState(jobId: string, nSegments: number, options: PipelineOptions) {
  const segments: Record<string, SegmentState> = {};
  for (let i = 0; i < nSegments; i += 1) {
    segments[String(i)] = emptySegmentState();
  }

  const now = new Date().toISOString();
  const initial: PipelineState = {
    n_segments: nSegments,
    created_at: now,
    updated_at: now,
    options,
    segments,
    job_status: "PENDING"
  };
  const statePath = getJobStatePath(jobId);
  await ensureDir(path.dirname(statePath));
  await writeJsonFile(statePath, initial);
}

export async function readState(jobId: string) {
  return readJsonFile<PipelineState>(getJobStatePath(jobId));
}

export async function writeState(jobId: string, state: PipelineState) {
  state.updated_at = new Date().toISOString();
  await writeJsonFile(getJobStatePath(jobId), state);
}

export async function updateStep(jobId: string, segmentIndex: number, step: StepName, status: StepStatus) {
  const state = await readState(jobId);
  const key = String(segmentIndex);
  state.segments[key] ??= emptySegmentState();
  state.segments[key][step] = status;
  await writeState(jobId, state);
}

export async function setJobStatus(jobId: string, status: PipelineState["job_status"], error?: string) {
  const state = await readState(jobId);
  state.job_status = status;
  state.error = error;
  await writeState(jobId, state);
}

export function allStepsDone(segment: SegmentState) {
  return STEPS.every((step) => segment[step] === "DONE");
}
