import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import {
  createJobId,
  ensureJobsRoot,
  initJob,
  launchJobProcess,
  readJobState,
  saveUploadedAudio,
  writeJobConfig
} from "@/lib/pipeline/jobs";
import { fileExists, readJsonFile } from "@/lib/pipeline/fs";
import { getJobConfigPath, getJobDir } from "@/lib/pipeline/paths";
import { initState } from "@/lib/pipeline/state";
import { PipelineConfig, PipelineOptions } from "@/lib/pipeline/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseNumber(value: FormDataEntryValue | null, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function POST(request: Request) {
  try {
    await ensureJobsRoot();
    const form = await request.formData();
    const nSegments = parseNumber(form.get("nSegments"), 50);
    const startFromSegment = parseNumber(form.get("startFromSegment"), 0);
    const whisperModel = String(form.get("whisperModel") ?? "large-v3");
    const existingJobId = String(form.get("existingJobId") ?? "").trim();
    const uploadedAudio = form.get("audio");

    const options: PipelineOptions = {
      nSegments,
      whisperModel,
      startFromSegment
    };

    let jobId = existingJobId;
    let sourceAudioPath = "";

    if (jobId) {
      const configPath = getJobConfigPath(jobId);
      if (!(await fileExists(configPath))) {
        return NextResponse.json({ error: "existingJobId not found" }, { status: 404 });
      }

      const currentConfig = await readJsonFile<PipelineConfig>(configPath);
      sourceAudioPath = currentConfig.sourceAudioPath;
      if (uploadedAudio instanceof File && uploadedAudio.size > 0) {
        sourceAudioPath = await saveUploadedAudio(jobId, uploadedAudio);
      }

      const nextConfig: PipelineConfig = {
        ...currentConfig,
        sourceAudioPath,
        options
      };
      await writeJobConfig(jobId, nextConfig);

      const existingState = await readJobState(jobId);
      if (!existingState) {
        await initState(jobId, nSegments, options);
      }
    } else {
      if (!(uploadedAudio instanceof File) || uploadedAudio.size === 0) {
        return NextResponse.json(
          { error: "Audio upload is required when creating a new job" },
          { status: 400 }
        );
      }
      jobId = await createJobId();
      sourceAudioPath = await saveUploadedAudio(jobId, uploadedAudio);
      await initJob(jobId, options, sourceAudioPath);
    }

    await fs.mkdir(path.join(getJobDir(jobId), "logs"), { recursive: true });
    launchJobProcess(jobId);
    return NextResponse.json({ ok: true, jobId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
