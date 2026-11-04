"use client";
import React, { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";

export interface EmergencyAlert {
  id?: string | number;
  podId?: string;
  podName?: string;
  cause?: string;
  title?: string;
  message?: string;
  ts?: number;
}

export default function EmergencySosOverlay() {
  const [alert, setAlert] = useState<EmergencyAlert | null>(null);
  const [dismissedId, setDismissedId] = useState<string | number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const oscIntervalRef = useRef<any>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);

  // Stop siren audio and vibration
  const stopAudio = useCallback(() => {
    if (oscIntervalRef.current) {
      clearInterval(oscIntervalRef.current);
      oscIntervalRef.current = null;
    }
    if (audioCtxRef.current) {
      try {
        audioCtxRef.current.close().catch(() => {});
      } catch (_) {}
      audioCtxRef.current = null;
    }
    if (audioElRef.current) {
      try {
        audioElRef.current.pause();
        audioElRef.current.currentTime = 0;
      } catch (_) {}
    }
    if (typeof navigator !== "undefined" && navigator.vibrate) {
      try {
        navigator.vibrate(0);
      } catch (_) {}
    }
  }, []);

  // Play continuous ambulance siren sound
  const playSiren = useCallback(() => {
    stopAudio();

    // If running inside Android companion app, native AlarmService handles the loud siren
    const isNativeApp = typeof window !== "undefined" && Boolean((window as any).AndroidBridge || (window as any).Android);
    if (isNativeApp) return;

    // 1. Try HTML Audio Element with /assets/siren.wav
    try {
      const audio = new Audio("/assets/siren.wav");
      audio.loop = true;
      audio.volume = 1.0;
      audioElRef.current = audio;
      const playPromise = audio.play();
      if (playPromise) {
        playPromise.catch(() => {
          // Fallback to Web Audio synthesis if file playback is blocked
          startSynthesizedSiren();
        });
      }
    } catch (_) {
      startSynthesizedSiren();
    }

    // 2. Continuous Emergency Vibration
    if (typeof navigator !== "undefined" && navigator.vibrate) {
      try {
        navigator.vibrate([500, 200, 500, 200, 800, 400]);
      } catch (_) {}
    }
  }, [stopAudio]);

  // Synthesized two-tone ambulance wail (720Hz <-> 960Hz)
  const startSynthesizedSiren = () => {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      audioCtxRef.current = ctx;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(720, ctx.currentTime);
      gain.gain.setValueAtTime(0.3, ctx.currentTime);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();

      let toggle = false;
      oscIntervalRef.current = setInterval(() => {
        if (!audioCtxRef.current || audioCtxRef.current.state === "closed") return;
        toggle = !toggle;
        osc.frequency.setValueAtTime(toggle ? 960 : 720, ctx.currentTime);
      }, 450);
    } catch (_) {}
  };

  const dismissAlert = () => {
    stopAudio();
    if (typeof window !== "undefined") {
      const bridge = (window as any).AndroidBridge || (window as any).Android;
      if (bridge?.stopAlarm) {
        try { bridge.stopAlarm(); } catch (_) {}
      }
    }
    if (alert?.id) {
      setDismissedId(alert.id);
    }
    setAlert(null);
  };

  const handleCallEmergency = () => {
    stopAudio();
    // If inside Android companion app, invoke native dialer
    if (typeof window !== "undefined" && (window as any).AndroidBridge?.callEmergency) {
      (window as any).AndroidBridge.callEmergency();
    }
    dismissAlert();
  };

  // Poll for emergency status from the server every 4 seconds
  useEffect(() => {
    let active = true;

    const checkEmergency = async () => {
      try {
        const res = await fetch("/api/emergency/status", { cache: "no-store" });
        if (!res.ok) return;
        const j = await res.json();
        if (active && j.active && j.alert) {
          if (j.alert.id !== dismissedId) {
            setAlert(j.alert);
          }
        } else if (active && !j.active && alert && !alert.id?.toString().startsWith("test-")) {
          dismissAlert();
        }
      } catch (_) {}
    };

    checkEmergency();
    const interval = setInterval(checkEmergency, 4000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [dismissedId, alert]);

  // Listen for local test events and broadcast events
  useEffect(() => {
    const handleAlarmEvent = (e: any) => {
      const detail = e.detail || {};
      setAlert({
        id: detail.id || `test-${Date.now()}`,
        podId: detail.podId || "ecovital-66f3a8",
        podName: detail.podName || "Living Room Pod",
        cause: detail.cause || "gas",
        title: detail.title || "🚨 CRITICAL AIR / GAS EMERGENCY",
        message: detail.message || "Dangerous air levels detected in room. Open windows immediately.",
        ts: Date.now(),
      });
    };

    window.addEventListener("ecovital:alarm", handleAlarmEvent);
    (window as any).triggerTestSos = (detail?: any) => {
      window.dispatchEvent(new CustomEvent("ecovital:alarm", { detail }));
    };

    return () => {
      window.removeEventListener("ecovital:alarm", handleAlarmEvent);
      delete (window as any).triggerTestSos;
    };
  }, []);

  // When alert changes to non-null, start playing siren
  useEffect(() => {
    if (alert) {
      playSiren();
    } else {
      stopAudio();
    }
    return () => {
      stopAudio();
    };
  }, [alert, playSiren, stopAudio]);

  if (!alert) return null;

  const isSmoke = alert.cause?.includes("smoke") || alert.title?.toLowerCase().includes("smoke");

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 999999,
        background: "rgba(185, 28, 28, 0.96)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        color: "#ffffff",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px 16px",
        textAlign: "center",
        animation: "emergencyPulse 1.2s ease-in-out infinite",
      }}
      role="alertdialog"
      aria-modal="true"
      aria-label="Emergency Air Hazard Alarm"
    >
      <style jsx>{`
        @keyframes emergencyPulse {
          0%, 100% {
            background-color: rgba(185, 28, 28, 0.96);
            box-shadow: inset 0 0 100px rgba(0, 0, 0, 0.6);
          }
          50% {
            background-color: rgba(220, 38, 38, 0.98);
            box-shadow: inset 0 0 140px rgba(254, 240, 138, 0.25);
          }
        }
        @keyframes sirenSpin {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.18); }
        }
        .siren-icon {
          font-size: 68px;
          line-height: 1;
          display: inline-block;
          animation: sirenSpin 0.8s ease-in-out infinite;
          margin-bottom: 12px;
        }
      `}</style>

      <div style={{ maxWidth: 520, width: "100%", margin: "0 auto" }}>
        <div className="siren-icon" aria-hidden="true">🚨</div>

        <h1
          style={{
            fontSize: "clamp(24px, 5vw, 34px)",
            fontWeight: 800,
            letterSpacing: "0.02em",
            margin: "0 0 8px",
            textTransform: "uppercase",
            color: "#FEF08A",
            textShadow: "0 2px 8px rgba(0, 0, 0, 0.4)",
          }}
        >
          Emergency Alarm
        </h1>

        <div
          style={{
            fontSize: "clamp(18px, 3.5vw, 22px)",
            fontWeight: 700,
            background: "rgba(0, 0, 0, 0.35)",
            padding: "8px 16px",
            borderRadius: 8,
            marginBottom: 16,
            display: "inline-block",
          }}
        >
          {alert.podName || "EcoVital Pod"}
        </div>

        <div
          style={{
            fontSize: "clamp(16px, 3vw, 19px)",
            fontWeight: 650,
            marginBottom: 12,
            color: "#ffffff",
          }}
        >
          {isSmoke ? "🔥 Smoke or Burning Likely" : "⚠️ Possible Gas or Hazardous Fumes"}
        </div>

        <div
          style={{
            background: "rgba(0, 0, 0, 0.4)",
            border: "1px solid rgba(254, 240, 138, 0.4)",
            borderRadius: 12,
            padding: "16px 20px",
            fontSize: "clamp(14px, 2.5vw, 15px)",
            lineHeight: 1.6,
            textAlign: "left",
            marginBottom: 24,
            boxShadow: "0 4px 12px rgba(0, 0, 0, 0.3)",
          }}
        >
          <div style={{ fontWeight: 700, color: "#FEF08A", marginBottom: 6 }}>Immediate Safety Actions:</div>
          <ol style={{ margin: 0, paddingLeft: 20 }}>
            <li><b>Evacuate</b> everyone from the affected room.</li>
            <li><b>Open windows and doors</b> to ventilate immediately.</li>
            <li><b>Extinguish</b> any open flame; do <b>NOT</b> flip light switches.</li>
            <li>Call emergency responders if you smell gas or observe smoke.</li>
          </ol>
        </div>

        {/* Action Buttons */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* 1-Tap Nigerian Emergency Line Dialer */}
          <a
            href="tel:112"
            onClick={handleCallEmergency}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              background: "#FBBF24",
              color: "#78350F",
              padding: "16px 20px",
              borderRadius: 12,
              fontSize: "clamp(17px, 3.5vw, 20px)",
              fontWeight: 800,
              textDecoration: "none",
              boxShadow: "0 4px 14px rgba(0, 0, 0, 0.35)",
              border: "none",
              cursor: "pointer",
              transition: "transform 0.1s ease",
            }}
          >
            <span>📞</span>
            <span>CALL EMERGENCY (112)</span>
          </a>
          <span style={{ fontSize: 12, color: "#FEF08A", marginTop: -6 }}>
            Nigeria National Toll-Free: Police · Fire Service · Ambulance
          </span>

          <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
            <button
              type="button"
              onClick={dismissAlert}
              style={{
                flex: 1,
                padding: "13px 16px",
                background: "#ffffff",
                color: "#B91C1C",
                border: "none",
                borderRadius: 10,
                fontSize: 15,
                fontWeight: 700,
                cursor: "pointer",
                boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
              }}
            >
              🔇 Silence Alarm
            </button>

            {alert.podId && (
              <Link
                href={`/node/${encodeURIComponent(alert.podId)}`}
                onClick={dismissAlert}
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "13px 16px",
                  background: "#1E293B",
                  color: "#ffffff",
                  textDecoration: "none",
                  borderRadius: 10,
                  fontSize: 15,
                  fontWeight: 650,
                  boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
                }}
              >
                📍 View Pod
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
