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
import {
  CloudTranscriptionProvider,
  PipelineConfig,
  PipelineOptions,
  TranscriptionProvider
} from "@/lib/pipeline/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseNumber(value: FormDataEntryValue | null, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseTranscriptionProvider(value: FormDataEntryValue | null): TranscriptionProvider | undefined {
  const provider = String(value ?? "")
    .trim()
    .toLowerCase();
  if (provider === "local" || provider === "local-whisper") {
    return "local";
  }
  if (
    provider === "cloud" ||
    provider === "openai-whisper-cloud" ||
    provider === "openai-gpt-transcribe"
  ) {
    return "cloud";
  }
  return undefined;
}

function parseCloudProvider(
  cloudProviderValue: FormDataEntryValue | null,
  providerValue: FormDataEntryValue | null
): CloudTranscriptionProvider | undefined {
  const normalized = String(cloudProviderValue ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "openai") {
    return "openai";
  }
  if (normalized === "groq") {
    return "groq";
  }

  const legacyProvider = String(providerValue ?? "")
    .trim()
    .toLowerCase();
  if (legacyProvider === "openai-whisper-cloud" || legacyProvider === "openai-gpt-transcribe") {
    return "openai";
  }
  if (legacyProvider === "groq-whisper-cloud") {
    return "groq";
  }
  return undefined;
}

function defaultModelFor(
  provider: TranscriptionProvider | undefined,
  cloudProvider: CloudTranscriptionProvider | undefined
) {
  if (provider === "cloud") {
    return cloudProvider === "groq" ? "whisper-large-v3" : "whisper-1";
  }
  return "large-v3";
}

function normalizeWhisperModel(
  provider: TranscriptionProvider | undefined,
  cloudProvider: CloudTranscriptionProvider | undefined,
  modelName: string
) {
  const requested = modelName.trim();
  const localModels = new Set(["large-v3", "large-v3-turbo"]);
  const openAiCloudModels = new Set(["whisper-1"]);
  const groqCloudModels = new Set(["whisper-large-v3"]);
  const useProvider = provider ?? "local";
  const useCloudProvider = cloudProvider ?? "openai";

  if (!requested) {
    return defaultModelFor(useProvider, useCloudProvider);
  }
  if (useProvider === "cloud") {
    const allowed = useCloudProvider === "groq" ? groqCloudModels : openAiCloudModels;
    if (!allowed.has(requested)) {
      throw new Error(
        useCloudProvider === "groq"
          ? "Invalid Groq cloud model. Allowed: whisper-large-v3"
          : "Invalid OpenAI cloud model. Allowed: whisper-1"
      );
    }
    return requested;
  }
  if (!localModels.has(requested)) {
    throw new Error("Invalid local model. Allowed: large-v3, large-v3-turbo");
  }
  return requested;
}

export async function POST(request: Request) {
  try {
    await ensureJobsRoot();
    const form = await request.formData();
    const nSegments = parseNumber(form.get("nSegments"), 50);
    const startFromSegment = parseNumber(form.get("startFromSegment"), 0);
    const providerValue = form.get("transcriptionProvider");
    const cloudProviderValue = form.get("cloudProvider");
    const transcriptionProvider = parseTranscriptionProvider(providerValue);
    const cloudProvider = parseCloudProvider(cloudProviderValue, providerValue);
    const whisperModel = normalizeWhisperModel(
      transcriptionProvider,
      cloudProvider,
      String(form.get("whisperModel") ?? "")
    );
    const existingJobId = String(form.get("existingJobId") ?? "").trim();
    const uploadedAudio = form.get("audio");

    const options: PipelineOptions = {
      nSegments,
      whisperModel,
      transcriptionProvider,
      cloudProvider,
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
