import { runPipelineJob } from "../lib/pipeline/runner";
import { setJobStatus } from "../lib/pipeline/state";

async function main() {
  const jobId = process.argv[2];
  if (!jobId) {
    throw new Error("Usage: npm run pipeline:run -- <jobId>");
  }
  try {
    await runPipelineJob(jobId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await setJobStatus(jobId, "FAILED", message);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
