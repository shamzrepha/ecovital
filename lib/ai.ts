// AI voice lines (Gemini) with a deterministic template fallback, and text-to-speech.
// If Gemini is unreachable the device still speaks: the fallback line is built from the data.

import {
  METRICS, METRIC_KEYS, ROOM_PROFILES, fmt, statusWord,
  type MetricKey, type Status, type ActionCode, type ProfileKey,
} from "./config.ts";
import type { Trigger } from "./rules.ts";
import type { Forecast, Summary } from "./predict.ts";

export interface AiContext {
  deviceName: string;
  trigger: Trigger;
  summaries: Partial<Record<MetricKey, Summary>>; // last 2 minutes of every sensor
  statuses: Partial<Record<MetricKey, Status>>;
  forecasts: Partial<Record<MetricKey, Forecast>>;
  profile?: string;
  language?: string; // "en-NG" | "pcm" | "ig" | "yo" | "ha"
}

export interface GeneratedLine {
  text: string;
  source: "gemini" | "template";
  tags: ("measured" | "estimate")[];
  action: ActionCode;
  translatedText?: string;
  language?: string;
  machineTranslated?: boolean;
  error?: string;
}

const SPOKEN_UNIT: Record<MetricKey, string> = { air: "percent", dust: "percent", temp: "degrees Celsius", hum: "percent" };
const SPOKEN_NAME: Record<MetricKey, string> = { air: "air index", dust: "dust level", temp: "temperature", hum: "humidity" };

export function spokenValue(k: MetricKey, v: number): string {
  const digits = k === "temp" ? 1 : 0;
  return `${v.toFixed(digits)} ${SPOKEN_UNIT[k]}`;
}

const ACTIONS: Record<string, { text: string; code: ActionCode }> = {
  "hum-low": { text: "Drink some water or keep a bowl of water in the room.", code: "water" },
  "hum-high": { text: "Open a window or switch on a fan to let the moisture out.", code: "fan" },
  "temp-high": { text: "Switch on a fan or open the windows for airflow.", code: "fan" },
  "temp-low": { text: "Close the windows to keep warmth in.", code: "close_window" },
  "dust-high": { text: "Close the windows and wipe dusty surfaces.", code: "close_window" },
  "air-low": { text: "Open a window for fresh air and check for smoke or fumes.", code: "open_window" },
};

const LOCAL_TRANSLATIONS: Record<string, Record<string, string>> = {
  ig: {
    "hum-low": "ṅụọ mmiri ma ọ bụ debe efere mmiri n'ime ụlọ. Ikuku kpọrọ nkụ.",
    "hum-high": "Mepee windo ma ọ bụ gbanye fan ka mmiri dị n'ikuku pụọ.",
    "temp-high": "Gbanye fan ma ọ bụ mepee windo ka ikuku bata.",
    "temp-low": "Mechie windo ka ụlọ ghara ịjụ oyi.",
    "dust-high": "Mechie windo ma hichaa uzuzu dị n'elu ihe.",
    "air-low": "Mepee windo ka ikuku ọhụrụ bata.",
    "recovered": "Ihe niile adịla mma ugbu a. Anyị nọ n'udo.",
  },
  yo: {
    "hum-low": "Mu omi tabi fi abọ omi sinu yara. Afẹfẹ ti gbẹ.",
    "hum-high": "Ṣii ferese tabi tan fẹlẹfẹlẹ (fan) ki ọriniinitutu le jade.",
    "temp-high": "Tan fan tabi ṣii ferese fun afẹfẹ.",
    "temp-low": "Pa ferese mọ ki ooru le wa ninu yara.",
    "dust-high": "Pa awọn ferese mọ ki o si nu eruku.",
    "air-low": "Ṣii ferese fun afẹfẹidi tuntun.",
    "recovered": "Gbogbo rẹ ti dara bayii. A wa ni ailewu.",
  },
  ha: {
    "hum-low": "A sha ruwa ko a ajiye kwano na ruwa a daki. Iska ta bushe.",
    "hum-high": "A bude taga ko a kunna fanka don rage danshi.",
    "temp-high": "A kunna fanka ko a bude tagogi don samun iska.",
    "temp-low": "A rufe tagogi don kiyaye dumi a daki.",
    "dust-high": "A rufe tagogi kuma a goge kura.",
    "air-low": "A bude taga don shigar da sabon iska.",
    "recovered": "Komai ya daidaita yanzu. Muna cikin koshin lafiya.",
  },
};

LOCAL_TRANSLATIONS.pcm = {
  "hum-low": "Di air dey dry well well. Drink water, or put bowl of water inside di room.",
  "hum-high": "Di air don too wet. Open window or put fan make di moisture comot.",
  "temp-high": "Heat don too much. Put fan or open window make air fit enter.",
  "temp-low": "Cold dey. Close di window make di room warm.",
  "dust-high": "Dust plenty for air. Close window and wipe di dusty tins with wet cloth.",
  "air-low": "Di air no fresh. Open window make fresh air enter, and check say smoke no dey.",
  "recovered": "Everything don correct now. We dey safe.",
};

/** Languages the app can write and speak. Igbo, Yoruba, Hausa and Pidgin are machine-written and say so. */
export const LANGS: Record<string, { label: string; prompt: string; tts: string; machine: boolean; rec: string }> = {
  "en-NG": { label: "English", prompt: "clear, warm Nigerian English", tts: "", machine: false, rec: "en-NG" },
  pcm: { label: "Naija Pidgin", prompt: "friendly, simple Nigerian Pidgin English (Naija Pidgin)", tts: "Say this warmly in a Nigerian Pidgin English accent: ", machine: true, rec: "en-NG" },
  ig: { label: "Igbo", prompt: "simple Igbo (use the English word when unsure of an Igbo one)", tts: "Say this warmly in Igbo: ", machine: true, rec: "ig-NG" },
  yo: { label: "Yoruba", prompt: "simple Yoruba (use the English word when unsure of a Yoruba one)", tts: "Say this warmly in Yoruba: ", machine: true, rec: "yo-NG" },
  ha: { label: "Hausa", prompt: "simple Hausa (use the English word when unsure of a Hausa one)", tts: "Say this warmly in Hausa: ", machine: true, rec: "ha-NG" },
};
export const normLang = (l?: string | null): string => (l && LANGS[l] ? l : "en-NG");

export function inferAction(t: Trigger): ActionCode {
  if (t.kind === "recovered") return "none";
  const side = t.crossing ? t.crossing.side : t.status.endsWith("high") ? "high" : "low";
  if (t.metric === "temp" && t.status === "bad-high") return "ac";
  return ACTIONS[`${t.metric}-${side}`]?.code ?? "none";
}

export function inferTags(t: Trigger): ("measured" | "estimate")[] {
  return t.kind === "predictive" ? ["measured", "estimate"] : ["measured"];
}

export function translateFallback(t: Trigger, lang?: string): string | undefined {
  if (!lang || lang === "en" || lang === "en-NG") return undefined;
  const dict = LOCAL_TRANSLATIONS[lang];
  if (!dict) return undefined;
  if (t.kind === "recovered") return dict["recovered"];
  const side = t.crossing ? t.crossing.side : t.status.endsWith("high") ? "high" : "low";
  return dict[`${t.metric}-${side}`];
}

export function compactContext(ctx: AiContext) {
  const last2min: Record<string, unknown> = {};
  for (const k of METRIC_KEYS) {
    const s = ctx.summaries[k];
    if (!s) continue;
    last2min[k] = {
      name: SPOKEN_NAME[k], unit: SPOKEN_UNIT[k],
      now: +s.last.toFixed(1), average: +s.avg.toFixed(1), min: +s.min.toFixed(1), max: +s.max.toFixed(1),
      changeOver2min: +s.change.toFixed(1), readings: s.n, status: statusWord(k, ctx.statuses[k] ?? "ok"),
    };
  }
  const estimate: Record<string, unknown> = {};
  for (const k of METRIC_KEYS) {
    const f = ctx.forecasts[k];
    if (!f || !f.ok) continue;
    estimate[k] = {
      in10min: +f.predicted.toFixed(1), range: [+f.low.toFixed(1), +f.high.toFixed(1)],
      trend: f.trend, confidence: f.confidence,
      reachesThresholdInMin: f.crossing ? +f.crossing.minutes.toFixed(1) : null,
    };
  }
  const profKey = (ctx.profile as ProfileKey) in ROOM_PROFILES ? (ctx.profile as ProfileKey) : "classroom";
  return {
    node: ctx.deviceName,
    roomProfile: profKey,
    roomTone: ROOM_PROFILES[profKey].toneHint,
    language: ctx.language ?? "en-NG",
    event: {
      kind: ctx.trigger.kind,
      metric: SPOKEN_NAME[ctx.trigger.metric],
      newStatus: statusWord(ctx.trigger.metric, ctx.trigger.status),
      previousStatus: statusWord(ctx.trigger.metric, ctx.trigger.prevStatus),
      value: ctx.trigger.value,
    },
    measuredLast2Minutes: last2min,
    trendEstimates: estimate,
  };
}

const SYSTEM = `You are EcoVital, a friendly classroom and home air-monitoring pod in Nigeria that speaks out loud to everyday people (teachers, parents, students, and families).
Return JSON: {"line":"...","tags":["measured"],"action":"open_window|fan|ac|water|close_window|none","translatedText":"the same advice written in the requested language when language is pcm (Nigerian Pidgin), ig, yo or ha; leave it out for en-NG"}
Hard rules for "line":
- At most 32 words, warm, natural, everyday spoken English (Nigerian English default), no lists, no emojis, no markdown, and no technical jargon.
- Put practical, easy-to-follow action FIRST or immediately with the reading so anyone in the room knows what to do.
- Use only the numbers in the data. Say units in plain words ("percent", "degrees Celsius"). Never use technical mass/gas units like ug/m3 or ppm.
- Measured values are facts ("measured" tag). Anything from trendEstimates is an estimate ("estimate" tag) and must be introduced with "I estimate" or "looks like it may", never stated as certain.
- Never claim a health risk, medical diagnosis, or specific gas.
- No automatic fan or purifier exists; advice is a simple step a person can do (like opening a window, turning on a fan, or drinking water).
- alert: warmly state what changed in plain words with the current number, and give one simple action.
- predictive: give a friendly heads-up on what is trending, when it may cross the comfort limit (estimate), and what to do now.
- recovered: warmly say "All good now" or that the room is comfortable and back to normal with the new reading.`;

function clean(text: string): string {
  let t = text.replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim().replace(/^["']|["']$/g, "");
  const words = t.split(/\s+/);
  if (words.length > 32) t = words.slice(0, 32).join(" ");
  if (t.length > 240) t = t.slice(0, 240).replace(/\s+\S*$/, "").trimEnd();
  if (t && !/[.!?]$/.test(t)) t += ".";
  return t;
}

export function fallbackLine(ctx: AiContext): string {
  const t = ctx.trigger;
  const m = t.metric;
  const name = SPOKEN_NAME[m];
  const cap = name.charAt(0).toUpperCase() + name.slice(1);
  const val = spokenValue(m, t.value);
  const side = t.status.endsWith("high") ? "high" : "low";
  if (t.kind === "recovered") {
    const others = METRIC_KEYS.filter((k) => k !== m && ctx.summaries[k])
      .map((k) => `${SPOKEN_NAME[k]} ${spokenValue(k, ctx.summaries[k]!.last)}`).join(", ");
    return clean(`${cap} is back to normal at ${val}. ${others ? "Now: " + others + "." : "All good now."}`);
  }
  if (t.kind === "predictive" && t.crossing) {
    const mins = Math.max(1, Math.round(t.crossing.minutes));
    const dir = t.crossing.side === "low" ? "dropping" : "rising";
    const act = ACTIONS[`${m}-${t.crossing.side}`]?.text ?? "";
    return clean(`${cap} is ${dir}, now ${val}. I estimate it reaches ${t.crossing.threshold} in about ${mins} minutes. ${act}`);
  }
  const word = statusWord(m, t.status).toLowerCase();
  const verb = side === "low" ? "has dropped to" : "has risen to";
  const act = ACTIONS[`${m}-${side}`]?.text ?? "";
  return clean(`${cap} ${verb} ${val}, which is ${word}. ${act}`);
}

export async function geminiText(prompt: string, systemPrompt = SYSTEM, maxTokens = 320): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  // Gemini 3.1 Flash-Lite first; the others only run if it is unavailable.
  const models = Array.from(new Set([process.env.GEMINI_TEXT_MODEL, "gemini-3.1-flash-lite", "gemini-2.5-flash-lite", "gemini-2.5-flash"].filter((m): m is string => !!m)));

  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const body = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature: 0.45,
      },
    };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 7500);
    try {
      const res = await fetch(url, {
        method: "POST", signal: ctl.signal,
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body),
      });
      if (!res.ok) continue;
      const j: any = await res.json();
      const parts: any[] = j?.candidates?.[0]?.content?.parts ?? [];
      const text = parts.map((p) => p.text ?? "").join(" ");
      if (text.trim()) return text;
    } catch {
      // try next model
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("Gemini text request failed");
}

/** Turns a short recording (WAV) into text with Gemini. Handles English, Pidgin, Igbo, Yoruba and Hausa. */
export async function geminiAudioToText(buf: Buffer, mime: string, lang?: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const hint = lang && LANGS[lang] ? LANGS[lang].label : "English";
  const instruction = `Transcribe this recording exactly as it was spoken. The speaker is most likely using ${hint}, but may mix English, Nigerian Pidgin, Igbo, Yoruba or Hausa. Write the words in the language they were spoken. Return only the spoken words, with no quotes, labels or notes. If nobody is speaking, return nothing.`;
  const models = Array.from(new Set([process.env.GEMINI_TEXT_MODEL, "gemini-3.1-flash-lite", "gemini-2.5-flash-lite", "gemini-2.5-flash"].filter((m): m is string => !!m)));
  let lastErr = "no model answered";
  for (const model of models) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST", signal: ctl.signal,
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: instruction }, { inlineData: { mimeType: mime.split(";")[0] || "audio/wav", data: buf.toString("base64") } }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 300 },
        }),
      });
      if (!res.ok) { lastErr = `${model} ${res.status}`; continue; }
      const j: any = await res.json();
      const parts: any[] = j?.candidates?.[0]?.content?.parts ?? [];
      return parts.map((p) => p.text ?? "").join(" ").replace(/^["'\s]+|["'\s]+$/g, "").trim();
    } catch (e: any) {
      lastErr = `${model} ${e?.name === "AbortError" ? "timed out" : e?.message ?? e}`;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastErr);
}

function parseAiOutput(raw: string, ctx: AiContext): GeneratedLine {
  const defaultAction = inferAction(ctx.trigger);
  const defaultTags = inferTags(ctx.trigger);
  const trimmed = raw.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  try {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      const line = clean(String(parsed.line ?? parsed.text ?? ""));
      if (line.length >= 8) {
        const validActions: ActionCode[] = ["open_window", "fan", "ac", "water", "close_window", "none"];
        const action: ActionCode = validActions.includes(parsed.action) ? parsed.action : defaultAction;
        const tags: ("measured" | "estimate")[] = Array.isArray(parsed.tags) && parsed.tags.length
          ? parsed.tags.filter((x: string) => x === "measured" || x === "estimate")
          : defaultTags;
        const translated = parsed.translatedText ? clean(String(parsed.translatedText)) : translateFallback(ctx.trigger, ctx.language);
        return {
          text: line,
          source: "gemini",
          tags: tags.length ? tags : defaultTags,
          action,
          translatedText: translated,
          language: ctx.language ?? "en-NG",
          machineTranslated: !!translated,
        };
      }
    }
  } catch { /* fall through to plain text parse */ }
  const text = clean(trimmed);
  if (text.length < 8) throw new Error("line too short");
  const translated = translateFallback(ctx.trigger, ctx.language);
  return {
    text,
    source: "gemini",
    tags: defaultTags,
    action: defaultAction,
    translatedText: translated,
    language: ctx.language ?? "en-NG",
    machineTranslated: !!translated,
  };
}

export async function generateLine(ctx: AiContext): Promise<GeneratedLine> {
  try {
    const prompt = "Data (JSON):\n" + JSON.stringify(compactContext(ctx));
    const raw = await geminiText(prompt, SYSTEM, 260);
    return parseAiOutput(raw, ctx);
  } catch (e: any) {
    const text = fallbackLine(ctx);
    const translated = translateFallback(ctx.trigger, ctx.language);
    return {
      text,
      source: "template",
      tags: inferTags(ctx.trigger),
      action: inferAction(ctx.trigger),
      translatedText: translated,
      language: ctx.language ?? "en-NG",
      machineTranslated: !!translated,
      error: String(e?.message ?? e).slice(0, 200),
    };
  }
}

// ---------- Ask EcoVital (Grounded Q&A over pod data, section 5.2 #7) ----------
export interface AskInput {
  question: string;
  deviceName: string;
  profile: string;
  windowLabel?: string;
  latest: Partial<Record<MetricKey, number | null>>;
  hourlyBuckets: { timeRange: string; dust: number | null; air: number | null; temp: number | null; hum: number | null }[];
  recentEvents: { time: string; kind: string; metric: string | null; text: string }[];
  forecasts: Partial<Record<MetricKey, { predicted: number; horizonMin: number; confidence: string; trend: string }>>;
  /** The room forecast (estimates), including outside weather and red flags. */
  prediction?: any;
  /** Earlier messages in this chat, oldest first. */
  history?: { role: "user" | "assistant"; text: string }[];
  /** Language to answer in. */
  language?: string;
  /** Set when the new message is just a short yes/no to the assistant's last question. */
  followUp?: { answer: "yes" | "no"; question: string };
}

export interface AskOutput {
  answer: string;
  citations: string[];
  source: "gemini" | "template";
  language?: string;
  machineTranslated?: boolean;
}

const ASK_SYSTEM = `You are Ask EcoVital, a friendly helper inside an air monitor app. You talk like a kind, clear person explaining things to someone who has never heard of sensors. Your people are teachers, parents, students and clinic staff.

Rules for every answer:
1. Answer the question in the first sentence, plainly. Then explain what it means in real life, then give one simple thing they can do.
2. Use everyday words. If you must use a term, explain it in a few words (for example "humidity, which is how much moisture is in the air"). Never use words like telemetry, index, baseline, regression, bucket or sensor drift.
3. Use ONLY the numbers and times in the JSON you are given. Quote the real value and the time, for example "at 14:00 the air felt stuffy, at 58%". Never invent, round up, or guess a number. If the data does not cover it, say "I don't have data for that" and say what the pod can tell them instead.
4. What the numbers mean (use these to explain, never as new data):
   - Air freshness, 0 to 100, higher is fresher. 80 and above is fresh. Below 70 the room starts to feel stuffy.
   - Dust level, 0 to 100, lower is cleaner. Below 30 is clear. Above 35 is noticeable.
   - Temperature in °C. About 22 to 29 is comfortable. Above 30 feels hot.
   - Humidity in %. 35 to 65 is comfortable. Below 30 feels dry. Above 70 feels damp and sticky.
5. Dust and air freshness are simple 0 to 100 scores from low-cost sensors. Never give them units like µg/m³ or ppm, never name CO₂ or PM2.5, and never say anything is dangerous to health or diagnose anyone. Say "may help" or "consider".
6. Say whether a number was measured right now or is an estimate of what comes next, and give the time window for past readings.
7. The pod cannot switch fans or windows on by itself. Advice such as "open a window" is for the person to do.
8. The JSON may include "prediction": the pod's forecast for the next hour (estimates), the outside weather, and red flags. Use it for questions about what will happen, why a reading is moving, or whether the weather matters. Always call forecast numbers estimates ("it looks like", "may"), give the time (for example "in about 30 minutes"), and explain a red flag simply. If "outsideWeather" says it is not available, say the outside weather is not known because the pod has no location set, and tell them they can set it on the pod's page.
9. Keep it short: 3 to 5 sentences, no lists, no markdown, no emojis. You may end with one short follow-up question.
10. You are in a conversation. Short messages such as "yes", "no", "ok", "tell me more" or "why" answer YOUR previous message, so use the conversation so far and carry on from it. Never treat them as a new topic.`;

function describeReadingPlainly(latest: Partial<Record<MetricKey, number | null>>): string {
  const bits: string[] = [];
  if (latest.air != null) {
    const feel = latest.air >= 80 ? "fresh and clean" : latest.air >= 65 ? "slightly stuffy" : "stuffy — fresh air will help";
    bits.push(`Air freshness is ${fmt("air", latest.air)}% (${feel})`);
  }
  if (latest.dust != null) {
    const feel = latest.dust < 25 ? "very low dust" : latest.dust < 40 ? "moderate dust" : "dusty";
    bits.push(`Dust level is ${fmt("dust", latest.dust)}% (${feel})`);
  }
  if (latest.temp != null) {
    const feel = latest.temp > 30.5 ? "a bit warm" : latest.temp < 20 ? "cool" : "comfortable";
    bits.push(`Temperature is ${fmt("temp", latest.temp)}°C (${feel})`);
  }
  if (latest.hum != null) {
    const feel = latest.hum < 30 ? "dry" : latest.hum > 70 ? "damp" : "comfortable moisture";
    bits.push(`Humidity is ${fmt("hum", latest.hum)}% (${feel})`);
  }
  return bits.join(", ");
}

export async function answerPodQuestion(
  arg1: AskInput | string,
  arg2?: any,
): Promise<AskOutput> {
  const input: AskInput =
    typeof arg1 === "string"
      ? {
          question: arg1,
          deviceName: arg2?.podName || arg2?.deviceName || arg2?.podId || "Pod",
          profile: arg2?.profile || "classroom",
          windowLabel: arg2?.windowLabel || "last 24 hours",
          latest: arg2?.latest || {},
          hourlyBuckets: arg2?.hourlyBuckets || [],
          recentEvents: (arg2?.recentEvents || []).map((e: any) => ({
            time: e.time || e.ts || "",
            kind: e.kind || "alert",
            metric: e.metric ?? null,
            text: e.text || e.message || "",
          })),
          forecasts: arg2?.forecasts || {},
        }
      : {
          ...arg1,
          windowLabel: arg1.windowLabel || "last 24 hours",
          hourlyBuckets: arg1.hourlyBuckets || [],
          recentEvents: arg1.recentEvents || [],
          latest: arg1.latest || {},
          forecasts: arg1.forecasts || {},
        };

  const citations: string[] = [];
  if (input.hourlyBuckets.length) {
    const first = input.hourlyBuckets[0].timeRange.split("-")[0];
    const last = input.hourlyBuckets[input.hourlyBuckets.length - 1].timeRange.split("-")[1] ?? "now";
    citations.push(`used ${first}-${last} readings (${input.hourlyBuckets.length} windows)`);
  }
  if (input.recentEvents.length) {
    citations.push(`${input.recentEvents.length} recent event${input.recentEvents.length === 1 ? "" : "s"}`);
  }
  const qLower = input.question.toLowerCase();

  // Deterministic honesty guard for unsupported sensors or medical diagnosis
  if (/\b(co2|carbon dioxide|pm2\.?5|pm10|radon|pollen|cure|asthma attack|disease|diagnos|bronchitis)\b/i.test(qLower)) {
    return {
      answer: "I don't have data for that. This EcoVital pod measures everyday room comfort — dust level (0–100%, where lower is cleaner), air freshness (0–100%, where higher is cleaner), temperature (°C), and humidity (%). It does not have a calibrated CO₂ or PM2.5 sensor and cannot provide medical advice or diagnosis. Would you like me to check how fresh or comfortable the room feels right now?",
      citations: citations.length ? citations : ["sensor & medical honesty guard"],
      source: "template",
    };
  }

  if (input.hourlyBuckets.length === 0 && Object.values(input.latest).every((v) => v === null || v === undefined)) {
    return {
      answer: "I don't have data for that yet because this pod hasn't sent its first reading. Make sure the pod is plugged in and showing green Wi-Fi bars, then ask me again in a few seconds!",
      citations: ["no readings in window"],
      source: "template",
    };
  }

  const lang = normLang(input.language);
  try {
    const { history, followUp, ...data } = input;
    const convo = (history ?? []).slice(-8).map((m) => `${m.role === "user" ? "User" : "You"}: ${m.text}`).join("\n");
    const prompt =
      (convo ? `Conversation so far:\n${convo}\n\n` : "") +
      `New message from the user: ${input.question}\n` +
      (followUp ? `(This is a short reply to your last question: "${followUp.question}". They said "${followUp.answer}". Carry on from that question.)\n` : "") +
      `Room & Sensor Data (JSON):\n${JSON.stringify({ ...data, question: undefined })}`;
    const raw = await geminiText(prompt, `${ASK_SYSTEM}\n11. Reply in ${LANGS[lang].prompt}. Keep any numbers exactly as given.`, 700);
    const cleaned = raw.replace(/[*_`#]/g, "").trim();
    if (cleaned.length > 10) {
      return { answer: cleaned, citations, source: "gemini", language: lang, machineTranslated: LANGS[lang].machine };
    }
  } catch { /* fall back to friendly grounded answer */ }

  // A bare yes/no with no AI available: move the conversation on instead of treating it as a new question.
  if (input.followUp) {
    if (input.followUp.answer === "no") {
      return { answer: "No problem. Ask me anything else about your room whenever you like.", citations: [], source: "template", language: "en-NG" };
    }
    const bits: string[] = [];
    const plain = describeReadingPlainly(input.latest);
    if (plain) bits.push(`Right now in ${input.deviceName} (Measured): ${plain}.`);
    const p = input.prediction;
    if (p && !p.stale) {
      bits.push(`${p.headline} (estimate).`);
      if (p.redFlags?.[0]) bits.push(`${p.redFlags[0].title}. ${p.redFlags[0].explanation}`);
      if (p.suggestion && p.suggestion !== "No action needed right now.") bits.push(p.suggestion);
      citations.push("room forecast (estimate)");
    }
    bits.push("Is there anything else you would like to know?");
    return { answer: bits.join(" "), citations: Array.from(new Set(citations)), source: "template", language: "en-NG" };
  }

  // Friendly, plain-English fallback answer for non-technical users
  const parts: string[] = [];
  const plainNow = describeReadingPlainly(input.latest);

  if (/\b(mean|explain|understand|what is|what are|help|numbers|work)\b/i.test(qLower)) {
    parts.push(
      `Here is an easy way to read ${input.deviceName}: Air index (0–100%) shows how fresh the air is — closer to 100% is best. Dust level (0–100%) shows airborne dust — closer to 0% is cleanest. Temperature (°C) and Humidity (%) show how warm and moist the air feels.`,
    );
    if (plainNow) parts.push(`Right now (Measured): ${plainNow}.`);
    parts.push("Which of these readings would you like tips on improving?");
    return { answer: parts.join(" "), citations: Array.from(new Set(citations)), source: "template" };
  }

  if (plainNow) {
    parts.push(`Right now in ${input.deviceName} (Measured): ${plainNow}.`);
  }

  if (qLower.includes("speak") || qLower.includes("said") || qLower.includes("alert") || qLower.includes("why")) {
    if (input.recentEvents.length > 0) {
      const ev = input.recentEvents[0];
      parts.push(`Earlier at ${ev.time}, the pod spoke out loud: "${ev.text}"`);
    } else {
      parts.push("The pod hasn't needed to speak an alert recently because readings have stayed within comfortable limits.");
    }
  } else if (input.hourlyBuckets.length > 0) {
    let worstAir = input.hourlyBuckets[0];
    let highestDust = input.hourlyBuckets[0];
    for (const b of input.hourlyBuckets) {
      if (b.air !== null && (worstAir.air === null || b.air < worstAir.air)) worstAir = b;
      if (b.dust !== null && (highestDust.dust === null || b.dust > highestDust.dust)) highestDust = b;
    }
    if (qLower.includes("air") && worstAir.air !== null) {
      parts.push(`Looking back, the air felt stuffiest around ${worstAir.timeRange} (air freshness dropped to ${worstAir.air.toFixed(0)}%). Opening windows on opposite sides of the room is the easiest way to let fresh breeze in.`);
      citations.unshift(`used ${worstAir.timeRange} readings`);
    } else if (qLower.includes("dust") && highestDust.dust !== null) {
      parts.push(`The room was dustiest during ${highestDust.timeRange} (dust level reached ${highestDust.dust.toFixed(0)}%). Closing road-facing windows when it is windy outside and wiping desks with a damp cloth helps keep dust down.`);
      citations.unshift(`used ${highestDust.timeRange} readings`);
    } else if (worstAir.air !== null && highestDust.dust !== null) {
      parts.push(`Over the ${input.windowLabel}, the room was stuffiest around ${worstAir.timeRange} (${worstAir.air.toFixed(0)}% air freshness) and dustiest around ${highestDust.timeRange} (${highestDust.dust.toFixed(0)}% dust).`);
    }
  }

  if (input.prediction && !input.prediction.stale && /\b(forecast|predict|next|later|soon|will|going to|expect|trend|weather|rain|outside|why)\b/i.test(qLower)) {
    parts.push(`${input.prediction.headline} (estimate).`);
    const flag = input.prediction.redFlags?.[0];
    if (flag) parts.push(`${flag.title}. ${flag.explanation}`);
    else if (input.prediction.outsideWeather && typeof input.prediction.outsideWeather === "object") {
      const w = input.prediction.outsideWeather;
      parts.push(`Outside it is ${w.temperatureC}°C and ${w.sky}.`);
    }
    if (input.prediction.suggestion && input.prediction.suggestion !== "No action needed right now.") parts.push(input.prediction.suggestion);
    citations.push("room forecast (estimate)");
  }

  const fKeys = METRIC_KEYS.filter((k) => input.forecasts[k]);
  if (fKeys.length && (qLower.includes("forecast") || qLower.includes("next") || qLower.includes("trend") || qLower.includes("estimate"))) {
    const k = fKeys[0];
    const f = input.forecasts[k]!;
    parts.push(`Looking ahead, our 10-minute estimate shows ${METRICS[k].label.toLowerCase()} is ${f.trend} toward ${fmt(k, f.predicted)}${METRICS[k].unit}.`);
    citations.push("10-min linear trend estimate");
  }

  parts.push("Would you like me to suggest a quick way to make the room more comfortable, or check another time of day?");

  return {
    answer: parts.join(" ") || "I don't have data for that time range.",
    citations: Array.from(new Set(citations)),
    source: "template",
  };
}

// ---------- Daily / Weekly Insight Card writer (section 5.2 #8) ----------
export interface InsightStats {
  deviceName: string;
  period: "daily" | "weekly";
  bestHour: string;
  worstHour: string;
  worstMetric: string;
  alertsCount: number;
  earlyWarningsCount: number;
  comparedToPrev: string;
  suggestion: string;
}

export async function generateInsightText(stats: InsightStats): Promise<{ text: string; source: "gemini" | "template" }> {
  const sys = `You are EcoVital's friendly room guide. Write a warm, easy-to-understand 2-to-3 sentence daily/weekly summary for a non-technical user (like a teacher or parent) using ONLY the provided statistics.
Explain when the room felt most comfortable, when it needed attention, and end with the practical everyday suggestion. Never invent numbers and never use technical units like ug/m3 or ppm.`;
  try {
    const raw = await geminiText(JSON.stringify(stats), sys, 260);
    const cleaned = raw.replace(/[*_`#]/g, "").trim();
    if (cleaned.length >= 20) return { text: cleaned, source: "gemini" };
  } catch { /* fallback */ }
  const text = `In ${stats.deviceName}, the air felt most comfortable around ${stats.bestHour}, while ${stats.worstHour} was the busiest time for ${stats.worstMetric.toLowerCase()} (${stats.alertsCount} spoken alert${stats.alertsCount === 1 ? "" : "s"}, ${stats.comparedToPrev}). Everyday tip: ${stats.suggestion}`;
  return { text, source: "template" };
}

// ---------- 20-Scenario Fixed AI Evaluation Set (section 5.3) ----------
export interface EvalScenario {
  id: number;
  name: string;
  ctx: AiContext;
  expectedAction: ActionCode;
  expectedTag: "measured" | "estimate";
}

function mkSummary(last: number, change = 0): Summary {
  return { n: 24, first: last - change, last, min: Math.min(last, last - change), max: Math.max(last, last - change), avg: last - change / 2, change };
}

export const AI_EVAL_SCENARIOS: EvalScenario[] = [
  { id: 1, name: "Dry harmattan air (hum watch-low)", expectedAction: "water", expectedTag: "measured", ctx: { deviceName: "Room 4", trigger: { kind: "alert", metric: "hum", status: "watch-low", prevStatus: "ok", value: 24, priority: 80 }, summaries: { hum: mkSummary(24, -8), temp: mkSummary(29), dust: mkSummary(20), air: mkSummary(85) }, statuses: { hum: "watch-low" }, forecasts: {} } },
  { id: 2, name: "Classroom dust rising (dust watch-high)", expectedAction: "close_window", expectedTag: "measured", ctx: { deviceName: "Room 4", trigger: { kind: "alert", metric: "dust", status: "watch-high", prevStatus: "ok", value: 42, priority: 80 }, summaries: { dust: mkSummary(42, 14), air: mkSummary(82), temp: mkSummary(28), hum: mkSummary(55) }, statuses: { dust: "watch-high" }, forecasts: {} } },
  { id: 3, name: "Severe dust storm (dust bad-high)", expectedAction: "close_window", expectedTag: "measured", ctx: { deviceName: "Room 4", trigger: { kind: "alert", metric: "dust", status: "bad-high", prevStatus: "watch-high", value: 74, priority: 100 }, summaries: { dust: mkSummary(74, 25), air: mkSummary(76), temp: mkSummary(30), hum: mkSummary(32) }, statuses: { dust: "bad-high" }, forecasts: {} } },
  { id: 4, name: "Stale classroom air (air watch-low)", expectedAction: "open_window", expectedTag: "measured", ctx: { deviceName: "Room 4", trigger: { kind: "alert", metric: "air", status: "watch-low", prevStatus: "ok", value: 64, priority: 80 }, summaries: { air: mkSummary(64, -10), dust: mkSummary(18), temp: mkSummary(29), hum: mkSummary(62) }, statuses: { air: "watch-low" }, forecasts: {} } },
  { id: 5, name: "Poor air / fumes (air bad-low)", expectedAction: "open_window", expectedTag: "measured", ctx: { deviceName: "Generator Side Lab", trigger: { kind: "alert", metric: "air", status: "bad-low", prevStatus: "watch-low", value: 38, priority: 100 }, summaries: { air: mkSummary(38, -22), dust: mkSummary(30), temp: mkSummary(31), hum: mkSummary(60) }, statuses: { air: "bad-low" }, forecasts: {} } },
  { id: 6, name: "Warm afternoon (temp watch-high)", expectedAction: "fan", expectedTag: "measured", ctx: { deviceName: "Lecture Hall", trigger: { kind: "alert", metric: "temp", status: "watch-high", prevStatus: "ok", value: 31.5, priority: 80 }, summaries: { temp: mkSummary(31.5, 1.8), hum: mkSummary(64), dust: mkSummary(15), air: mkSummary(80) }, statuses: { temp: "watch-high" }, forecasts: {} } },
  { id: 7, name: "Very hot room (temp bad-high)", expectedAction: "ac", expectedTag: "measured", ctx: { deviceName: "Top Floor Classroom", trigger: { kind: "alert", metric: "temp", status: "bad-high", prevStatus: "watch-high", value: 37.2, priority: 100 }, summaries: { temp: mkSummary(37.2, 2.5), hum: mkSummary(58), dust: mkSummary(22), air: mkSummary(75) }, statuses: { temp: "bad-high" }, forecasts: {} } },
  { id: 8, name: "Chilly morning (temp watch-low)", expectedAction: "close_window", expectedTag: "measured", ctx: { deviceName: "Nursery", profile: "nursery", trigger: { kind: "alert", metric: "temp", status: "watch-low", prevStatus: "ok", value: 15.2, priority: 80 }, summaries: { temp: mkSummary(15.2, -1.5), hum: mkSummary(48), dust: mkSummary(10), air: mkSummary(92) }, statuses: { temp: "watch-low" }, forecasts: {} } },
  { id: 9, name: "Damp rainy afternoon (hum watch-high)", expectedAction: "fan", expectedTag: "measured", ctx: { deviceName: "Room 2", trigger: { kind: "alert", metric: "hum", status: "watch-high", prevStatus: "ok", value: 73, priority: 80 }, summaries: { hum: mkSummary(73, 6), temp: mkSummary(26), dust: mkSummary(9), air: mkSummary(88) }, statuses: { hum: "watch-high" }, forecasts: {} } },
  { id: 10, name: "Very humid room (hum bad-high)", expectedAction: "fan", expectedTag: "measured", ctx: { deviceName: "Ground Floor Lab", trigger: { kind: "alert", metric: "hum", status: "bad-high", prevStatus: "watch-high", value: 86, priority: 100 }, summaries: { hum: mkSummary(86, 8), temp: mkSummary(27), dust: mkSummary(11), air: mkSummary(79) }, statuses: { hum: "bad-high" }, forecasts: {} } },
  { id: 11, name: "Early warning: humidity sliding toward dry", expectedAction: "water", expectedTag: "estimate", ctx: { deviceName: "Room 4", trigger: { kind: "predictive", metric: "hum", status: "ok", prevStatus: "ok", value: 34, priority: 40, crossing: { threshold: 30, side: "low", level: "watch", minutes: 6 } }, summaries: { hum: mkSummary(34, -4), temp: mkSummary(29), dust: mkSummary(16), air: mkSummary(86) }, statuses: { hum: "ok" }, forecasts: {} } },
  { id: 12, name: "Early warning: dust climbing toward watch", expectedAction: "close_window", expectedTag: "estimate", ctx: { deviceName: "Room 4", trigger: { kind: "predictive", metric: "dust", status: "ok", prevStatus: "ok", value: 29, priority: 40, crossing: { threshold: 35, side: "high", level: "watch", minutes: 5 } }, summaries: { dust: mkSummary(29, 7), temp: mkSummary(28), hum: mkSummary(50), air: mkSummary(84) }, statuses: { dust: "ok" }, forecasts: {} } },
  { id: 13, name: "Early warning: air index falling toward stale", expectedAction: "open_window", expectedTag: "estimate", ctx: { deviceName: "Closed Seminar Room", trigger: { kind: "predictive", metric: "air", status: "ok", prevStatus: "ok", value: 74, priority: 40, crossing: { threshold: 70, side: "low", level: "watch", minutes: 4 } }, summaries: { air: mkSummary(74, -6), dust: mkSummary(14), temp: mkSummary(28.5), hum: mkSummary(61) }, statuses: { air: "ok" }, forecasts: {} } },
  { id: 14, name: "Early warning: temperature rising toward warm", expectedAction: "fan", expectedTag: "estimate", ctx: { deviceName: "Room 4", trigger: { kind: "predictive", metric: "temp", status: "ok", prevStatus: "ok", value: 29.1, priority: 40, crossing: { threshold: 30, side: "high", level: "watch", minutes: 7 } }, summaries: { temp: mkSummary(29.1, 0.8), hum: mkSummary(55), dust: mkSummary(12), air: mkSummary(88) }, statuses: { temp: "ok" }, forecasts: {} } },
  { id: 15, name: "Early warning: humidity rising toward damp", expectedAction: "fan", expectedTag: "estimate", ctx: { deviceName: "Bedroom", profile: "bedroom", trigger: { kind: "predictive", metric: "hum", status: "ok", prevStatus: "ok", value: 64, priority: 40, crossing: { threshold: 68, side: "high", level: "watch", minutes: 8 } }, summaries: { hum: mkSummary(64, 5), temp: mkSummary(26.5), dust: mkSummary(10), air: mkSummary(90) }, statuses: { hum: "ok" }, forecasts: {} } },
  { id: 16, name: "Recovery: humidity back to normal", expectedAction: "none", expectedTag: "measured", ctx: { deviceName: "Room 4", trigger: { kind: "recovered", metric: "hum", status: "ok", prevStatus: "watch-low", value: 45, priority: 60 }, summaries: { hum: mkSummary(45, 12), temp: mkSummary(27.5), dust: mkSummary(11), air: mkSummary(90) }, statuses: { hum: "ok" }, forecasts: {} } },
  { id: 17, name: "Recovery: dust cleared after sweeping", expectedAction: "none", expectedTag: "measured", ctx: { deviceName: "Room 4", trigger: { kind: "recovered", metric: "dust", status: "ok", prevStatus: "watch-high", value: 18, priority: 60 }, summaries: { dust: mkSummary(18, -20), air: mkSummary(89), temp: mkSummary(28), hum: mkSummary(52) }, statuses: { dust: "ok" }, forecasts: {} } },
  { id: 18, name: "Recovery: fresh air restored", expectedAction: "none", expectedTag: "measured", ctx: { deviceName: "Room 4", trigger: { kind: "recovered", metric: "air", status: "ok", prevStatus: "bad-low", value: 84, priority: 60 }, summaries: { air: mkSummary(84, 30), dust: mkSummary(15), temp: mkSummary(27.8), hum: mkSummary(56) }, statuses: { air: "ok" }, forecasts: {} } },
  { id: 19, name: "Partial sensor data (MQ135 warming up, dust high)", expectedAction: "close_window", expectedTag: "measured", ctx: { deviceName: "New Pod", trigger: { kind: "alert", metric: "dust", status: "watch-high", prevStatus: "ok", value: 48, priority: 80 }, summaries: { dust: mkSummary(48, 10), temp: mkSummary(28.2), hum: mkSummary(54) }, statuses: { dust: "watch-high" }, forecasts: {} } },
  { id: 20, name: "Igbo language translation check on dry air", expectedAction: "water", expectedTag: "measured", ctx: { deviceName: "FUTO Hall", language: "ig", trigger: { kind: "alert", metric: "hum", status: "watch-low", prevStatus: "ok", value: 25, priority: 80 }, summaries: { hum: mkSummary(25, -7), temp: mkSummary(30), dust: mkSummary(24), air: mkSummary(82) }, statuses: { hum: "watch-low" }, forecasts: {} } },
];

export async function runAiEvaluationSuite(): Promise<{
  total: number;
  passed: number;
  results: { id: number; name: string; pass: boolean; wordCount: number; action: ActionCode; expectedAction: ActionCode; tags: string[]; line: string; translatedText?: string; reason?: string }[];
}> {
  const results = [];
  let passed = 0;
  for (const sc of AI_EVAL_SCENARIOS) {
    const out = await generateLine(sc.ctx);
    const words = out.text.trim().split(/\s+/).filter(Boolean).length;
    const forbiddenUnits = /\b(ug\/m3|µg\/m3|ppm|ppb|co2|carbon dioxide)\b/i.test(out.text);
    const forbiddenMedical = /\b(cure|diagnos|disease|fatal|toxic|hospital)\b/i.test(out.text);
    const actionMatch = out.action === sc.expectedAction;
    const tagMatch = out.tags.includes(sc.expectedTag);
    const estimatePhrased = sc.expectedTag !== "estimate" || /\b(estimate|looks like|may|about)\b/i.test(out.text);
    const pass = words <= 32 && !forbiddenUnits && !forbiddenMedical && actionMatch && tagMatch && estimatePhrased;
    if (pass) passed++;
    results.push({
      id: sc.id,
      name: sc.name,
      pass,
      wordCount: words,
      action: out.action,
      expectedAction: sc.expectedAction,
      tags: out.tags,
      line: out.text,
      translatedText: out.translatedText,
      reason: pass ? undefined : `words=${words}, action=${out.action}/${sc.expectedAction}, tags=${out.tags.join(",")}`,
    });
  }
  return { total: AI_EVAL_SCENARIOS.length, passed, results };
}


// ---------- text to speech ----------

export const TTS_RATE = 24000;

export function makeWav(pcm: Buffer, rate = TTS_RATE): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function findAudio(node: any): { data: string; mime?: string } | null {
  let found: { data: string; mime?: string } | null = null;
  const walk = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    const inline = n.inlineData ?? n.inline_data;
    if (inline && typeof inline.data === "string") found = { data: inline.data, mime: inline.mimeType ?? inline.mime_type };
    if (n.type === "audio" && typeof n.data === "string") found = { data: n.data, mime: n.mime_type ?? n.mimeType };
    Object.values(n).forEach(walk);
  };
  walk(node);
  return found;
}

function toMono24k(buf: Buffer, mime?: string): Buffer {
  let pcm = buf, rate = TTS_RATE;
  if (buf.length > 44 && buf.toString("ascii", 0, 4) === "RIFF") {
    rate = buf.readUInt32LE(24);
    const idx = buf.indexOf("data", 12, "ascii");
    pcm = buf.subarray(idx >= 0 ? idx + 8 : 44);
  } else {
    const m = /rate=(\d+)/.exec(mime ?? "");
    if (m) rate = parseInt(m[1], 10);
  }
  if (rate === TTS_RATE) return Buffer.from(pcm);
  // simple linear resample to 24 kHz
  const inN = Math.floor(pcm.length / 2);
  const outN = Math.floor((inN * TTS_RATE) / rate);
  const out = Buffer.alloc(outN * 2);
  for (let i = 0; i < outN; i++) {
    const pos = (i * rate) / TTS_RATE, i0 = Math.floor(pos), fr = pos - i0;
    const a = pcm.readInt16LE(Math.min(i0, inN - 1) * 2), b = pcm.readInt16LE(Math.min(i0 + 1, inN - 1) * 2);
    out.writeInt16LE(Math.round(a + (b - a) * fr), i * 2);
  }
  return out;
}

/** Documented Gemini speech route (generateContent with an AUDIO response). Returns 16-bit mono PCM at 24 kHz. */
async function synthesizeStandard(text: string): Promise<Buffer> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const model = process.env.GEMINI_TTS_STD_MODEL || "gemini-2.5-flash-preview-tts";
  const voice = process.env.GEMINI_VOICE || "Kore";
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST", signal: ctl.signal,
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      }),
    });
    if (!res.ok) throw new Error(`Gemini TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const a = findAudio(await res.json());
    if (!a) throw new Error("Gemini TTS response had no audio");
    const pcm = toMono24k(Buffer.from(a.data, "base64"), a.mime);
    if (pcm.length < 2000) throw new Error("Gemini TTS audio too short");
    return pcm;
  } finally {
    clearTimeout(timer);
  }
}

/** Returns 16-bit mono PCM at 24 kHz. Tries the documented route first, then the older one. Throws if both fail. */
export async function synthesize(rawText: string, lang?: string): Promise<Buffer> {
  const text = (lang && LANGS[lang]?.tts ? LANGS[lang].tts : "") + rawText;
  try {
    return await synthesizeStandard(text);
  } catch (first) {
    try {
      return await synthesizeInteractions(text);
    } catch (second) {
      throw new Error(`${(first as Error).message}; then ${(second as Error).message}`.slice(0, 400));
    }
  }
}

async function synthesizeInteractions(text: string): Promise<Buffer> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const model = process.env.GEMINI_TTS_MODEL || "gemini-3.8-flash-tts";
  const voice = process.env.GEMINI_VOICE || "Kore";
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST", signal: ctl.signal,
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        model,
        input: [{ type: "user_input", content: [{ type: "text", text }] }],
        response_format: { type: "audio", mime_type: "audio/l16", sample_rate: TTS_RATE },
        generation_config: { speech_config: [{ voice }] },
      }),
    });
    if (!res.ok) throw new Error(`Gemini TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const a = findAudio(await res.json());
    if (!a) throw new Error("Gemini TTS response had no audio");
    const pcm = toMono24k(Buffer.from(a.data, "base64"), a.mime);
    if (pcm.length < 2000) throw new Error("Gemini TTS audio too short");
    return pcm;
  } finally {
    clearTimeout(timer);
  }
}
