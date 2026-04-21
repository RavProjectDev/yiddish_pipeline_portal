import { GoogleGenerativeAI } from "@google/generative-ai";

const GEMINI_MODEL = "gemini-3.1-pro-preview";

function getClient() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("GEMINI_API_KEY is required");
  }
  return new GoogleGenerativeAI(key);
}

export async function translateYiddishLines(lines: Array<{ line_index: number; text: string }>) {
  const client = getClient();
  const model = client.getGenerativeModel({ model: GEMINI_MODEL });

  const promptLines = lines.map((line) => `[${line.line_index}] ${line.text}`).join("\n");
  const systemPrompt =
    "You are an expert Yiddish-to-English translator specializing in Torah " +
    "lectures and religious discourse. Translate the numbered Yiddish lines " +
    "into natural, fluent English. Preserve meaning and keep Hebrew/Aramaic " +
    "terms as-is. Return a JSON array where each element has keys " +
    '"line_index" (integer) and "translation" (English string). ' +
    "Output ONLY the JSON array — no markdown, no explanation.";

  const response = await model.generateContent({
    contents: [
      { role: "user", parts: [{ text: `${systemPrompt}\n\n${promptLines}` }] }
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 8192,
      responseMimeType: "application/json"
    }
  });

  const text = response.response.text();
  return { raw: text };
}

export async function alignGoldToSrt(goldWords: string[], srtEntries: Array<{ index: string; text: string }>) {
  const client = getClient();
  const model = client.getGenerativeModel({ model: GEMINI_MODEL });

  const goldWithIndices = goldWords.map((word, idx) => `${word}[${idx + 1}]`).join(" ");
  const srtSection = srtEntries.map((entry) => `[${entry.index}] ${entry.text}`).join("\n");

  const systemPrompt =
    "You are an expert alignment assistant for religious lecture transcripts.\n" +
    "Align every gold word index to one SRT entry index.\n" +
    "Output exactly one JSON object where keys are SRT entry numbers as strings, and values are objects.\n" +
    "Rules:\n" +
    "1) Every gold index from 1..wordCount appears exactly once.\n" +
    "2) Indices strictly ascend within each array and across all arrays in numeric SRT order.\n" +
    '3) Each value object must include keys "indexes" (array of integers) and "confidence" (number 0..1).\n' +
    "4) If a line has no gold words use indexes: [].\n" +
    "5) confidence reflects certainty that this cue received the correct gold words.\n" +
    "6) Output JSON only, no markdown/commentary.";

  const userPrompt = `Gold words with indices:\n${goldWithIndices}\n\nWhisper cues:\n${srtSection}`;
  const response = await model.generateContent({
    contents: [
      {
        role: "user",
        parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }]
      }
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 65536,
      responseMimeType: "application/json"
    }
  });

  const text = response.response.text();
  return { raw: text };
}

export function geminiModelName() {
  return GEMINI_MODEL;
}
