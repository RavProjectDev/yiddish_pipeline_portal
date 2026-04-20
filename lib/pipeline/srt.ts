import { WhisperCue } from "@/lib/pipeline/types";

function pad(value: number, width: number) {
  return String(value).padStart(width, "0");
}

export function secondsToSrtTime(totalSeconds: number) {
  const milliseconds = Math.max(0, Math.round(totalSeconds * 1000));
  const ms = milliseconds % 1000;
  const total = Math.floor(milliseconds / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

export function buildSrtFromSegments(
  segments: Array<{ start: number; end: number; text: string }>
) {
  const blocks = segments.map((segment, idx) => {
    return [
      String(idx + 1),
      `${secondsToSrtTime(segment.start)} --> ${secondsToSrtTime(segment.end)}`,
      segment.text.trim()
    ].join("\n");
  });
  return `${blocks.join("\n\n")}\n`;
}

export function parseSrt(raw: string): WhisperCue[] {
  const blocks = raw.split(/\n\s*\n/g).map((block) => block.trim()).filter(Boolean);
  return blocks
    .map((block) => {
      const lines = block.split("\n").map((line) => line.trim());
      if (lines.length < 3) {
        return null;
      }
      return {
        index: lines[0],
        timestamp: lines[1],
        text: lines.slice(2).join(" ").trim()
      };
    })
    .filter((entry): entry is WhisperCue => entry !== null);
}
