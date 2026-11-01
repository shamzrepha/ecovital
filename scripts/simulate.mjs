// Sends fake readings to a running EcoVital server, exactly like the ESP32 does.
//
//   node scripts/simulate.mjs https://your-app.vercel.app YOUR_DEVICE_KEY [node-id]
//
// It runs: 4 minutes normal -> humidity slides down (alert) -> recovers. Press Ctrl+C to stop.

const [base, key, id = "bench-sim"] = process.argv.slice(2);
if (!base || !key) {
  console.error("Usage: node scripts/simulate.mjs <base-url> <device-key> [node-id]");
  process.exit(1);
}

let step = 0;
const wob = (i, k, a) => Math.sin(i * 1.7 + k * 3.1) * a;

function reading() {
  // 0-48: normal, 48-96: humidity falls 46 -> 22, 96-144: back to 46, then normal
  let hum = 46;
  if (step >= 48 && step < 96) hum = 46 - ((step - 48) / 48) * 24;
  else if (step >= 96 && step < 144) hum = 22 + ((step - 96) / 48) * 24;
  return {
    ageMs: 0,
    air: +(90 + wob(step, 1, 0.8)).toFixed(1),
    dust: +(8 + wob(step, 2, 1.2)).toFixed(1),
    temp: +(27.5 + wob(step, 3, 0.1)).toFixed(2),
    hum: +(hum + wob(step, 4, 0.3)).toFixed(1),
  };
}

async function tick() {
  const r = reading();
  step++;
  try {
    const res = await fetch(`${base}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-device-key": key },
      body: JSON.stringify({ deviceId: id, name: "Bench simulator", fw: "sim", readings: [r] }),
    });
    const j = await res.json();
    console.log(`#${step} hum=${r.hum} -> ${res.status}`, j.speak ? `SPEAK: "${j.speak.text}"` : "");
  } catch (e) {
    console.error("send failed:", e.message);
  }
}

console.log(`Sending to ${base} as "${id}" every 5 s...`);
tick();
setInterval(tick, 5000);
