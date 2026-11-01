import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin || "https://ecovital.vercel.app";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
  <title>EcoVital Remote Companion App</title>
  <style>
    :root { --bg: #0d1510; --card: #131f18; --ink: #e5f0e8; --sub: #92aa9b; --green: #1e9b3c; --lime: #7ccb4a; --blue: #5ca4db; --warn: #ee9f3a; --bad: #f26858; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, sans-serif; background: var(--bg); color: var(--ink); padding: 16px; }
    .wrap { max-width: 540px; margin: 0 auto; }
    .hdr { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #25382c; padding-bottom: 12px; margin-bottom: 16px; }
    .brand { font-size: 20px; font-weight: 700; color: var(--lime); }
    .pill { font-size: 12px; padding: 3px 10px; border-radius: 99px; background: #18271e; border: 1px solid #25382c; color: var(--sub); }
    .card { background: var(--card); border: 1px solid #25382c; border-radius: 14px; padding: 16px; margin-bottom: 14px; }
    .score { font-size: 44px; font-weight: 800; color: var(--lime); line-height: 1; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px; }
    .tile { background: #18271e; border: 1px solid #25382c; border-radius: 10px; padding: 10px 12px; }
    .tile .lbl { font-size: 12px; color: var(--sub); display: flex; justify-content: space-between; }
    .tile .val { font-size: 26px; font-weight: 700; margin-top: 4px; }
    .pred { border-left: 4px solid var(--blue); padding-left: 12px; margin-top: 10px; font-size: 14px; line-height: 1.45; }
    .btn { display: inline-block; background: var(--green); color: #fff; border: 0; padding: 10px 14px; border-radius: 8px; font-weight: 600; text-decoration: none; cursor: pointer; font-size: 14px; }
    .btn.alt { background: #18271e; border: 1px solid #25382c; color: var(--ink); }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hdr">
      <div>
        <div class="brand">EcoVital Companion App</div>
        <div style="font-size:12px;color:var(--sub)">Connected remotely to ${origin}</div>
      </div>
      <span class="pill" id="status">Connecting...</span>
    </div>

    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:12px;color:var(--sub);text-transform:uppercase">Active Room Score</div>
          <div id="podName" style="font-size:18px;font-weight:700;margin-top:2px">Loading pod...</div>
        </div>
        <div style="text-align:right">
          <div class="score" id="score">--</div>
          <div style="font-size:12px;color:var(--sub)" id="scoreWord">0-100 index</div>
        </div>
      </div>
      <div class="grid">
        <div class="tile"><div class="lbl"><span>Dust Index</span><span>Measured</span></div><div class="val" id="dust">--%</div></div>
        <div class="tile"><div class="lbl"><span>Air Index</span><span>Measured</span></div><div class="val" id="air">--%</div></div>
        <div class="tile"><div class="lbl"><span>Temperature</span><span>Measured</span></div><div class="val" id="temp">--°C</div></div>
        <div class="tile"><div class="lbl"><span>Humidity</span><span>Measured</span></div><div class="val" id="hum">--%</div></div>
      </div>
    </div>

    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <b style="color:var(--blue)">🔮 AI Multi-Horizon Prediction (+10m / +30m)</b>
        <span class="pill">Estimated</span>
      </div>
      <div class="pred" id="predHeadline">Fetching AI trend forecast from remote cloud...</div>
      <div style="font-size:13px;color:var(--sub);margin-top:8px" id="predAction"></div>
    </div>

    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <a class="btn" href="${origin}" target="_blank">Open Full Cloud Dashboard ↗</a>
      <button class="btn alt" onclick="refresh()">↻ Refresh Now</button>
    </div>
  </div>

  <script>
    const BASE = "${origin}";
    async function refresh() {
      try {
        const res = await fetch(BASE + "/api/nodes");
        const data = await res.json();
        const pod = (data.nodes || [])[0];
        if (!pod) return;
        document.getElementById("status").textContent = pod.online || pod.simulated ? "Live · Online" : "Offline";
        document.getElementById("podName").textContent = pod.name + (pod.location ? " · " + pod.location : "");
        document.getElementById("score").textContent = pod.roomScore ? pod.roomScore.score : "--";
        document.getElementById("scoreWord").textContent = pod.roomScore ? pod.roomScore.word : "";
        if (pod.latest) {
          document.getElementById("dust").textContent = Math.round(pod.latest.dust ?? 0) + "%";
          document.getElementById("air").textContent = Math.round(pod.latest.air ?? 0) + "%";
          document.getElementById("temp").textContent = Number(pod.latest.temp ?? 0).toFixed(1) + "°C";
          document.getElementById("hum").textContent = Math.round(pod.latest.hum ?? 0) + "%";
        }
        const pRes = await fetch(BASE + "/api/predict/" + encodeURIComponent(pod.id));
        const pred = await pRes.json();
        document.getElementById("predHeadline").textContent = pred.aiNarrative || pred.headline;
        document.getElementById("predAction").textContent = "Recommended action: " + pred.preventiveAction;
      } catch (e) {
        document.getElementById("status").textContent = "Reconnecting...";
      }
    }
    refresh();
    setInterval(refresh, 6000);
  </script>
</body>
</html>`;

  return new NextResponse(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `attachment; filename="EcoVital-Remote-App.html"`,
      "Cache-Control": "no-store",
    },
  });
}
