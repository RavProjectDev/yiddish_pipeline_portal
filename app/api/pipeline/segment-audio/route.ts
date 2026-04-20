import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { fileExists } from "@/lib/pipeline/fs";
import { isValidJobId } from "@/lib/pipeline/jobs";
import { getSegmentDir } from "@/lib/pipeline/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

function getSegmentAudioPath(jobId: string, segmentIndex: number) {
  return path.join(getSegmentDir(jobId, segmentIndex), "audio.mp3");
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

  const audioPath = getSegmentAudioPath(jobId, segmentIndex);
  if (!(await fileExists(audioPath))) {
    return NextResponse.json({ error: "Segment audio not found" }, { status: 404 });
  }

  const data = await fs.readFile(audioPath);
  return new NextResponse(data, {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store"
    }
  });
}
