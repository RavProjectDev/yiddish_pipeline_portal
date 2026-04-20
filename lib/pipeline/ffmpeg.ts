import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function getAudioDurationSeconds(inputPath: string) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=nokey=1:noprint_wrappers=1",
    inputPath
  ]);
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Invalid audio duration from ffprobe: ${stdout}`);
  }
  return duration;
}

export async function splitAudioSegment(
  inputPath: string,
  outputPath: string,
  startSeconds: number,
  durationSeconds: number
) {
  await execFileAsync("ffmpeg", [
    "-y",
    "-ss",
    `${startSeconds}`,
    "-i",
    inputPath,
    "-t",
    `${durationSeconds}`,
    "-c:a",
    "libmp3lame",
    "-q:a",
    "2",
    outputPath
  ]);
}
