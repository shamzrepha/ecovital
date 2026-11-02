// Picks the Gemini models by asking Google which ones this API key can use, instead of guessing exact ids.
// Text: Gemini 3.1 Flash-Lite when it exists, then the next best Flash-Lite / Flash. Speech: the newest text-to-speech model.

export interface ModelInfo { name: string; methods: string[] }

let cache: { at: number; models: ModelInfo[] | null } | null = null;
const TTL = 6 * 3600_000;

/** What the app last used, so the app and the admin page can show it. */
export const aiStats = { textModel: "", ttsModel: "", sttModel: "", lastError: "", lastOkAt: 0 };

export function resetModelCache() { cache = null; }

export async function listModels(): Promise<ModelInfo[] | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  if (cache && Date.now() - cache.at < (cache.models ? TTL : 60_000)) return cache.models;
  try {
    const out: ModelInfo[] = [];
    let token = "";
    for (let page = 0; page < 5; page++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 6000);
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200${token ? `&pageToken=${token}` : ""}`, {
          headers: { "x-goog-api-key": key }, signal: ctl.signal,
        });
        if (!res.ok) throw new Error(`models ${res.status}`);
        const j: any = await res.json();
        for (const m of j.models ?? []) out.push({ name: String(m.name).replace(/^models\//, ""), methods: m.supportedGenerationMethods ?? [] });
        token = j.nextPageToken ?? "";
      } finally {
        clearTimeout(timer);
      }
      if (!token) break;
    }
    cache = { at: Date.now(), models: out };
    return out;
  } catch (e: any) {
    aiStats.lastError = `Could not list models: ${e?.message ?? e}`;
    cache = { at: Date.now(), models: null };
    return null;
  }
}

const version = (n: string) => {
  const m = /gemini-(\d+(?:\.\d+)?)/.exec(n);
  return m ? parseFloat(m[1]) : 0;
};
const stable = (n: string) => (/preview|exp|latest/.test(n) ? 1 : 0);   // plain names sort before preview names of the same version

export function pickText(models: ModelInfo[] | null, env = process.env.GEMINI_TEXT_MODEL): string[] {
  const fallback = ["gemini-3.1-flash-lite", "gemini-3-flash-preview", "gemini-2.5-flash-lite", "gemini-2.5-flash"];
  if (!models) return Array.from(new Set([...fallback, ...(env ? [env] : [])]));
  const usable = models.filter((m) => m.methods.includes("generateContent") && /^gemini-/.test(m.name) && !/tts|image|live|embed|aqa|robotics|computer|audio|thinking|vision/.test(m.name));
  const flashLite = (v: RegExp) => usable.filter((m) => v.test(m.name) && /flash-lite/.test(m.name)).map((m) => m.name).sort((a, b) => stable(a) - stable(b) || a.length - b.length);
  const picks = [
    ...flashLite(/gemini-3\.1/),          // what the owner asked for
    ...usable.filter((m) => /gemini-3-flash-preview/.test(m.name)).map((m) => m.name),
    ...flashLite(/gemini-3(?!\.)/),
    ...flashLite(/gemini-2\.5/),
    ...usable.filter((m) => /gemini-2\.5-flash$/.test(m.name)).map((m) => m.name),
    ...(env && usable.some((m) => m.name === env) ? [env] : []),
  ];
  return Array.from(new Set(picks.length ? picks : fallback));
}

export function pickTts(models: ModelInfo[] | null): string[] {
  const fallback = ["gemini-2.5-flash-preview-tts"];
  if (!models) return fallback;
  const tts = models.filter((m) => m.methods.includes("generateContent") && /tts/.test(m.name)).map((m) => m.name);
  // Gemini 2.5 Flash TTS is the preferred voice; other speech models are backups (newest first).
  const pref = (n: string) => (/gemini-2\.5-flash-preview-tts/.test(n) ? 0 : /gemini-2\.5-flash.*tts/.test(n) ? 1 : 2);
  tts.sort((a, b) => pref(a) - pref(b) || version(b) - version(a) || stable(a) - stable(b) || a.localeCompare(b));
  return tts.length ? tts : fallback;
}

export async function textModels(): Promise<string[]> { return pickText(await listModels()); }
export async function ttsModels(): Promise<string[]> { return pickTts(await listModels()); }
