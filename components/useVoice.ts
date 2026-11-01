"use client";
import { useCallback, useEffect, useRef, useState } from "react";

// Browser playback of EcoVital's spoken lines. Tries the Gemini voice (same audio the pod plays),
// and falls back to the browser's built-in speech if that audio is not available.
export function useVoice() {
  const [on, setOn] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    try { setOn(localStorage.getItem("ecovital-voice") === "1"); } catch { /* storage unavailable */ }
  }, []);

  const toggle = useCallback(() => {
    setOn((v) => {
      const nv = !v;
      try { localStorage.setItem("ecovital-voice", nv ? "1" : "0"); } catch { /* ignore */ }
      if (!nv) { audio.current?.pause(); try { speechSynthesis.cancel(); } catch { /* ignore */ } }
      return nv;
    });
  }, []);

  const play = useCallback(async (eventId: number, text: string) => {
    try { audio.current?.pause(); speechSynthesis.cancel(); } catch { /* ignore */ }
    try {
      const a = new Audio(`/api/tts/${eventId}?fmt=wav`);
      audio.current = a;
      await a.play();
      return;
    } catch { /* fall back to built-in voice */ }
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en";
      speechSynthesis.speak(u);
    } catch { /* no speech available */ }
  }, []);

  return { on, toggle, play };
}

export function ago(now: number, t: number | null | undefined): string {
  if (!t) return "never";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
