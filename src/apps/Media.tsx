"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AppProps } from "@/kernel/types";
import { abCycle, abNext, clampRate, keyAction, resumeAt, type AbLoop } from "@/lib/mediactl";
import { Empty } from "./_ui";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";

/** Media — local audio/video playback with a live frequency visualizer.
 *  Files are read from an object URL and never uploaded anywhere.
 *
 *  A drop of several files becomes a queue with next/previous; playback speed,
 *  an A-B loop, picture-in-picture and keyboard control ride on top; and each
 *  file resumes where it was left, keyed by name and size (a file cannot be
 *  identified any better without reading it). Loop and resume rules are in
 *  lib/mediactl.ts, where they are tested. */

interface QueueItem { file: File; url: string }

const RESUME_KEY = "webaios.media.resume.v1";
const fileKey = (f: File) => `${f.name}|${f.size}`;

function readResume(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(RESUME_KEY) || "{}") as Record<string, number>; } catch { return {}; }
}
function writeResume(key: string, t: number) {
  try {
    const all = readResume();
    all[key] = Math.round(t);
    // Most recent 200 only: a list that never shrinks is a quota problem later.
    const keys = Object.keys(all);
    if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete all[k];
    localStorage.setItem(RESUME_KEY, JSON.stringify(all));
  } catch { /* storage full or blocked: resume is a convenience */ }
}

const fmt = (t: number) => {
  if (!Number.isFinite(t)) return "-";
  const m = Math.floor(t / 60);
  return `${m}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
};

export default function Media({}: AppProps) {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [index, setIndex] = useState(0);
  const [rate, setRate] = useState(1);
  const [loop, setLoop] = useState<AbLoop>({ a: null, b: null });
  const [resumedFrom, setResumedFrom] = useState(0);
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef(0);
  const lastSaved = useRef(0);

  const current = queue[index] ?? null;
  const src = current?.url ?? null;
  const name = current?.file.name ?? "";
  const isVideo = current?.file.type.startsWith("video") ?? false;

  /** Each track gets a fresh <audio>/<video> (keyed by URL), and an analyser
   *  is bound to one element for life. Without this reset the visualizer
   *  stayed wired to the first track's dead element and went flat on track 2. */
  const resetAnalyser = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    void audioCtxRef.current?.close();
    audioCtxRef.current = null;
  }, []);

  const load = useCallback((files: File[]) => {
    const media = files.filter((f) => f.type.startsWith("audio") || f.type.startsWith("video"));
    if (!media.length) return;
    resetAnalyser();
    setQueue((q) => {
      for (const it of q) URL.revokeObjectURL(it.url);
      return media.map((file) => ({ file, url: URL.createObjectURL(file) }));
    });
    setIndex(0);
    setLoop({ a: null, b: null });
  }, [resetAnalyser]);

  useEffect(() => () => { for (const it of queue) URL.revokeObjectURL(it.url); }, [queue]);

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

  const go = useCallback((delta: number) => {
    if (!queue.length) return;
    resetAnalyser();
    setIndex((i) => (i + delta + queue.length) % queue.length);
    setLoop({ a: null, b: null });
  }, [queue.length, resetAnalyser]);

  const onLoaded = () => {
    const el = mediaRef.current;
    if (!el || !current) return;
    el.playbackRate = rate;
    const at = resumeAt(readResume()[fileKey(current.file)], el.duration);
    if (at > 0) el.currentTime = at;
    setResumedFrom(at);
  };

  const onTime = () => {
    const el = mediaRef.current;
    if (!el || !current) return;
    const jump = abNext(el.currentTime, loop);
    if (jump !== null) el.currentTime = jump;
    // Save every few seconds, not every tick: localStorage writes are synchronous.
    if (Math.abs(el.currentTime - lastSaved.current) >= 3) {
      lastSaved.current = el.currentTime;
      writeResume(fileKey(current.file), el.currentTime);
    }
  };

  const setSpeed = (r: number) => {
    const v = clampRate(r);
    setRate(v);
    if (mediaRef.current) mediaRef.current.playbackRate = v;
  };

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input,textarea,select")) return;
    const a = keyAction(e.key, e.shiftKey);
    const el = mediaRef.current;
    if (!a || !el) return;
    e.preventDefault();
    if (a.kind === "toggle") void (el.paused ? el.play() : el.pause());
    else if (a.kind === "seek") el.currentTime = Math.max(0, Math.min(el.duration || 0, el.currentTime + a.by));
    else if (a.kind === "mute") el.muted = !el.muted;
    else if (a.kind === "rate") setSpeed(rate + a.by);
    else if (a.kind === "next") go(1);
    else if (a.kind === "prev") go(-1);
    else if (a.kind === "ab") setLoop((l) => abCycle(el.currentTime, l));
  };

  const pip = async () => {
    const el = mediaRef.current;
    if (!(el instanceof HTMLVideoElement)) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await el.requestPictureInPicture();
    } catch { /* not supported, or blocked by the page's policy */ }
  };

  return (
    <div
      className="flex h-full flex-col outline-none"
      tabIndex={0}
      onKeyDown={onKey}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); load(Array.from(e.dataTransfer.files)); }}
      aria-label="Media player. Space plays, arrows seek, L sets an A-B loop, N and P change track."
    >
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5">
        <label className="os-btn !py-1 text-[11px]">
          Open files
          <input type="file" accept="audio/*,video/*" multiple hidden onChange={(e) => load(Array.from(e.target.files ?? []))} />
        </label>
        {queue.length > 1 && (
          <>
            <button className="os-btn !px-1.5 !py-1" onClick={() => go(-1)} aria-label="Previous track"><Icon name="chevronRight" size={12} style={{ transform: "rotate(180deg)" }} /></button>
            <button className="os-btn !px-1.5 !py-1" onClick={() => go(1)} aria-label="Next track"><Icon name="chevronRight" size={12} /></button>
          </>
        )}
        <span className="min-w-0 flex-1 truncate text-[12px]">
          {name || "Nothing loaded"}
          {queue.length > 1 && <span className="ml-1 text-[var(--muted)]">({index + 1} of {queue.length})</span>}
        </span>
        {src && (
          <>
            <select className="os-input !w-auto !py-0.5 text-[11px]" value={rate} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Playback speed">
              {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3].map((r) => <option key={r} value={r}>{r}x</option>)}
            </select>
            <button
              className={cn("os-btn !py-1 text-[11px]", loop.a !== null && "!border-[var(--accent)]")}
              onClick={() => { const el = mediaRef.current; if (el) setLoop((l) => abCycle(el.currentTime, l)); }}
              aria-label="Set A-B loop point"
              title="First press sets A, second sets B, third clears. Key: L"
            >
              {loop.a === null ? "A-B" : loop.b === null ? `A ${fmt(loop.a)}` : `${fmt(loop.a)}-${fmt(loop.b)}`}
            </button>
            {isVideo && <button className="os-btn !py-1 text-[11px]" onClick={() => void pip()} aria-label="Picture in picture">PiP</button>}
          </>
        )}
      </div>

      {!src ? (
        <Empty icon="media" title="No media loaded" body="Open audio or video files, or drag several into this window to play them as a queue. Files stay on your device — nothing is uploaded. Each file resumes where you left it." />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-2.5">
          {isVideo ? (
            <video key={src} ref={mediaRef as React.RefObject<HTMLVideoElement>} src={src} controls onPlay={attachAnalyser} onLoadedMetadata={onLoaded} onTimeUpdate={onTime} onEnded={() => queue.length > 1 && go(1)} className="min-h-0 flex-1 rounded-[var(--radius)] bg-black" />
          ) : (
            <>
              <canvas ref={canvasRef} className="min-h-0 flex-1 rounded-[var(--radius)]" style={{ background: "color-mix(in srgb, var(--bg) 60%, transparent)" }} />
              <audio key={src} ref={mediaRef as React.RefObject<HTMLAudioElement>} src={src} controls onPlay={attachAnalyser} onLoadedMetadata={onLoaded} onTimeUpdate={onTime} onEnded={() => queue.length > 1 && go(1)} className="w-full" />
            </>
          )}
          {resumedFrom > 0 && <div className="text-[11px] text-[var(--muted)]">Resumed at {fmt(resumedFrom)}.</div>}
          {queue.length > 1 && (
            <ol className="max-h-32 overflow-y-auto text-[11.5px]" aria-label="Queue">
              {queue.map((q, i) => (
                <li key={q.url}>
                  <button className={cn("w-full truncate rounded px-1.5 py-0.5 text-left", i === index ? "bg-[var(--accent)]/16" : "hover:bg-[var(--hover)]")} onClick={() => { if (i !== index) resetAnalyser(); setIndex(i); setLoop({ a: null, b: null }); }}>
                    {i + 1}. {q.file.name}
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
