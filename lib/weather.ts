// Outside weather for a pod's location, from Open-Meteo (free, no key). Used to explain and sharpen the room forecast.
// Everything here is labelled "outside data" in the app. If the lookup fails the forecast simply runs without it.

export interface OutsideHour {
  t: number;        // ms since epoch (start of the hour, UTC)
  temp: number;     // °C
  hum: number;      // % relative humidity
  rainChance: number; // 0-100
  rainMm: number;
}

export interface Outside {
  source: "Open-Meteo";
  fetchedAt: number;
  hours: OutsideHour[];          // about 7 days back to 2 days ahead, hourly
  now: { temp: number; hum: number; rainMm: number; code: number | null };
}

type Fetcher = (url: string) => Promise<any>;

const defaultFetcher: Fetcher = async (url) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`weather ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
};

let fetcher: Fetcher = defaultFetcher;
/** Tests replace the network call with fixed data. */
export function setWeatherFetcher(f: Fetcher | null) {
  fetcher = f ?? defaultFetcher;
  cache.clear();
}

const cache = new Map<string, Outside | null>();
const CACHE_MS = 15 * 60_000;
const cacheAt = new Map<string, number>();

export async function getOutside(lat: number | null | undefined, lng: number | null | undefined, now = Date.now()): Promise<Outside | null> {
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (process.env.WEATHER === "off") return null;
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  const at = cacheAt.get(key) ?? 0;
  if (cache.has(key) && now - at < CACHE_MS) return cache.get(key) ?? null;

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}` +
    `&current=temperature_2m,relative_humidity_2m,precipitation,weather_code` +
    `&hourly=temperature_2m,relative_humidity_2m,precipitation_probability,precipitation` +
    `&past_days=7&forecast_days=2&timezone=GMT`;
  try {
    const j = await fetcher(url);
    const times: string[] = j?.hourly?.time ?? [];
    const T: (number | null)[] = j?.hourly?.temperature_2m ?? [];
    const H: (number | null)[] = j?.hourly?.relative_humidity_2m ?? [];
    const P: (number | null)[] = j?.hourly?.precipitation_probability ?? [];
    const R: (number | null)[] = j?.hourly?.precipitation ?? [];
    const hours: OutsideHour[] = [];
    for (let i = 0; i < times.length; i++) {
      if (T[i] == null || H[i] == null) continue;
      hours.push({
        t: Date.parse(times[i] + "Z"),
        temp: Number(T[i]),
        hum: Number(H[i]),
        rainChance: Number(P[i] ?? 0),
        rainMm: Number(R[i] ?? 0),
      });
    }
    if (!hours.length) throw new Error("no hourly data");
    const c = j?.current;
    const out: Outside = {
      source: "Open-Meteo",
      fetchedAt: now,
      hours,
      now: {
        temp: Number(c?.temperature_2m ?? at_(hours, now, "temp")),
        hum: Number(c?.relative_humidity_2m ?? at_(hours, now, "hum")),
        rainMm: Number(c?.precipitation ?? 0),
        code: c?.weather_code != null ? Number(c.weather_code) : null,
      },
    };
    cache.set(key, out);
    cacheAt.set(key, now);
    return out;
  } catch {
    cache.set(key, null);
    cacheAt.set(key, now - CACHE_MS + 60_000);   // retry in a minute
    return null;
  }
}

/** Linear interpolation of an hourly field at time t. */
export function at_(hours: OutsideHour[], t: number, f: "temp" | "hum" | "rainChance" | "rainMm"): number {
  if (!hours.length) return NaN;
  if (t <= hours[0].t) return hours[0][f];
  const last = hours[hours.length - 1];
  if (t >= last.t) return last[f];
  let lo = 0, hi = hours.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (hours[mid].t <= t) lo = mid; else hi = mid; }
  const a = hours[lo], b = hours[hi];
  const w = (t - a.t) / (b.t - a.t);
  return a[f] + (b[f] - a[f]) * w;
}

/** Highest rain chance (0-100) between t and t+ms. */
export function maxRainChance(hours: OutsideHour[], t: number, ms: number): number {
  let m = at_(hours, t, "rainChance");
  for (const h of hours) if (h.t >= t && h.t <= t + ms) m = Math.max(m, h.rainChance);
  return Number.isFinite(m) ? m : 0;
}

export function describeWeather(code: number | null, rainMm: number): string {
  if (rainMm > 0.1) return "raining";
  if (code == null) return "dry";
  if (code === 0) return "clear";
  if (code <= 3) return "partly cloudy";
  if (code <= 48) return "foggy or hazy";
  if (code <= 67) return "raining";
  if (code <= 77) return "snowing";
  if (code <= 82) return "showery";
  return "stormy";
}
