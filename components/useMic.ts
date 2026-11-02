"use client";
import { useCallback, useRef, useState } from "react";

// Records from the microphone and hands back a small 16 kHz mono WAV, stopping by itself when the person stops talking.
// WAV is used (not WebM) because every browser can make it and Gemini accepts it.

export type MicResult = { wav: Blob | null; heardSpeech: boolean };

const TARGET_RATE = 16000;
const LOUD = 0.015;          // rough "someone is talking" level
const NO_SPEECH_MS = 7000;   // give up if nobody says anything
const MAX_MS = 30000;

function toWav(chunks: Float32Array[], inRate: number): Blob {
  let len = 0;
  for (const c of chunks) len += c.length;
  const all = new Float32Array(len);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  const ratio = inRate / TARGET_RATE;
  const outLen = Math.floor(all.length / ratio);
  const pcm = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio, i0 = Math.floor(pos), f = pos - i0;
    const v = all[i0] + ((all[i0 + 1] ?? all[i0]) - all[i0]) * f;
    pcm[i] = Math.max(-1, Math.min(1, v)) * 0x7fff;
  }
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const dv = new DataView(buf);
  const w = (off: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  w(0, "RIFF"); dv.setUint32(4, 36 + pcm.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, TARGET_RATE, true); dv.setUint32(28, TARGET_RATE * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, "data"); dv.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: "audio/wav" });
}

export function useMic() {
  const [listening, setListening] = useState(false);
  const [level, setLevel] = useState(0);
  const stopRef = useRef<(() => void) | null>(null);

  const stop = useCallback(() => { stopRef.current?.(); }, []);

  /** Starts listening. Resolves when the person stops talking, presses stop, or nothing is heard. */
  const listen = useCallback(async (silenceMs = 1300): Promise<MicResult> => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser cannot use the microphone.");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    const ctx: AudioContext = new Ctx();
    const source = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(proc); proc.connect(mute); mute.connect(ctx.destination);

    const chunks: Float32Array[] = [];
    const t0 = Date.now();
    let heard = false, lastLoud = t0, done = false;
    setListening(true);

    return new Promise<MicResult>((resolve) => {
      const finish = () => {
        if (done) return;
        done = true;
        proc.disconnect(); source.disconnect(); mute.disconnect();
        stream.getTracks().forEach((t) => t.stop());
        const rate = ctx.sampleRate;
        ctx.close().catch(() => {});
        setListening(false); setLevel(0);
        stopRef.current = null;
        resolve({ wav: heard && chunks.length ? toWav(chunks, rate) : null, heardSpeech: heard });
      };
      stopRef.current = finish;
      proc.onaudioprocess = (e) => {
        if (done) return;
        const data = e.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(data));
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / data.length);
        setLevel(Math.min(1, rms * 8));
        const now = Date.now();
        if (rms > LOUD) { heard = true; lastLoud = now; }
        if (heard && now - lastLoud > silenceMs) finish();
        else if (!heard && now - t0 > NO_SPEECH_MS) finish();
        else if (now - t0 > MAX_MS) finish();
      };
    });
  }, []);

  return { listening, level, listen, stop };
}
