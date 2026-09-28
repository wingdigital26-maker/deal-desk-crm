"use client";
// Tap to dictate a note, tap again to stop. Words appear in the note box as
// they are heard (interim results), added after whatever was already typed.
//
// Uses the browser's own Web Speech API (SpeechRecognition, or the webkit-
// prefixed one in Chrome and Safari). Deal Desk sends nothing anywhere: the
// words only land in the note box, and the note is saved like a typed one.
// Note that the BROWSER may process the speech on its own servers (Chrome does,
// through Google), which is why a one-line hint says so the first time.
//
// Where the API is missing (Firefox, most headless browsers) the button does
// not render at all. Support is read after mount (useSyncExternalStore with a
// server snapshot of false), so server and client HTML always match.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { MicIcon } from "../ui/icons";
import { joinDictation, speechRecognitionCtor, transcriptFrom } from "./voiceText";

const HINT_KEY = "dealdesk.voiceHintSeen";

type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
};

const noopSubscribe = () => () => {};

function hintSeen(): boolean {
  try {
    return window.localStorage.getItem(HINT_KEY) === "1";
  } catch {
    return true;
  }
}

export default function VoiceNoteButton({
  value,
  onChange,
  className = "",
}: {
  value: string;
  onChange: (next: string) => void;
  className?: string;
}) {
  const supported = useSyncExternalStore(noopSubscribe, () => speechRecognitionCtor(window) != null, () => false);
  const seenAtLoad = useSyncExternalStore(noopSubscribe, hintSeen, () => true);
  const [hintDone, setHintDone] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<Recognition | null>(null);
  const baseRef = useRef("");
  const onChangeRef = useRef(onChange);
  const valueRef = useRef(value);

  useEffect(() => {
    onChangeRef.current = onChange;
    valueRef.current = value;
  });

  useEffect(() => () => recRef.current?.abort(), []);

  if (!supported) return null;

  function markHintSeen() {
    setHintDone(true);
    try {
      window.localStorage.setItem(HINT_KEY, "1");
    } catch {
      // Private mode: the hint just shows again next time.
    }
  }

  function start() {
    const Ctor = speechRecognitionCtor(window);
    if (!Ctor) return;
    const rec = new Ctor() as Recognition;
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    baseRef.current = valueRef.current;
    rec.onresult = (e) => onChangeRef.current(joinDictation(baseRef.current, transcriptFrom(e.results)));
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") setError("Microphone access is blocked for this site.");
      else if (e.error && e.error !== "aborted" && e.error !== "no-speech") setError("Dictation stopped. Try again.");
    };
    rec.onend = () => {
      setListening(false);
      recRef.current = null;
      markHintSeen();
    };
    setError(null);
    try {
      rec.start();
      recRef.current = rec;
      setListening(true);
    } catch {
      setError("Dictation could not start.");
    }
  }

  function stop() {
    recRef.current?.stop();
  }

  return (
    <div className={`flex flex-col items-start ${className}`}>
      <button
        type="button"
        // Keep focus in the note box, so a box that saves on blur does not save half a sentence.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (listening ? stop() : start())}
        aria-pressed={listening}
        aria-label={listening ? "Stop dictating" : "Dictate a note"}
        title={listening ? "Stop dictating" : "Dictate a note"}
        className={`inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center gap-1.5 rounded-[var(--radius-sm)] border px-3 text-sm font-medium ${
          listening
            ? "border-[var(--navy)] bg-[var(--navy)] text-white"
            : "border-[var(--rule-strong)] bg-[var(--surface)] text-[var(--ink)] hover:bg-[var(--paper)]"
        }`}
      >
        <MicIcon />
        <span>{listening ? "Stop" : "Dictate"}</span>
      </button>
      {!seenAtLoad && !hintDone && <span className="mt-1 text-[11px] leading-tight text-[var(--ink-faint)]">Your browser turns speech into text</span>}
      {error && (
        <span role="status" className="mt-1 text-[11px] leading-tight text-[var(--bad)]">
          {error}
        </span>
      )}
    </div>
  );
}
