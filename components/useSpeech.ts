"use client";
import { useCallback, useEffect, useRef, useState } from "react";

// Speech input with the browser's built-in recognizer (no server key needed; Chrome and Edge on Android and desktop work best).
// Speech output with the browser's built-in voice.
export function useSpeechInput(onFinal: (text: string) => void, lang: string) {
  const [supported, setSupported] = useState(true);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<any>(null);
  const cb = useRef(onFinal);
  cb.current = onFinal;

  useEffect(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) setSupported(false);
    return () => { try { rec.current?.abort(); } catch { /* ignore */ } };
  }, []);

  const stop = useCallback(() => { try { rec.current?.stop(); } catch { /* ignore */ } }, []);

  const start = useCallback(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { setSupported(false); return; }
    setError(null);
    setInterim("");
    try { rec.current?.abort(); } catch { /* ignore */ }
    const r = new SR();
    r.lang = lang;
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 1;
    let finalText = "";
    r.onresult = (e: any) => {
      let partial = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText += res[0].transcript; else partial += res[0].transcript;
      }
      setInterim((finalText + partial).trim());
    };
    r.onerror = (e: any) => {
      const messages: Record<string, string> = {
        "not-allowed": "The microphone is blocked. Allow it in the browser's address bar or site settings, then try again.",
        "service-not-allowed": "This browser does not allow speech input here. Try Chrome, or type your question.",
        "no-speech": "I did not hear anything. Tap the mic and speak again.",
        "audio-capture": "No microphone was found on this device.",
        "network": "Speech input needs an internet connection.",
        "language-not-supported": "This browser cannot recognise that language. Choose English or type your question.",
      };
      setError(messages[e.error] || `Speech input failed (${e.error}). You can type your question instead.`);
    };
    r.onend = () => {
      setListening(false);
      setInterim("");
      const text = finalText.trim();
      if (text) cb.current(text);
    };
    rec.current = r;
    try { r.start(); setListening(true); } catch { setListening(false); setError("Could not start the microphone. Try again."); }
  }, [lang]);

  return { supported, listening, interim, error, start, stop };
}

export function speakText(text: string, lang: string) {
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    speechSynthesis.speak(u);
  } catch { /* no speech output available */ }
}

export function stopSpeaking() {
  try { speechSynthesis.cancel(); } catch { /* ignore */ }
}
