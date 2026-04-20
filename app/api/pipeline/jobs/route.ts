import { NextRequest, NextResponse } from "next/server";
import { deleteJob, listJobs } from "@/lib/pipeline/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const jobs = await listJobs();
  return NextResponse.json({ jobs });
}

export async function DELETE(request: NextRequest) {
  const jobId = request.nextUrl.searchParams.get("jobId")?.trim() ?? "";
  if (!jobId) {
    return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  }

  try {
    const deleted = await deleteJob(jobId);
    if (!deleted) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, jobId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message === "Invalid jobId" ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
