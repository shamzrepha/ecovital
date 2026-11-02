"use client";
import { useCallback, useEffect, useRef, useState } from "react";

// Browser playback of EcoVital's spoken lines. Tries the Gemini voice (same audio the pod plays),
// and falls back to the browser's built-in speech if that audio is not available.
export function useVoice() {
  const [on, setOn] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [blockedItem, setBlockedItem] = useState<{ eventId: number; text: string } | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    try { setOn(localStorage.getItem("ecovital-voice") === "1"); } catch { /* storage unavailable */ }
  }, []);

  const toggle = useCallback(() => {
    setOn((v) => {
      const nv = !v;
      try { localStorage.setItem("ecovital-voice", nv ? "1" : "0"); } catch { /* ignore */ }
      if (!nv) { audio.current?.pause(); try { speechSynthesis.cancel(); } catch { /* ignore */ } setBlocked(false); }
      return nv;
    });
  }, []);

  const play = useCallback(async (eventId: number, text: string) => {
    try { audio.current?.pause(); speechSynthesis.cancel(); } catch { /* ignore */ }
    setBlocked(false);
    try {
      const a = new Audio(`/api/tts/${eventId}?fmt=wav`);
      audio.current = a;
      await a.play();
      setBlockedItem(null);
      return;
    } catch (e: any) {
      if (e?.name === "NotAllowedError" || String(e?.message ?? "").includes("interact") || String(e?.message ?? "").includes("user")) {
        setBlocked(true);
        setBlockedItem({ eventId, text });
      }
      /* fall back to built-in voice */
    }
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en";
      speechSynthesis.speak(u);
      setBlockedItem(null);
    } catch (e: any) {
      if (e?.name === "NotAllowedError") {
        setBlocked(true);
        setBlockedItem({ eventId, text });
      }
    }
  }, []);

  const unblock = useCallback(() => {
    if (blockedItem) {
      play(blockedItem.eventId, blockedItem.text);
    }
    setBlocked(false);
  }, [blockedItem, play]);

  return { on, toggle, play, blocked, unblock, blockedItem };
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
