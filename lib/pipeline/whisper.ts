import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileExists } from "@/lib/pipeline/fs";

const execFileAsync = promisify(execFile);

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

export async function runWhisperTranslation(audioPath: string, outputSrtPath: string, modelName: string) {
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
