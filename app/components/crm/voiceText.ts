// Pure helpers for VoiceNoteButton (no React, no browser globals at import
// time), so the text handling is unit-tested without a microphone.

/** The browser's speech recognition constructor, or null where it is not supported. */
export function speechRecognitionCtor(win: unknown): (new () => unknown) | null {
  if (!win || typeof win !== "object") return null;
  const w = win as { SpeechRecognition?: new () => unknown; webkitSpeechRecognition?: new () => unknown };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

type Alt = { transcript: string };
type ResultList = ArrayLike<ArrayLike<Alt>>;

/** Everything heard so far (final and interim), as one tidy string. */
export function transcriptFrom(results: ResultList): string {
  let out = "";
  for (let i = 0; i < results.length; i++) {
    const alt = results[i]?.[0];
    if (alt?.transcript) out += ` ${alt.transcript}`;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** What was in the note box before dictation started, plus what was said. */
export function joinDictation(base: string, spoken: string): string {
  const said = spoken.trim();
  if (!said) return base;
  if (!base.trim()) return said;
  return /\s$/.test(base) ? `${base}${said}` : `${base} ${said}`;
}
