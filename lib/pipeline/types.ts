export type StepName = "audio" | "sofer" | "translate" | "whisper" | "align";
export type StepStatus = "PENDING" | "RUNNING" | "DONE" | "FAILED";

export type SegmentState = Record<StepName, StepStatus>;

export type PipelineState = {
  n_segments: number;
  created_at: string;
  updated_at: string;
  options: PipelineOptions;
  segments: Record<string, SegmentState>;
  job_status: "PENDING" | "RUNNING" | "DONE" | "FAILED";
  error?: string;
};

export type PipelineOptions = {
  nSegments: number;
  whisperModel: string;
  startFromSegment: number;
};

export type WhisperCue = {
  index: string;
  timestamp: string;
  text: string;
};

export type MergedCue = {
  timestamp: string;
  srt_text: string;
  gold_words: string[];
  sofer_yiddish_text?: string;
};

export type AlignmentFile = {
  meta: {
    segment_index: number;
    gold_word_count: number;
    srt_entry_count: number;
    model_id: string;
    created_at: string;
  };
  index_alignment: Record<string, number[]>;
  word_alignment: Record<string, string[]>;
  merged_srt: Record<string, MergedCue>;
};

export type PipelineConfig = {
  jobId: string;
  sourceAudioPath: string;
  outputDir: string;
  options: PipelineOptions;
};
