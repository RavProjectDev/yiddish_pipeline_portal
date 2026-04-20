# Yiddish Lecture Pipeline Portal

Next.js app for running a resumable Yiddish lecture -> English subtitle pipeline:

1. Split uploaded audio into `N` equal segments.
2. Transcribe Yiddish via Sofer.
3. Translate Yiddish lines to English (Gemini).
4. Generate timestamped SRT per segment (local Whisper, `task=translate`).
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
```

Notes:
- `SOFERAI_BASE_URL` defaults to `https://api.sofer.ai/v1`.
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
  - Whisper model (default `large-v3`)
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
