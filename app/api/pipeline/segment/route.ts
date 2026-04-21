import path from "node:path";
import { promises as fs } from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import { fileExists, readJsonFile, writeJsonFile } from "@/lib/pipeline/fs";
import { isValidJobId } from "@/lib/pipeline/jobs";
import { getSegmentDir } from "@/lib/pipeline/paths";
import { regenerateMergedOutputs } from "@/lib/pipeline/runner";
import { parseSrt } from "@/lib/pipeline/srt";
import { AlignmentFile } from "@/lib/pipeline/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SegmentEditorRow = {
  cueIndex: string;
  timestamp: string;
  finalSrtText: string;
  yiddishText: string;
  confidence?: number;
};

function parseSegmentIndex(value: string | null) {
  if (!value) {
    return null;
  }
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0) {
    return null;
  }
  return index;
}

function wordsFromText(value: string) {
  if (!value.trim()) {
    return [];
  }
  return value.split(/\s+/g).filter(Boolean);
}

function toEditorRows(alignment: AlignmentFile): SegmentEditorRow[] {
  return Object.keys(alignment.merged_srt ?? {})
    .sort((a, b) => Number(a) - Number(b))
    .map((key) => {
      const cue = alignment.merged_srt[key];
      return {
        cueIndex: key,
        timestamp: cue.timestamp ?? "",
        finalSrtText: Array.isArray(cue.gold_words) ? cue.gold_words.join(" ") : "",
        yiddishText: cue.srt_text ?? "",
        confidence: typeof cue.confidence === "number" ? cue.confidence : undefined
      };
    });
}

function getAlignmentPath(jobId: string, segmentIndex: number) {
  return path.join(getSegmentDir(jobId, segmentIndex), "alignment.json");
}

function getWhisperPath(jobId: string, segmentIndex: number) {
  return path.join(getSegmentDir(jobId, segmentIndex), "whisper.srt");
}

function getSoferTextPath(jobId: string, segmentIndex: number) {
  return path.join(getSegmentDir(jobId, segmentIndex), "yiddish.txt");
}

async function buildEditorRows(
  jobId: string,
  segmentIndex: number,
  alignment: AlignmentFile
): Promise<SegmentEditorRow[]> {
  const mergedRows = toEditorRows(alignment);
  if (mergedRows.length > 0) {
    return mergedRows;
  }

  const whisperPath = getWhisperPath(jobId, segmentIndex);
  if (!(await fileExists(whisperPath))) {
    return [];
  }

  const raw = await fs.readFile(whisperPath, "utf8");
  const cues = parseSrt(raw);
  return cues.map((cue) => {
    const mergedCue = alignment.merged_srt?.[cue.index];
    return {
      cueIndex: cue.index,
      timestamp: cue.timestamp,
      finalSrtText: (alignment.word_alignment?.[cue.index] ?? []).join(" "),
      yiddishText: cue.text,
      confidence: typeof mergedCue?.confidence === "number" ? mergedCue.confidence : undefined
    };
  });
}

async function readSoferText(jobId: string, segmentIndex: number) {
  const soferTextPath = getSoferTextPath(jobId, segmentIndex);
  if (!(await fileExists(soferTextPath))) {
    return "";
  }
  return fs.readFile(soferTextPath, "utf8");
}

export async function GET(request: NextRequest) {
  const jobId = request.nextUrl.searchParams.get("jobId")?.trim() ?? "";
  const segmentIndex = parseSegmentIndex(request.nextUrl.searchParams.get("segmentIndex"));
  if (!jobId || segmentIndex === null) {
    return NextResponse.json({ error: "jobId and segmentIndex are required" }, { status: 400 });
  }
  if (!isValidJobId(jobId)) {
    return NextResponse.json({ error: "Invalid jobId" }, { status: 400 });
  }

  const alignmentPath = getAlignmentPath(jobId, segmentIndex);
  if (!(await fileExists(alignmentPath))) {
    return NextResponse.json({ error: "Segment alignment not found" }, { status: 404 });
  }

  const alignment = await readJsonFile<AlignmentFile>(alignmentPath);
  return NextResponse.json({
    jobId,
    segmentIndex,
    rows: await buildEditorRows(jobId, segmentIndex, alignment),
    soferText: await readSoferText(jobId, segmentIndex)
  });
}

export async function PUT(request: NextRequest) {
  const jobId = request.nextUrl.searchParams.get("jobId")?.trim() ?? "";
  const segmentIndex = parseSegmentIndex(request.nextUrl.searchParams.get("segmentIndex"));
  if (!jobId || segmentIndex === null) {
    return NextResponse.json({ error: "jobId and segmentIndex are required" }, { status: 400 });
  }
  if (!isValidJobId(jobId)) {
    return NextResponse.json({ error: "Invalid jobId" }, { status: 400 });
  }

  const alignmentPath = getAlignmentPath(jobId, segmentIndex);
  if (!(await fileExists(alignmentPath))) {
    return NextResponse.json({ error: "Segment alignment not found" }, { status: 404 });
  }

  const body = (await request.json()) as { rows?: SegmentEditorRow[]; soferText?: string };
  if (!Array.isArray(body.rows)) {
    return NextResponse.json({ error: "rows must be an array" }, { status: 400 });
  }

  const alignment = await readJsonFile<AlignmentFile>(alignmentPath);
  alignment.merged_srt ??= {};
  alignment.word_alignment ??= {};
  alignment.meta ??= {
    segment_index: segmentIndex,
    gold_word_count: 0,
    srt_entry_count: 0,
    model_id: "unknown",
    created_at: new Date().toISOString()
  };

  for (const row of body.rows) {
    const cueIndex = String(row?.cueIndex ?? "").trim();
    if (!cueIndex) {
      return NextResponse.json({ error: `Invalid cueIndex: ${cueIndex}` }, { status: 400 });
    }

    const existingCue = alignment.merged_srt[cueIndex];
    alignment.merged_srt[cueIndex] = {
      timestamp: String(row.timestamp ?? existingCue?.timestamp ?? ""),
      srt_text: String(row.yiddishText ?? existingCue?.srt_text ?? ""),
      gold_words: wordsFromText(String(row.finalSrtText ?? existingCue?.gold_words?.join(" ") ?? "")),
      confidence:
        typeof row.confidence === "number"
          ? row.confidence
          : typeof existingCue?.confidence === "number"
            ? existingCue.confidence
            : undefined
    };
    const cue = alignment.merged_srt[cueIndex];
    cue.timestamp = String(row.timestamp ?? cue.timestamp ?? "");
    cue.srt_text = String(row.yiddishText ?? "");
    cue.gold_words = wordsFromText(String(row.finalSrtText ?? ""));
    alignment.word_alignment[cueIndex] = cue.gold_words;
  }

  const keys = Object.keys(alignment.merged_srt);
  alignment.meta.srt_entry_count = keys.length;
  alignment.meta.gold_word_count = keys.reduce(
    (sum, key) => sum + (alignment.merged_srt[key]?.gold_words?.length ?? 0),
    0
  );

  await writeJsonFile(alignmentPath, alignment);
  if (typeof body.soferText === "string") {
    await fs.writeFile(getSoferTextPath(jobId, segmentIndex), body.soferText, "utf8");
  }
  await regenerateMergedOutputs(jobId);

  return NextResponse.json({
    ok: true,
    jobId,
    segmentIndex,
    rows: await buildEditorRows(jobId, segmentIndex, alignment),
    soferText: await readSoferText(jobId, segmentIndex)
  });
}
