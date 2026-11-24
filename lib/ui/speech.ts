// Thin wrapper over the browser's speech recognition. The browser's maker (Google, Apple or
// Microsoft) turns the audio into text; Nsalek receives only the text.

type Alternative = { transcript: string; confidence?: number };
type Result = ArrayLike<Alternative> & { isFinal: boolean };

export interface SpeechLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: { results: ArrayLike<Result> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechCtor = new () => SpeechLike;

export type SpeechProblem = "denied" | "silence" | "network" | "language" | "other";

export function speechCtor(): SpeechCtor | null {
  const w = globalThis as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const PROBLEMS: Record<string, SpeechProblem> = {
  "not-allowed": "denied",
  "service-not-allowed": "denied",
  "audio-capture": "denied",
  "no-speech": "silence",
  network: "network",
  "language-not-supported": "language",
};

export type Listener = {
  onPartial: (text: string) => void;
  /** Called at most once, with the most likely sentence first. */
  onFinal: (alternatives: { text: string }[]) => void;
  onError: (problem: SpeechProblem) => void;
  onEnd: () => void;
};

/** Starts listening; returns a function that stops and ignores anything still to come. */
export function listen(lang: string, on: Listener, Speech: SpeechCtor = speechCtor()!): () => void {
  const rec = new Speech();
  rec.lang = lang;
  rec.continuous = false;
  rec.interimResults = true;
  rec.maxAlternatives = 5;
  let done = false;
  let failed = false;
  let heard: { text: string }[] = [];
  rec.onresult = (e) => {
    if (done) return;
    const results = Array.from(e.results);
    const line = (k: number) =>
      results
        .map((r) => (r[k] ?? r[0])?.transcript ?? "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    on.onPartial(line(0));
    const count = Math.max(1, ...results.filter((r) => r.isFinal).map((r) => r.length));
    heard = results.some((r) => r.isFinal) ? [...new Set(Array.from({ length: count }, (_, k) => line(k)))].filter(Boolean).map((text) => ({ text })) : [];
  };
  rec.onerror = (e) => {
    if (done || e.error === "aborted") return;
    failed = true;
    on.onError(PROBLEMS[e.error] ?? "other");
  };
  rec.onend = () => {
    if (done) return;
    done = true;
    if (heard.length) on.onFinal(heard);
    else if (!failed) on.onError("silence");
    on.onEnd();
  };
  rec.start();
  return () => {
    if (done) return;
    done = true;
    rec.abort();
  };
}
