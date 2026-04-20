#!/usr/bin/env python3
import argparse


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", default="large-v3")
    args = parser.parse_args()

    # Delayed import keeps startup error readable if dependency missing.
    import whisper  # type: ignore

    model = whisper.load_model(args.model)
    result = model.transcribe(args.audio, language="yi", task="translate", verbose=False)
    segments = result.get("segments", [])

    lines = []
    for idx, segment in enumerate(segments, start=1):
        start = float(segment.get("start", 0.0))
        end = float(segment.get("end", 0.0))
        text = str(segment.get("text", "")).strip()
        lines.append(str(idx))
        lines.append(f"{format_srt_time(start)} --> {format_srt_time(end)}")
        lines.append(text)
        lines.append("")

    with open(args.output, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
        if lines:
            f.write("\n")


def format_srt_time(seconds: float) -> str:
    total_ms = max(0, int(round(seconds * 1000)))
    ms = total_ms % 1000
    total_s = total_ms // 1000
    s = total_s % 60
    total_m = total_s // 60
    m = total_m % 60
    h = total_m // 60
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


if __name__ == "__main__":
    main()
