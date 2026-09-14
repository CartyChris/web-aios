"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AppProps } from "@/kernel/types";
import { Empty } from "./_ui";

/** Media — local audio/video playback with a live frequency visualizer.
 *  Files are read from an object URL and never uploaded anywhere. */
export default function Media({}: AppProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [isVideo, setIsVideo] = useState(false);
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef(0);

  const load = useCallback((file: File) => {
    if (src) URL.revokeObjectURL(src);
    setSrc(URL.createObjectURL(file));
    setName(file.name);
    setIsVideo(file.type.startsWith("video"));
  }, [src]);

  useEffect(() => () => { if (src) URL.revokeObjectURL(src); }, [src]);

  // The analyser is attached once per element. Calling createMediaElementSource
  // twice on the same node throws, which is the classic way this feature breaks.
  const attachAnalyser = useCallback(() => {
    const el = mediaRef.current;
    const canvas = canvasRef.current;
    if (!el || !canvas || audioCtxRef.current) return;
    try {
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaElementSource(el);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyser.connect(ctx.destination);
      const bins = new Uint8Array(analyser.frequencyBinCount);
      const g = canvas.getContext("2d");
      if (!g) return;

      const draw = () => {
        rafRef.current = requestAnimationFrame(draw);
        const w = canvas.width = canvas.clientWidth;
        const h = canvas.height = canvas.clientHeight;
        analyser.getByteFrequencyData(bins);
        g.clearRect(0, 0, w, h);
        const bw = w / bins.length;
        const css = getComputedStyle(document.documentElement);
        const a1 = css.getPropertyValue("--accent").trim() || "#67e8f9";
        const a2 = css.getPropertyValue("--accent2").trim() || "#8b5cf6";
        for (let i = 0; i < bins.length; i++) {
          const bh = (bins[i] / 255) * h;
          const grad = g.createLinearGradient(0, h, 0, h - bh);
          grad.addColorStop(0, a2);
          grad.addColorStop(1, a1);
          g.fillStyle = grad;
          g.fillRect(i * bw, h - bh, Math.max(1, bw - 1), bh);
        }
      };
      draw();
    } catch (e) {
      console.warn("[media] analyser unavailable:", e);
    }
  }, []);

  useEffect(() => () => { cancelAnimationFrame(rafRef.current); audioCtxRef.current?.close(); }, []);

  return (
    <div
      className="flex h-full flex-col"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) load(f); }}
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5">
        <label className="os-btn !py-1 text-[11px]">
          Open file
          <input type="file" accept="audio/*,video/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) load(f); }} />
        </label>
        <span className="min-w-0 flex-1 truncate text-[12px]">{name || "Nothing loaded"}</span>
      </div>

      {!src ? (
        <Empty icon="media" title="No media loaded" body="Open an audio or video file, or drag one into this window. Files stay on your device — nothing is uploaded." />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-2.5">
          {isVideo ? (
            <video ref={mediaRef as React.RefObject<HTMLVideoElement>} src={src} controls onPlay={attachAnalyser} className="min-h-0 flex-1 rounded-[var(--radius)] bg-black" />
          ) : (
            <>
              <canvas ref={canvasRef} className="min-h-0 flex-1 rounded-[var(--radius)]" style={{ background: "color-mix(in srgb, var(--bg) 60%, transparent)" }} />
              <audio ref={mediaRef as React.RefObject<HTMLAudioElement>} src={src} controls onPlay={attachAnalyser} className="w-full" />
            </>
          )}
        </div>
      )}
    </div>
  );
}
