import { promises as fs } from "node:fs";
import path from "node:path";
import { getAudioDurationSeconds, splitAudioSegment } from "@/lib/pipeline/ffmpeg";
import { ensureDir, fileExists, readJsonFile, writeJsonFile } from "@/lib/pipeline/fs";
import { alignGoldToSrt, geminiModelName, translateYiddishLines } from "@/lib/pipeline/gemini";
import { getJobConfigPath, getPlanPath, getSegmentDir, getSegmentLogsDir } from "@/lib/pipeline/paths";
import { transcribeWithSofer } from "@/lib/pipeline/sofer";
import { parseSrt } from "@/lib/pipeline/srt";
import { readState, setJobStatus, updateStep } from "@/lib/pipeline/state";
import { AlignmentFile, PipelineConfig, WhisperCue } from "@/lib/pipeline/types";
import { runWhisperTranslation } from "@/lib/pipeline/whisper";

const MAX_ALIGN_RETRIES = 5;

function normalizeStatus(value: string | undefined) {
  return String(value ?? "").trim().toUpperCase();
}

function splitNonEmptyIndexedLines(text: string) {
  return text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, idx) => ({ line_index: idx + 1, text: line }));
}

function wordsFromTranslation(text: string) {
  if (!text.trim()) {
    return [];
  }
  return text.split(/\s+/g).filter(Boolean);
}

async function appendLog(filePath: string, data: string) {
  await fs.appendFile(filePath, `${data}\n`, "utf8");
}

function parseTimestampLine(timestampLine: string) {
  const match = timestampLine.match(
    /^(\d{2}:\d{2}:\d{2},\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2},\d{3})$/
  );
  if (!match) {
    return null;
  }
  return { start: match[1], end: match[2] };
}

function srtTimeToMs(value: string) {
  const match = value.match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/);
  if (!match) {
    return 0;
  }
  const [_, hh, mm, ss, ms] = match;
  return Number(hh) * 3600000 + Number(mm) * 60000 + Number(ss) * 1000 + Number(ms);
}

function msToSrtTime(value: number) {
  const clamped = Math.max(0, Math.floor(value));
  const ms = clamped % 1000;
  const secTotal = Math.floor(clamped / 1000);
  const ss = secTotal % 60;
  const minTotal = Math.floor(secTotal / 60);
  const mm = minTotal % 60;
  const hh = Math.floor(minTotal / 60);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(
    2,
    "0"
  )},${String(ms).padStart(3, "0")}`;
}

function addOffsetToTimestampLine(timestampLine: string, segmentOffsetSeconds: number) {
  const parsed = parseTimestampLine(timestampLine);
  if (!parsed) {
    return timestampLine;
  }
  const offset = Math.floor(segmentOffsetSeconds * 1000);
  return `${msToSrtTime(srtTimeToMs(parsed.start) + offset)} --> ${msToSrtTime(
    srtTimeToMs(parsed.end) + offset
  )}`;
}

async function runTranslateStep(segmentDir: string, logsDir: string) {
  const yiddishPath = path.join(segmentDir, "yiddish.txt");
  const goldPath = path.join(segmentDir, "gold_translation.txt");
  const source = await fs.readFile(yiddishPath, "utf8");
  const lines = splitNonEmptyIndexedLines(source);

  if (lines.length === 0) {
    await fs.writeFile(goldPath, "", "utf8");
    return;
  }

  const translateLogPath = path.join(logsDir, "translate.log");
  const translatedByIndex = new Map<number, string>();
  for (let cursor = 0; cursor < lines.length; cursor += 5) {
    const batch = lines.slice(cursor, cursor + 5);
    const result = await translateYiddishLines(batch);
    await appendLog(
      translateLogPath,
      JSON.stringify(
        {
          batch_start: cursor + 1,
          batch_size: batch.length,
          source: batch,
          raw_response: result.raw
        },
        null,
        2
      )
    );

    let parsed: Array<{ line_index: number; translation: string }> = [];
    try {
      parsed = JSON.parse(result.raw) as Array<{ line_index: number; translation: string }>;
    } catch {
      parsed = [];
    }
    for (const row of parsed) {
      translatedByIndex.set(row.line_index, row.translation ?? "");
    }
  }

  const finalText = lines.map((line) => translatedByIndex.get(line.line_index) ?? "").join("\n");
  await fs.writeFile(goldPath, finalText, "utf8");
}

async function runAlignStep(segmentIndex: number, segmentDir: string, logsDir: string, cues: WhisperCue[]) {
  const goldPath = path.join(segmentDir, "gold_translation.txt");
  const alignmentPath = path.join(segmentDir, "alignment.json");
  const errorLogPath = path.join(logsDir, "align-errors.log");
  const goldWords = wordsFromTranslation(await fs.readFile(goldPath, "utf8"));

  if (goldWords.length === 0 || cues.length === 0) {
    const minimal: AlignmentFile = {
      meta: {
        segment_index: segmentIndex,
        gold_word_count: goldWords.length,
        srt_entry_count: cues.length,
        model_id: geminiModelName(),
        created_at: new Date().toISOString()
      },
      index_alignment: {},
      word_alignment: {},
      merged_srt: {}
    };
    await writeJsonFile(alignmentPath, minimal);
    return;
  }

  let indexAlignment: Record<string, number[]> = {};
  let parsedOk = false;
  for (let attempt = 0; attempt < MAX_ALIGN_RETRIES; attempt += 1) {
    try {
      const alignResult = await alignGoldToSrt(
        goldWords,
        cues.map((cue) => ({ index: cue.index, text: cue.text }))
      );
      indexAlignment = JSON.parse(alignResult.raw) as Record<string, number[]>;
      parsedOk = true;
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await appendLog(
        errorLogPath,
        `${new Date().toISOString()} attempt=${attempt} error=${message}`
      );
      if (attempt < MAX_ALIGN_RETRIES - 1) {
        const backoffMs = 5 * 1000 * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }

  if (!parsedOk) {
    throw new Error("Alignment failed after retries");
  }

  const wordAlignment: Record<string, string[]> = {};
  const mergedSrt: AlignmentFile["merged_srt"] = {};
  const sortedKeys = Object.keys(indexAlignment).sort((a, b) => Number(a) - Number(b));

  for (const key of sortedKeys) {
    const indexes = indexAlignment[key] ?? [];
    wordAlignment[key] = indexes
      .filter((idx) => Number.isInteger(idx) && idx >= 1 && idx <= goldWords.length)
      .map((idx) => goldWords[idx - 1]);

    const cue = cues.find((entry) => entry.index === key);
    mergedSrt[key] = {
      timestamp: cue?.timestamp ?? "",
      srt_text: cue?.text ?? "",
      gold_words: wordAlignment[key]
    };
  }

  const alignment: AlignmentFile = {
    meta: {
      segment_index: segmentIndex,
      gold_word_count: goldWords.length,
      srt_entry_count: cues.length,
      model_id: geminiModelName(),
      created_at: new Date().toISOString()
    },
    index_alignment: indexAlignment,
    word_alignment: wordAlignment,
    merged_srt: mergedSrt
  };
  await writeJsonFile(alignmentPath, alignment);
}

async function runMerge(jobId: string, nSegments: number, segmentLengthSeconds: number) {
  const jobDir = path.join(process.cwd(), "pipeline", "jobs", jobId);
  let globalIndex = 1;
  const srtBlocks: string[] = [];
  const finalRows: Array<{
    global_index: number;
    segment: number;
    local_index: string;
    timestamp: string;
    text: string;
  }> = [];

  for (let segment = 0; segment < nSegments; segment += 1) {
    const alignmentPath = path.join(getSegmentDir(jobId, segment), "alignment.json");
    if (!(await fileExists(alignmentPath))) {
      continue;
    }
    const data = await readJsonFile<AlignmentFile>(alignmentPath);
    const keys = Object.keys(data.merged_srt ?? {}).sort((a, b) => Number(a) - Number(b));

    for (const key of keys) {
      const cue = data.merged_srt[key];
      if (!cue || !cue.gold_words || cue.gold_words.length === 0) {
        continue;
      }
      const text = cue.gold_words.join(" ");
      const timestamp = addOffsetToTimestampLine(cue.timestamp, segment * segmentLengthSeconds);
      srtBlocks.push([String(globalIndex), timestamp, text].join("\n"));
      finalRows.push({
        global_index: globalIndex,
        segment,
        local_index: key,
        timestamp,
        text
      });
      globalIndex += 1;
    }
  }

  const outputSrtPath = path.join(jobDir, "final.srt");
  const outputJsonPath = path.join(jobDir, "final.json");
  await fs.writeFile(outputSrtPath, srtBlocks.length ? `${srtBlocks.join("\n\n")}\n` : "", "utf8");
  await writeJsonFile(outputJsonPath, finalRows);
}

export async function regenerateMergedOutputs(jobId: string) {
  const configPath = getJobConfigPath(jobId);
  const config = await readJsonFile<PipelineConfig>(configPath);
  const nSegments = config.options.nSegments;

  let segmentLengthSeconds = 0;
  const planPath = getPlanPath(jobId);
  if (await fileExists(planPath)) {
    const plan = await readJsonFile<{ segment_length_seconds?: number }>(planPath);
    segmentLengthSeconds = Number(plan.segment_length_seconds ?? 0);
  }

  if (segmentLengthSeconds <= 0) {
    const duration = await getAudioDurationSeconds(config.sourceAudioPath);
    segmentLengthSeconds = duration / nSegments;
  }

  await runMerge(jobId, nSegments, segmentLengthSeconds);
}

export async function runPipelineJob(jobId: string) {
  const configPath = getJobConfigPath(jobId);
  const config = await readJsonFile<PipelineConfig>(configPath);
  const { options } = config;
  const { nSegments, startFromSegment, whisperModel } = options;
  const duration = await getAudioDurationSeconds(config.sourceAudioPath);
  const segmentLength = duration / nSegments;

  const segmentPlan = Array.from({ length: nSegments }, (_, index) => ({
    segment: index,
    start_seconds: Number((index * segmentLength).toFixed(3)),
    duration_seconds: Number(segmentLength.toFixed(3))
  }));

  await writeJsonFile(getPlanPath(jobId), {
    source_audio: config.sourceAudioPath,
    duration_seconds: duration,
    n_segments: nSegments,
    segment_length_seconds: segmentLength,
    plan: segmentPlan
  });

  await setJobStatus(jobId, "RUNNING");
  let hadFailures = false;

  for (let segmentIndex = startFromSegment; segmentIndex < nSegments; segmentIndex += 1) {
    const state = await readState(jobId);
    const segmentState = state.segments[String(segmentIndex)];
    const segmentDir = getSegmentDir(jobId, segmentIndex);
    const logsDir = getSegmentLogsDir(jobId, segmentIndex);
    await ensureDir(segmentDir);
    await ensureDir(logsDir);

    const audioPath = path.join(segmentDir, "audio.mp3");
    const yiddishPath = path.join(segmentDir, "yiddish.txt");
    const goldPath = path.join(segmentDir, "gold_translation.txt");
    const whisperPath = path.join(segmentDir, "whisper.srt");
    const alignmentPath = path.join(segmentDir, "alignment.json");

    let segmentFailed = false;
    let cues: WhisperCue[] = [];

    try {
      if (segmentState.audio !== "DONE" || !(await fileExists(audioPath))) {
        await updateStep(jobId, segmentIndex, "audio", "RUNNING");
        await splitAudioSegment(
          config.sourceAudioPath,
          audioPath,
          segmentIndex * segmentLength,
          segmentLength
        );
        await updateStep(jobId, segmentIndex, "audio", "DONE");
      }
    } catch (error) {
      segmentFailed = true;
      hadFailures = true;
      await updateStep(jobId, segmentIndex, "audio", "FAILED");
      await appendLog(
        path.join(logsDir, "audio-error.log"),
        `${new Date().toISOString()} error=${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (segmentFailed) {
      continue;
    }

    try {
      if (segmentState.sofer !== "DONE" || !(await fileExists(yiddishPath))) {
        await updateStep(jobId, segmentIndex, "sofer", "RUNNING");
        const result = await transcribeWithSofer(audioPath, `segment_${String(segmentIndex).padStart(3, "0")}`);
        await fs.writeFile(yiddishPath, result.text, "utf8");
        await appendLog(
          path.join(logsDir, "sofer.log"),
          JSON.stringify(
            {
              transcription_id: result.transcriptionId,
              status: normalizeStatus(result.status),
              text: result.text
            },
            null,
            2
          )
        );
        await updateStep(jobId, segmentIndex, "sofer", "DONE");
      }
    } catch (error) {
      segmentFailed = true;
      hadFailures = true;
      await updateStep(jobId, segmentIndex, "sofer", "FAILED");
      await appendLog(
        path.join(logsDir, "sofer-error.log"),
        `${new Date().toISOString()} error=${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (segmentFailed) {
      continue;
    }

    try {
      if (segmentState.translate !== "DONE" || !(await fileExists(goldPath))) {
        await updateStep(jobId, segmentIndex, "translate", "RUNNING");
        await runTranslateStep(segmentDir, logsDir);
        await updateStep(jobId, segmentIndex, "translate", "DONE");
      }
    } catch (error) {
      segmentFailed = true;
      hadFailures = true;
      await updateStep(jobId, segmentIndex, "translate", "FAILED");
      await appendLog(
        path.join(logsDir, "translate-error.log"),
        `${new Date().toISOString()} error=${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (segmentFailed) {
      continue;
    }

    try {
      if (segmentState.whisper !== "DONE" || !(await fileExists(whisperPath))) {
        await updateStep(jobId, segmentIndex, "whisper", "RUNNING");
        await runWhisperTranslation(audioPath, whisperPath, whisperModel);
        await updateStep(jobId, segmentIndex, "whisper", "DONE");
      }
      const rawSrt = await fs.readFile(whisperPath, "utf8");
      cues = parseSrt(rawSrt);
    } catch (error) {
      segmentFailed = true;
      hadFailures = true;
      await updateStep(jobId, segmentIndex, "whisper", "FAILED");
      await appendLog(
        path.join(logsDir, "whisper-error.log"),
        `${new Date().toISOString()} error=${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (segmentFailed) {
      continue;
    }

    try {
      if (segmentState.align !== "DONE" || !(await fileExists(alignmentPath))) {
        await updateStep(jobId, segmentIndex, "align", "RUNNING");
        await runAlignStep(segmentIndex, segmentDir, logsDir, cues);
        await updateStep(jobId, segmentIndex, "align", "DONE");
      }
    } catch (error) {
      hadFailures = true;
      await updateStep(jobId, segmentIndex, "align", "FAILED");
      await appendLog(
        path.join(logsDir, "align-errors.log"),
        `${new Date().toISOString()} error=${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  await runMerge(jobId, nSegments, segmentLength);
  if (hadFailures) {
    await setJobStatus(jobId, "FAILED", "One or more segments failed. Check segment logs for details.");
  } else {
    await setJobStatus(jobId, "DONE");
  }
}
