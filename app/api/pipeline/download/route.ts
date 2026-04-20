import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { fileExists } from "@/lib/pipeline/fs";
import { getJobDir, getJobStatePath } from "@/lib/pipeline/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const jobId = request.nextUrl.searchParams.get("jobId");
  const type = request.nextUrl.searchParams.get("type") ?? "srt";
  if (!jobId) {
    return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  }

  let filePath = "";
  let contentType = "text/plain; charset=utf-8";
  let filename = "";

  if (type === "srt") {
    filePath = path.join(getJobDir(jobId), "final.srt");
    filename = `${jobId}.srt`;
  } else if (type === "json") {
    filePath = path.join(getJobDir(jobId), "final.json");
    contentType = "application/json";
    filename = `${jobId}.json`;
  } else if (type === "state") {
    filePath = getJobStatePath(jobId);
    contentType = "application/json";
    filename = `${jobId}.state.json`;
  } else {
    return NextResponse.json({ error: "Unsupported download type" }, { status: 400 });
  }

  if (!(await fileExists(filePath))) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const data = await fs.readFile(filePath);
  return new NextResponse(data, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`
    }
  });
}
