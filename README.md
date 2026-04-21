# Yiddish Lecture Pipeline Portal

Next.js app for running a resumable Yiddish lecture -> English subtitle pipeline:

1. Split uploaded audio into `N` equal segments.
2. Transcribe Yiddish via Sofer.
3. Translate Yiddish lines to English (Gemini).
4. Generate timestamped SRT per segment (configurable local/cloud transcription).
5. Align gold English words to Whisper cue indices (Gemini).
6. Merge all segment alignments into final `final.srt` (+ `final.json`).

## Requirements

- Node.js 20+
- `ffmpeg` and `ffprobe` on PATH
- Python 3.10+ for Whisper
- `pip install -r requirements-whisper.txt`

## Environment Variables

Create `.env.local`:

```bash
SOFERAI_API_KEY=...
SOFERAI_BASE_URL=https://api.sofer.ai/v1
GEMINI_API_KEY=...
TRANSCRIPTION_PROVIDER=local
OPENAI_API_KEY=...
GROQ_API_KEY=...
# optional, defaults by provider if you do not set a model in the UI
# TRANSCRIPTION_PROVIDER=cloud
# TRANSCRIPTION_CLOUD_PROVIDER=openai -> whisper-1
# TRANSCRIPTION_CLOUD_PROVIDER=groq   -> whisper-large-v3
```

Notes:
- `SOFERAI_BASE_URL` defaults to `https://api.sofer.ai/v1`.
- `TRANSCRIPTION_PROVIDER` supports:
  - `local` (models: `large-v3`, `large-v3-turbo`)
  - `cloud` with cloud provider:
    - `openai` (model: `whisper-1`)
    - `groq` (model: `whisper-large-v3`)
- `OPENAI_API_KEY` is required for OpenAI cloud transcription.
- `GROQ_API_KEY` is required for Groq cloud transcription.
- Only allowlisted models are exposed in the UI per cloud provider.
- Groq Whisper uses `/audio/translations` with `response_format=verbose_json` and converts returned timing metadata to SRT cues in-app.
- API keys remain server-side only (route handlers + worker process).

## Install and Run

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## UI Features

- Upload MP3
- Configure:
  - number of segments (default 50)
  - transcription mode (`local` / `cloud`)
  - cloud provider (`openai` / `groq`) when mode is `cloud`
  - transcription model (allowlisted per mode/provider)
  - start-from segment index
- Resume by entering existing job ID
- Delete existing jobs from the jobs list
- Polling live segment/step status
- Download:
  - final SRT
  - final merged JSON
  - state JSON

## Job Storage Layout

All data is local under `pipeline/jobs/<jobId>/`:

- `input/source.mp3`
- `config.json`
- `state.json`
- `plan.json`
- `segment_000/...`
  - `audio.mp3`
  - `yiddish.txt`
  - `gold_translation.txt`
  - `whisper.srt`
  - `alignment.json`
  - `logs/`
- `final.srt`
- `final.json`

## Worker Model

Jobs are executed in a detached background process started by `/api/pipeline/start`, via:

```bash
npm run pipeline:run -- <jobId>
```

This avoids long-running HTTP requests and supports resumability with state persistence.
