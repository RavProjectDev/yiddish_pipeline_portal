"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

type StepStatus = "PENDING" | "RUNNING" | "DONE" | "FAILED";
type SegmentState = Record<"audio" | "sofer" | "translate" | "whisper" | "align", StepStatus>;

type StatusResponse = {
  jobId: string;
  state: {
    n_segments: number;
    job_status: "PENDING" | "RUNNING" | "DONE" | "FAILED";
    updated_at: string;
    error?: string;
    segments: Record<string, SegmentState>;
  };
  config: {
    options: {
      nSegments: number;
      whisperModel: string;
      startFromSegment: number;
    };
  };
  plan: {
    duration_seconds: number;
    segment_length_seconds: number;
  } | null;
  outputs: {
    srt: boolean;
    json: boolean;
  };
};

type SegmentEditorRow = {
  cueIndex: string;
  timestamp: string;
  finalSrtText: string;
  yiddishText: string;
};

const STEP_ORDER: Array<keyof SegmentState> = ["audio", "sofer", "translate", "whisper", "align"];

export default function Page() {
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [nSegments, setNSegments] = useState(50);
  const [whisperModel, setWhisperModel] = useState("large-v3");
  const [startFromSegment, setStartFromSegment] = useState(0);
  const [existingJobId, setExistingJobId] = useState("");
  const [jobId, setJobId] = useState("");
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [jobs, setJobs] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [isStarting, setIsStarting] = useState(false);
  const [deletingJobId, setDeletingJobId] = useState("");
  const [selectedSegmentIndex, setSelectedSegmentIndex] = useState<number | null>(null);
  const [editorRows, setEditorRows] = useState<SegmentEditorRow[]>([]);
  const [isEditorLoading, setIsEditorLoading] = useState(false);
  const [isEditorSaving, setIsEditorSaving] = useState(false);
  const [editorError, setEditorError] = useState("");
  const [editorMessage, setEditorMessage] = useState("");
  const [soferFullText, setSoferFullText] = useState("");
  const editorCardRef = useRef<HTMLDivElement | null>(null);

  const selectedJobId = useMemo(() => jobId || existingJobId.trim(), [existingJobId, jobId]);
  const completedSegments = useMemo(
    () =>
      status
        ? Object.entries(status.state.segments)
            .filter(([, segment]) => segment.align === "DONE")
            .map(([index]) => Number(index))
            .sort((a, b) => a - b)
        : [],
    [status]
  );

  async function refreshJobs() {
    try {
      const res = await fetch("/api/pipeline/jobs");
      const data = await res.json();
      setJobs(Array.isArray(data.jobs) ? data.jobs : []);
    } catch {
      setJobs([]);
    }
  }

  useEffect(() => {
    void refreshJobs();
  }, []);

  useEffect(() => {
    if (!selectedJobId) {
      return;
    }
    let stopped = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/pipeline/status?jobId=${encodeURIComponent(selectedJobId)}`);
        const data = await res.json();
        if (!stopped && res.ok) {
          setStatus(data as StatusResponse);
        }
      } catch {
        // keep trying on the next interval
      }
    };
    void poll();
    const id = window.setInterval(() => void poll(), 3000);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [selectedJobId]);

  useEffect(() => {
    setSelectedSegmentIndex(null);
    setEditorRows([]);
    setSoferFullText("");
    setEditorError("");
    setEditorMessage("");
  }, [selectedJobId]);

  const loadSegmentEditor = useCallback(
    async (segmentIndex: number) => {
      if (!selectedJobId) {
        return;
      }
      setIsEditorLoading(true);
      setEditorError("");
      setEditorMessage("");
      try {
        const res = await fetch(
          `/api/pipeline/segment?jobId=${encodeURIComponent(selectedJobId)}&segmentIndex=${segmentIndex}`
        );
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error ?? "Unable to load segment editor");
        }
        setSelectedSegmentIndex(segmentIndex);
        setEditorRows(Array.isArray(data.rows) ? (data.rows as SegmentEditorRow[]) : []);
        setSoferFullText(typeof data.soferText === "string" ? data.soferText : "");
      } catch (segmentError) {
        setEditorError(segmentError instanceof Error ? segmentError.message : String(segmentError));
      } finally {
        setIsEditorLoading(false);
      }
    },
    [selectedJobId]
  );

  useEffect(() => {
    if (selectedSegmentIndex !== null || completedSegments.length === 0) {
      return;
    }
    void loadSegmentEditor(completedSegments[0]);
  }, [completedSegments, selectedSegmentIndex, loadSegmentEditor]);

  useEffect(() => {
    if (selectedSegmentIndex === null) {
      return;
    }
    editorCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selectedSegmentIndex]);

  async function onStart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setIsStarting(true);
    try {
      const formData = new FormData();
      if (audioFile) {
        formData.append("audio", audioFile);
      }
      formData.append("nSegments", String(nSegments));
      formData.append("whisperModel", whisperModel);
      formData.append("startFromSegment", String(startFromSegment));
      if (existingJobId.trim()) {
        formData.append("existingJobId", existingJobId.trim());
      }

      const res = await fetch("/api/pipeline/start", {
        method: "POST",
        body: formData
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? "Unable to start pipeline");
      }
      setJobId(data.jobId as string);
      if (data.jobId && !jobs.includes(data.jobId)) {
        setJobs((prev) => [data.jobId, ...prev]);
      }
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : String(startError));
    } finally {
      setIsStarting(false);
    }
  }

  async function onDeleteJob(targetJobId: string) {
    if (!window.confirm(`Delete job ${targetJobId}? This cannot be undone.`)) {
      return;
    }

    setError("");
    setDeletingJobId(targetJobId);
    try {
      const res = await fetch(`/api/pipeline/jobs?jobId=${encodeURIComponent(targetJobId)}`, {
        method: "DELETE"
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? "Unable to delete job");
      }

      setJobs((prev) => prev.filter((job) => job !== targetJobId));
      setStatus((prev) => (prev?.jobId === targetJobId ? null : prev));
      setJobId((prev) => (prev === targetJobId ? "" : prev));
      setExistingJobId((prev) => (prev.trim() === targetJobId ? "" : prev));
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
      await refreshJobs();
    } finally {
      setDeletingJobId("");
    }
  }

  function updateEditorRow(
    cueIndex: string,
    field: "finalSrtText" | "yiddishText",
    value: string
  ) {
    setEditorRows((prev) =>
      prev.map((row) => (row.cueIndex === cueIndex ? { ...row, [field]: value } : row))
    );
  }

  async function onSaveSegmentEdits() {
    if (!selectedJobId || selectedSegmentIndex === null) {
      return;
    }
    setIsEditorSaving(true);
    setEditorError("");
    setEditorMessage("");
    try {
      const res = await fetch(
        `/api/pipeline/segment?jobId=${encodeURIComponent(selectedJobId)}&segmentIndex=${selectedSegmentIndex}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ rows: editorRows, soferText: soferFullText })
        }
      );
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? "Unable to save segment edits");
      }
      setEditorRows(Array.isArray(data.rows) ? (data.rows as SegmentEditorRow[]) : editorRows);
      setSoferFullText(typeof data.soferText === "string" ? data.soferText : soferFullText);
      setEditorMessage("Saved. Final SRT/JSON were rebuilt from your edits.");
    } catch (saveError) {
      setEditorError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setIsEditorSaving(false);
    }
  }

  return (
    <main>
      <h1>Yiddish Lecture → English Subtitles</h1>
      <p>
        Upload MP3, run Sofer + Gemini + Whisper segment pipeline, and download the final aligned SRT.
      </p>

      <div className="grid">
        <section className="card">
          <h2>Run Pipeline</h2>
          <form onSubmit={onStart}>
            <label>
              Audio File (MP3)
              <input
                type="file"
                accept="audio/mpeg,audio/mp3"
                onChange={(event) => setAudioFile(event.target.files?.[0] ?? null)}
              />
            </label>
            <label>
              Existing Job ID (optional for resume/merge)
              <input
                className="mono"
                value={existingJobId}
                onChange={(event) => setExistingJobId(event.target.value)}
                placeholder="paste prior job id"
              />
            </label>
            <label>
              Number of Segments
              <input
                type="number"
                min={1}
                value={nSegments}
                onChange={(event) => setNSegments(Number(event.target.value))}
              />
            </label>
            <label>
              Whisper Model
              <input value={whisperModel} onChange={(event) => setWhisperModel(event.target.value)} />
            </label>
            <label>
              Start From Segment
              <input
                type="number"
                min={0}
                value={startFromSegment}
                onChange={(event) => setStartFromSegment(Number(event.target.value))}
              />
            </label>
            <button disabled={isStarting}>{isStarting ? "Starting..." : "Start Job"}</button>
          </form>
          {error ? <p className="status-failed">{error}</p> : null}
        </section>

        <section className="card">
          <h2>Jobs</h2>
          {jobs.length === 0 ? (
            <p>No jobs yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Job ID</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job}>
                    <td className="mono">{job}</td>
                    <td>
                      <div className="actions">
                        <button type="button" className="button-secondary" onClick={() => setJobId(job)}>
                          View
                        </button>
                        <button
                          type="button"
                          className="button-danger"
                          onClick={() => void onDeleteJob(job)}
                          disabled={deletingJobId === job}
                        >
                          {deletingJobId === job ? "Deleting..." : "Delete"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {status ? (
        <section className="card" style={{ marginTop: "1rem" }}>
          <h2>Live Status</h2>
          <div className="row">
            <span className="mono">{status.jobId}</span>
            <span className={`status-${status.state.job_status.toLowerCase()}`}>
              {status.state.job_status}
            </span>
          </div>
          {status.plan ? (
            <p>
              Duration: {status.plan.duration_seconds.toFixed(2)}s | Segment length:{" "}
              {status.plan.segment_length_seconds.toFixed(2)}s
            </p>
          ) : null}
          {status.state.error ? <p className="status-failed">{status.state.error}</p> : null}
          <div style={{ marginBottom: "0.75rem" }}>
            <a href={`/api/pipeline/download?jobId=${status.jobId}&type=state`}>Download State JSON</a>
            {" | "}
            {status.outputs.srt ? (
              <a href={`/api/pipeline/download?jobId=${status.jobId}&type=srt`}>Download Final SRT</a>
            ) : (
              <span>Final SRT not ready</span>
            )}
            {" | "}
            {status.outputs.json ? (
              <a href={`/api/pipeline/download?jobId=${status.jobId}&type=json`}>Download Final JSON</a>
            ) : (
              <span>Final JSON not ready</span>
            )}
          </div>
          <table>
            <thead>
              <tr>
                <th>Segment</th>
                {STEP_ORDER.map((step) => (
                  <th key={step}>{step}</th>
                ))}
                <th>Editor</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(status.state.segments)
                .sort((a, b) => Number(a[0]) - Number(b[0]))
                .map(([segmentIndex, segment]) => (
                  <tr key={segmentIndex}>
                    <td>{segmentIndex}</td>
                    {STEP_ORDER.map((step) => (
                      <td key={step} className={`status-${segment[step].toLowerCase()}`}>
                        {segment[step]}
                      </td>
                    ))}
                    <td>
                      {segment.align === "DONE" ? (
                        <button
                          type="button"
                          className="button-secondary"
                          onClick={() => void loadSegmentEditor(Number(segmentIndex))}
                          disabled={isEditorLoading}
                        >
                          {selectedSegmentIndex === Number(segmentIndex) ? "Editing" : "Edit Text"}
                        </button>
                      ) : (
                        <span>-</span>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>

          <div ref={editorCardRef} className="card" style={{ marginTop: "1rem" }}>
            <h3>Segment Text Editor</h3>
            {editorError ? <p className="status-failed">{editorError}</p> : null}
            {completedSegments.length === 0 ? (
              <p>No completed segments yet. When align is DONE, editing appears here.</p>
            ) : selectedSegmentIndex === null ? (
              <p>Select a completed segment to view and edit side-by-side text.</p>
            ) : isEditorLoading ? (
              <p>Loading segment text...</p>
            ) : editorRows.length === 0 ? (
              <p>No cue rows were found for this segment yet. Try again in a few seconds.</p>
            ) : (
              <>
                <div className="row">
                  <span>
                    Editing segment <strong>{selectedSegmentIndex}</strong>
                  </span>
                  <button type="button" onClick={() => void onSaveSegmentEdits()} disabled={isEditorSaving}>
                    {isEditorSaving ? "Saving..." : "Save Edits"}
                  </button>
                </div>
                <div style={{ marginTop: "0.5rem" }}>
                  <p style={{ margin: "0 0 0.35rem" }}>Segment Audio</p>
                  <audio
                    controls
                    preload="metadata"
                    src={`/api/pipeline/segment-audio?jobId=${encodeURIComponent(
                      selectedJobId
                    )}&segmentIndex=${selectedSegmentIndex}`}
                    style={{ width: "100%" }}
                  />
                </div>
                {editorMessage ? <p className="status-done">{editorMessage}</p> : null}
                <div className="editor-layout" style={{ marginTop: "0.5rem" }}>
                  <div className="editor-main">
                    <table>
                      <thead>
                        <tr>
                          <th>Local Cue</th>
                          <th>Timestamp</th>
                          <th>Merged Translation</th>
                          <th>Whisper Original</th>
                        </tr>
                      </thead>
                      <tbody>
                        {editorRows.map((row) => (
                          <tr key={row.cueIndex}>
                            <td>{row.cueIndex}</td>
                            <td className="mono">{row.timestamp}</td>
                            <td>
                              <textarea
                                value={row.finalSrtText}
                                onChange={(event) =>
                                  updateEditorRow(row.cueIndex, "finalSrtText", event.target.value)
                                }
                                rows={3}
                              />
                            </td>
                            <td>
                              <textarea
                                value={row.yiddishText}
                                onChange={(event) =>
                                  updateEditorRow(row.cueIndex, "yiddishText", event.target.value)
                                }
                                rows={3}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <aside className="card editor-side">
                    <h4>Sofer.ai Full Yiddish Transcription</h4>
                    <p>Displayed as a full segment text because Sofer is not timestamp-aligned.</p>
                    <textarea
                      value={soferFullText}
                      onChange={(event) => setSoferFullText(event.target.value)}
                      rows={24}
                    />
                  </aside>
                </div>
              </>
            )}
          </div>
        </section>
      ) : null}
    </main>
  );
}
