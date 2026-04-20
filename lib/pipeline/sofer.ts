import { promises as fs } from "node:fs";

const SUCCESS = new Set(["COMPLETED", "DONE", "SUCCEEDED", "SUCCESS"]);
const FAILURE = new Set(["FAILED", "ERROR"]);

function getSoferBaseUrl() {
  return process.env.SOFERAI_BASE_URL ?? "https://api.sofer.ai/v1";
}

function getSoferApiKey() {
  const key = process.env.SOFERAI_API_KEY;
  if (!key) {
    throw new Error("SOFERAI_API_KEY is required");
  }
  return key;
}

async function soferFetch(path: string, init?: RequestInit) {
  const response = await fetch(`${getSoferBaseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${getSoferApiKey()}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  if (!response.ok) {
    throw new Error(`Sofer request failed (${response.status}) ${await response.text()}`);
  }
  return response.json();
}

function extractTranscriptionId(createResult: unknown) {
  if (typeof createResult === "string" && createResult.trim()) {
    return createResult.trim();
  }
  if (createResult && typeof createResult === "object") {
    const obj = createResult as Record<string, unknown>;
    const id = obj.id ?? obj.transcription_id ?? obj.transcriptionId;
    if (typeof id === "string" && id.trim()) {
      return id.trim();
    }
  }
  return "";
}

function extractStatus(statusResult: unknown) {
  if (typeof statusResult === "string") {
    return statusResult.trim().toUpperCase();
  }
  if (statusResult && typeof statusResult === "object") {
    const obj = statusResult as Record<string, unknown>;
    const status = obj.status ?? obj.state;
    if (typeof status === "string") {
      return status.trim().toUpperCase();
    }
  }
  return "";
}

function extractTranscriptText(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "";
  }

  const obj = result as Record<string, unknown>;
  const directCandidates = [
    obj.text,
    obj.transcript,
    obj.transcription,
    obj.full_text,
    obj.fullText
  ];
  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  const nested = obj.result;
  if (nested && typeof nested === "object") {
    const nestedObj = nested as Record<string, unknown>;
    const nestedCandidates = [
      nestedObj.text,
      nestedObj.transcript,
      nestedObj.transcription,
      nestedObj.full_text,
      nestedObj.fullText
    ];
    for (const candidate of nestedCandidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }
  }

  return "";
}

export async function transcribeWithSofer(audioPath: string, title: string) {
  const bytes = await fs.readFile(audioPath);
  const audioBase64 = bytes.toString("base64");

  const createResult = await soferFetch("/transcriptions/", {
    method: "POST",
    body: JSON.stringify({
      audio_file: audioBase64,
      info: {
        model: "v1",
        primary_language: "yi",
        hebrew_word_format: ["he"],
        title
      }
    })
  });

  const transcriptionId = extractTranscriptionId(createResult);
  if (!transcriptionId) {
    throw new Error(`Sofer create response missing id: ${JSON.stringify(createResult)}`);
  }

  let status = "PENDING";
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    const pollResult = await soferFetch(`/transcriptions/${transcriptionId}/status`);
    status = extractStatus(pollResult);
    if (SUCCESS.has(status)) {
      break;
    }
    if (FAILURE.has(status)) {
      throw new Error(`Sofer transcription failed with status ${status}`);
    }
  }

  const textResult = await soferFetch(`/transcriptions/${transcriptionId}`);
  const text = extractTranscriptText(textResult);
  if (!text) {
    throw new Error(`Sofer transcription returned empty text for id ${transcriptionId}`);
  }

  return { transcriptionId: String(transcriptionId), status, text, rawTextResponse: textResult };
}
