import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileExists } from "@/lib/pipeline/fs";
import { buildSrtFromSegments } from "@/lib/pipeline/srt";
import { CloudTranscriptionProvider, TranscriptionProvider } from "@/lib/pipeline/types";

const execFileAsync = promisify(execFile);
const OPENAI_BASE_URL = "https://api.openai.com";
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_PROVIDER: TranscriptionProvider = "local";
const DEFAULT_MODELS: Record<TranscriptionProvider, string> = {
  local: "large-v3",
  cloud: "whisper-1"
};

async function resolvePythonBinary() {
  if (process.env.WHISPER_PYTHON?.trim()) {
    return process.env.WHISPER_PYTHON.trim();
  }
  const venvPython = path.join(process.cwd(), ".venv", "bin", "python");
  if (await fileExists(venvPython)) {
    return venvPython;
  }
  return "python3";
}

function normalizeProvider(value: string | undefined): TranscriptionProvider {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (
    normalized === "cloud" ||
    normalized === "openai-whisper-cloud" ||
    normalized === "openai-gpt-transcribe"
  ) {
    return "cloud";
  }
  return "local";
}

function resolveProvider(providerOverride?: string): TranscriptionProvider {
  if (providerOverride?.trim()) {
    return normalizeProvider(providerOverride);
  }
  return normalizeProvider(process.env.TRANSCRIPTION_PROVIDER ?? DEFAULT_PROVIDER);
}

function normalizeCloudProvider(value: string | undefined): CloudTranscriptionProvider {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "groq") {
    return "groq";
  }
  return "openai";
}

function resolveCloudProvider(cloudProviderOverride?: string): CloudTranscriptionProvider {
  if (cloudProviderOverride?.trim()) {
    return normalizeCloudProvider(cloudProviderOverride);
  }
  return normalizeCloudProvider(process.env.TRANSCRIPTION_CLOUD_PROVIDER ?? "openai");
}

function resolveCloudProviderWithLegacyHint(
  providerOverride?: string,
  cloudProviderOverride?: string
): CloudTranscriptionProvider {
  if (cloudProviderOverride?.trim()) {
    return normalizeCloudProvider(cloudProviderOverride);
  }
  const legacyProvider = String(providerOverride ?? "")
    .trim()
    .toLowerCase();
  if (legacyProvider === "groq-whisper-cloud") {
    return "groq";
  }
  if (legacyProvider === "openai-whisper-cloud" || legacyProvider === "openai-gpt-transcribe") {
    return "openai";
  }
  return resolveCloudProvider();
}

function resolveModelName(
  provider: TranscriptionProvider,
  cloudProvider: CloudTranscriptionProvider,
  modelName: string
) {
  const normalized = modelName.trim();
  if (!normalized) {
    if (provider === "cloud") {
      return cloudProvider === "groq" ? "whisper-large-v3" : DEFAULT_MODELS.cloud;
    }
    return DEFAULT_MODELS.local;
  }
  if (provider === "cloud") {
    return cloudProvider === "groq" ? "whisper-large-v3" : "whisper-1";
  }
  if (normalized === "large-v3" || normalized === "large-v3-turbo") {
    return normalized;
  }
  return DEFAULT_MODELS.local;
}

function getOpenAiApiKey() {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new Error("OPENAI_API_KEY is required for cloud transcription providers");
  }
  return key;
}

function getOpenAiBaseUrl() {
  return process.env.OPENAI_BASE_URL?.trim() || OPENAI_BASE_URL;
}

function getGroqApiKey() {
  const key = process.env.GROQ_API_KEY?.trim();
  if (!key) {
    throw new Error("GROQ_API_KEY is required for Groq cloud transcription");
  }
  return key;
}

function getGroqBaseUrl() {
  return process.env.GROQ_BASE_URL?.trim() || GROQ_BASE_URL;
}

function numberOrZero(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function appendToken(base: string, token: string) {
  if (!base) {
    return token;
  }
  if (/^[,.;!?)]/.test(token)) {
    return `${base}${token}`;
  }
  return `${base} ${token}`;
}

function parseGroqWordSegments(payload: unknown) {
  const obj = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const wordsRaw = Array.isArray(obj.words) ? obj.words : [];
  const words = wordsRaw
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const word = item as Record<string, unknown>;
      const text = typeof word.word === "string" ? word.word.trim() : "";
      const start = numberOrZero(word.start);
      const end = Math.max(start + 0.05, numberOrZero(word.end));
      if (!text) {
        return null;
      }
      return { text, start, end };
    })
    .filter((item): item is { text: string; start: number; end: number } => item !== null);
  if (words.length === 0) {
    return [];
  }

  const grouped: Array<{ start: number; end: number; text: string }> = [];
  let current: { start: number; end: number; text: string } | null = null;
  for (const word of words) {
    if (!current) {
      current = { start: word.start, end: word.end, text: word.text };
      continue;
    }
    const gapSeconds = word.start - current.end;
    const nextText = appendToken(current.text, word.text);
    const shouldSplit =
      gapSeconds > 0.8 || /[.!?]$/.test(current.text) || nextText.length > 64;
    if (shouldSplit) {
      grouped.push(current);
      current = { start: word.start, end: word.end, text: word.text };
      continue;
    }
    current.text = nextText;
    current.end = word.end;
  }
  if (current) {
    grouped.push(current);
  }
  return grouped;
}

function parseGroqVerboseSegments(payload: unknown) {
  const obj = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const fromWords = parseGroqWordSegments(payload);
  if (fromWords.length > 0) {
    return fromWords;
  }

  const segmentsRaw = Array.isArray(obj.segments) ? obj.segments : [];
  const normalized = segmentsRaw
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const segment = item as Record<string, unknown>;
      const start = numberOrZero(segment.start);
      const end = Math.max(start + 0.1, numberOrZero(segment.end));
      const text = typeof segment.text === "string" ? segment.text.trim() : "";
      if (!text) {
        return null;
      }
      return { start, end, text };
    })
    .filter((item): item is { start: number; end: number; text: string } => item !== null);

  if (normalized.length > 0) {
    return normalized;
  }

  // Fallback if Groq returns only aggregated text.
  const fallbackText = typeof obj.text === "string" ? obj.text.trim() : "";
  if (!fallbackText) {
    return [];
  }
  const duration = Math.max(0.5, numberOrZero(obj.duration));
  return [{ start: 0, end: duration, text: fallbackText }];
}

async function runLocalWhisper(audioPath: string, outputSrtPath: string, modelName: string) {
  const scriptPath = path.join(process.cwd(), "scripts", "run_whisper.py");
  const python = await resolvePythonBinary();
  await execFileAsync(
    python,
    [scriptPath, "--audio", audioPath, "--output", outputSrtPath, "--model", modelName],
    {
      maxBuffer: 10 * 1024 * 1024
    }
  );
}

async function runOpenAiWhisperCloud(audioPath: string, outputSrtPath: string, modelName: string) {
  const bytes = await fs.readFile(audioPath);
  const fileName = path.basename(audioPath) || "audio.mp3";
  const body = new FormData();
  body.append("file", new Blob([bytes]), fileName);
  body.append("model", modelName);
  body.append("response_format", "srt");

  const response = await fetch(`${getOpenAiBaseUrl()}/v1/audio/translations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getOpenAiApiKey()}`
    },
    body
  });
  if (!response.ok) {
    throw new Error(
      `OpenAI Whisper cloud request failed (${response.status}) ${await response.text()}`
    );
  }
  const srt = await response.text();
  await fs.writeFile(outputSrtPath, srt, "utf8");
}

async function runGroqWhisperCloud(audioPath: string, outputSrtPath: string, modelName: string) {
  const bytes = await fs.readFile(audioPath);
  const fileName = path.basename(audioPath) || "audio.mp3";
  const body = new FormData();
  body.append("file", new Blob([bytes]), fileName);
  body.append("model", modelName);
  // Groq does not support direct SRT response; ask for structured translation output and convert.
  body.append("response_format", "verbose_json");

  const response = await fetch(`${getGroqBaseUrl()}/audio/translations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getGroqApiKey()}`
    },
    body
  });
  if (!response.ok) {
    throw new Error(`Groq Whisper cloud request failed (${response.status}) ${await response.text()}`);
  }
  const verbose = (await response.json()) as unknown;
  const segments = parseGroqVerboseSegments(verbose);
  if (segments.length === 0) {
    throw new Error("Groq Whisper cloud returned no timestamp segments");
  }
  const srt = buildSrtFromSegments(segments);
  await fs.writeFile(outputSrtPath, srt, "utf8");
}

export async function runWhisperTranslation(
  audioPath: string,
  outputSrtPath: string,
  modelName: string,
  providerOverride?: string,
  cloudProviderOverride?: string
) {
  const provider = resolveProvider(providerOverride);
  const cloudProvider = resolveCloudProviderWithLegacyHint(providerOverride, cloudProviderOverride);
  const resolvedModel = resolveModelName(provider, cloudProvider, modelName);
  if (provider === "local") {
    await runLocalWhisper(audioPath, outputSrtPath, resolvedModel);
    return;
  }
  if (cloudProvider === "groq") {
    await runGroqWhisperCloud(audioPath, outputSrtPath, resolvedModel);
    return;
  }
  await runOpenAiWhisperCloud(audioPath, outputSrtPath, resolvedModel);
}
