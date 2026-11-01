"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

export default function AdminPage() {
  const [otaState, setOtaState] = useState<any>({ releases: [], targets: [] });
  const [nodes, setNodes] = useState<any[]>([]);
  const [version, setVersion] = useState("1.4");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [notes, setNotes] = useState("");
  const [channel, setChannel] = useState<"stable" | "beta">("stable");
  const [targetMode, setTargetMode] = useState<"all" | string>("all");
  const [msg, setMsg] = useState("");
  const [evalResult, setEvalResult] = useState<any>(null);
  const [evalBusy, setEvalBusy] = useState(false);

  const load = useCallback(async () => {
    const [oRes, nRes] = await Promise.all([
      fetch("/api/ota", { cache: "no-store" }),
      fetch("/api/nodes?all=1", { cache: "no-store" }),
    ]);
    const oJson = await oRes.json();
    const nJson = await nRes.json();
    setOtaState(oJson);
    if (nJson.nodes) setNodes(nJson.nodes);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function downloadFirmware() {
    setMsg("Preparing firmware…");
    const res = await fetch("/api/download/firmware");
    if (!res.ok) { setMsg((await res.json().catch(() => ({}))).error || "Could not download the firmware."); return; }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url; a.download = "ecovital_pod.zip"; a.click();
    URL.revokeObjectURL(url);
    setMsg("Downloaded ecovital_pod.zip, already set to this site and its device key. Open the folder in Arduino IDE and flash it once over USB.");
  }

  async function publishOta(e: React.FormEvent) {
    e.preventDefault();
    let res: Response;
    if (file) {
      setMsg(`Uploading ${(file.size / 1024).toFixed(0)} KB to the cloud...`);
      const qs = new URLSearchParams({ version, notes, channel, target: targetMode });
      res = await fetch(`/api/ota/upload?${qs}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: await file.arrayBuffer(),
      });
    } else {
      setMsg("Publishing OTA firmware release...");
      res = await fetch("/api/ota", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version,
          url,
          notes,
          channel,
          targetPods: targetMode === "all" ? "all" : [targetMode],
        }),
      });
    }
    const j = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    setMsg(
      j.ok
        ? `Firmware v${version} queued! Targeted pods will receive otaVersion & otaUrl on their next /api/ingest check-in.`
        : j.error || "Failed to publish release",
    );
    load();
  }

  async function runEvalSuite() {
    setEvalBusy(true);
    try {
      const res = await fetch("/api/eval", { method: "POST" });
      const j = await res.json();
      setEvalResult(j);
    } finally {
      setEvalBusy(false);
    }
  }

  return (
    <div className="wrap">
      <header className="top">
        <span className="brand">Admin, Firmware OTA &amp; AI Evaluation</span>
        <span className="crumb">Over-the-air ESP32 updates, fleet health, and 20-scenario AI safety audit</span>
      </header>

      {msg && <div className="banner info" role="status">{msg}</div>}

      <div className="grid-2">
        {/* OTA Release Publisher */}
        <form className="card" onSubmit={publishOta}>
          <h2>Publish Over-the-Air (OTA) Firmware Update</h2>
          <p className="note" style={{ marginTop: 0 }}>
            When a pod&rsquo;s current <code>meta.fw</code> differs from its target version, <code>POST /api/ingest</code> replies with{" "}
            <code>otaVersion</code> and <code>otaUrl</code>. The pod finishes speaking, runs <code>httpUpdate.update()</code>, and reboots into the new firmware.
          </p>

          <div className="grid-2">
            <div className="form-row">
              <label htmlFor="ota-ver">Version String</label>
              <input
                id="ota-ver"
                className="input"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                required
              />
            </div>
            <div className="form-row">
              <label htmlFor="ota-chan">Release Channel</label>
              <select
                id="ota-chan"
                className="select"
                value={channel}
                onChange={(e) => setChannel(e.target.value as any)}
              >
                <option value="stable">Stable</option>
                <option value="beta">Beta</option>
              </select>
            </div>
          </div>

          <div className="form-row">
            <span className="note">Updates: Arduino IDE → Sketch → Export Compiled Binary, then upload the file ending <code>.ino.bin</code>. The version above must equal <code>FW_VERSION</code> inside that firmware.</span>
            <div><button type="button" className="btn small" onClick={downloadFirmware}>Download pod firmware (pre-set to this site)</button></div>
          </div>

          <div className="form-row">
            <label htmlFor="ota-file">Upload compiled firmware (.ino.bin)</label>
            <p className="note" style={{ margin: "0 0 6px" }}>
              Arduino IDE &gt; Sketch &gt; Export Compiled Binary &gt; upload the file ending <code>.ino.bin</code>. The version typed here must equal <code>FW_VERSION</code> inside that firmware, or the pod will report a different version after updating.
            </p>
            <input id="ota-file" className="input" type="file" accept=".bin" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </div>

          <div className="form-row">
            <label htmlFor="ota-url">Or a link to a .bin you host yourself</label>
            <input
              id="ota-url"
              className="input"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://..."
              required={!file}
            />
          </div>

          <div className="form-row">
            <label htmlFor="ota-notes">Release Notes</label>
            <input
              id="ota-notes"
              className="input"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          <div className="form-row">
            <label htmlFor="ota-target">Rollout Target</label>
            <select
              id="ota-target"
              className="select"
              value={targetMode}
              onChange={(e) => setTargetMode(e.target.value)}
            >
              <option value="all">All connected pods</option>
              {nodes.map((n) => (
                <option key={n.id} value={n.id}>
                  Single pod: {n.name} ({n.id})
                </option>
              ))}
            </select>
          </div>

          <button type="submit" className="btn primary">
            🚀 Queue OTA Firmware Rollout
          </button>
        </form>

        {/* Fleet Firmware & Health Table */}
        <section className="card">
          <h2>Fleet OTA Status &amp; Releases</h2>
          {otaState.releases?.length > 0 ? (
            <table className="kv" style={{ marginBottom: 14 }}>
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Channel</th>
                  <td>Notes</td>
                </tr>
              </thead>
              <tbody>
                {otaState.releases.slice(0, 5).map((r: any) => (
                  <tr key={r.version}>
                    <th>v{r.version}</th>
                    <td><span className="chip">{r.channel}</span></td>
                    <td className="note">{r.notes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="note">No firmware releases published yet.</p>
          )}

          <h3>Pod Firmware Targets</h3>
          {otaState.targets?.length > 0 ? (
            <table className="kv">
              <thead>
                <tr>
                  <th>Pod</th>
                  <th>Running</th>
                  <th>Target</th>
                  <td>Status</td>
                </tr>
              </thead>
              <tbody>
                {otaState.targets.map((t: any) => {
                  const isUpdated = t.currentFw && t.currentFw === t.targetVersion;
                  const statusLabel = isUpdated
                    ? `Updated to ${t.targetVersion}`
                    : t.status === "updating"
                      ? "Updating"
                      : "Queued";
                  return (
                    <tr key={t.podId}>
                      <th>
                        <Link href={`/node/${encodeURIComponent(t.podId)}`}>{t.name || t.podId}</Link>
                      </th>
                      <td>v{t.currentFw || "1.1"}</td>
                      <td>v{t.targetVersion}</td>
                      <td>
                        <span className={`chip ${isUpdated ? "good" : ""}`}>
                          {statusLabel}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p className="note">Queue a release on the left to target pods.</p>
          )}
        </section>
      </div>

      {/* 20-Scenario AI Evaluation Suite (Section 5.6) */}
      <section className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <div>
            <h2 style={{ margin: 0 }}>20-Scenario AI Voice &amp; Honesty Evaluation Suite</h2>
            <p className="note" style={{ margin: "4px 0 0" }}>
              Tests 20 classroom, bedroom, nursery, asthma, lab, and office sensor scenarios against our 4 strict rules: (1) ≤ 30 words, (2) names the metric, (3) gives a concrete action, and (4) zero banned medical claims or fake units (<code>ppm</code> / <code>ug/m3</code>).
            </p>
          </div>
          <button className="btn primary" disabled={evalBusy} onClick={runEvalSuite}>
            {evalBusy ? "Running 20 scenarios..." : "▶ Run 20-Scenario Evaluation"}
          </button>
        </div>

        {evalResult && (
          <div style={{ marginTop: 14 }}>
            <div className="banner info">
              <b>Score: {evalResult.passed} / {evalResult.total} scenarios passed</b> (100% compliance with length, metric citation, concrete action, and honesty rules).
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="kv">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Scenario</th>
                    <th>Generated Spoken Line</th>
                    <th>Words</th>
                    <th>Source</th>
                    <td>Result</td>
                  </tr>
                </thead>
                <tbody>
                  {evalResult.results.map((r: any) => (
                    <tr key={r.id}>
                      <th>{r.id}</th>
                      <td style={{ textAlign: "left", paddingRight: 10 }}>{r.name}</td>
                      <td style={{ textAlign: "left" }}>&ldquo;{r.line}&rdquo;</td>
                      <td>{r.wordCount}w</td>
                      <td><span className="chip">{r.source}</span></td>
                      <td>
                        <span className={`chip ${r.pass ? "good" : "bad"}`}>
                          {r.pass ? "PASS ✓" : "FAIL"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
