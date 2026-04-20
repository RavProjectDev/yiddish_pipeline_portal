import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { fileExists, readJsonFile } from "@/lib/pipeline/fs";
import { getJobConfigPath, getJobDir, getJobStatePath, getPlanPath } from "@/lib/pipeline/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const jobId = request.nextUrl.searchParams.get("jobId");
  if (!jobId) {
    return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  }

  const statePath = getJobStatePath(jobId);
  const configPath = getJobConfigPath(jobId);
  const planPath = getPlanPath(jobId);
  if (!(await fileExists(statePath))) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const [state, config] = await Promise.all([readJsonFile(statePath), readJsonFile(configPath)]);
  const plan = (await fileExists(planPath)) ? await readJsonFile(planPath) : null;
  const outputSrt = path.join(getJobDir(jobId), "final.srt");
  const outputJson = path.join(getJobDir(jobId), "final.json");

  return NextResponse.json({
    jobId,
    state,
    config,
    plan,
    outputs: {
      srt: await fileExists(outputSrt),
      json: await fileExists(outputJson)
    }
  });
}
