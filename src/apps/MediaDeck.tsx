"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { AppProps } from "@/kernel/types";
import { uid } from "@/lib/format";
import { Empty } from "./_ui";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";
import { shuffleNext, moveItem, keyAction, clampRate } from "@/lib/mediactl";

/* ────────────────────────────────────────────────────────────────────────────
   Media Deck — ported from media-deck.html.

   Playlists ("decks") over local files, with shuffle, repeat and a visualizer.
   Files themselves are never stored — a browser cannot keep a file handle across
   reloads without the File System Access API, so a deck remembers names and
   order and asks you to re-attach the files. That is stated in the UI rather
   than silently presenting dead entries.
   ──────────────────────────────────────────────────────────────────────────── */

interface Track { id: string; name: string; type: string; size: number }
interface Deck { id: string; name: string; trackIds: string[]; shuffle?: boolean; repeat?: "off" | "one" | "all" }

interface DeckState {
  decks: Deck[];
  tracks: Track[];
  activeDeck: string | null;
  addDeck: (name: string) => string;
  removeDeck: (id: string) => void;
  setActive: (id: string) => void;
  addTracks: (deckId: string, tracks: Track[]) => void;
  removeTrack: (deckId: string, trackId: string) => void;
  /** Shuffle and repeat belong to the deck, so they survive a reload. */
  setDeckPrefs: (deckId: string, patch: Pick<Deck, "shuffle" | "repeat">) => void;
  moveTrack: (deckId: string, index: number, delta: number) => void;
}

const useDecks = create<DeckState>()(
  persist(
    (set) => ({
      decks: [], tracks: [], activeDeck: null,
      addDeck: (name) => {
        const id = uid("deck");
        set((s) => ({ decks: [...s.decks, { id, name, trackIds: [] }], activeDeck: id }));
        return id;
      },
      removeDeck: (id) => set((s) => ({ decks: s.decks.filter((d) => d.id !== id), activeDeck: s.activeDeck === id ? null : s.activeDeck })),
      setActive: (id) => set({ activeDeck: id }),
      addTracks: (deckId, tracks) =>
        set((s) => ({
          tracks: [...s.tracks, ...tracks.filter((t) => !s.tracks.some((x) => x.id === t.id))],
          decks: s.decks.map((d) => (d.id === deckId ? { ...d, trackIds: [...d.trackIds, ...tracks.map((t) => t.id)] } : d)),
        })),
      setDeckPrefs: (deckId, patch) => set((s) => ({ decks: s.decks.map((d) => (d.id === deckId ? { ...d, ...patch } : d)) })),
      moveTrack: (deckId, index, delta) => set((s) => ({ decks: s.decks.map((d) => (d.id === deckId ? { ...d, trackIds: moveItem(d.trackIds, index, delta) } : d)) })),
      removeTrack: (deckId, trackId) =>
        set((s) => ({ decks: s.decks.map((d) => (d.id === deckId ? { ...d, trackIds: d.trackIds.filter((t) => t !== trackId) } : d)) })),
    }),
    { name: "webaios.mediadeck.v1", storage: createJSONStorage(() => localStorage) },
  ),
);

export default function MediaDeck({}: AppProps) {
  const store = useDecks();
  // Object URLs live only for this session — they are not persistable.
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [playing, setPlaying] = useState<string | null>(null);
  const [played, setPlayed] = useState<string[]>([]);
  const [rate, setRate] = useState(1);
  const [progress, setProgress] = useState(0);
  const mediaRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef(0);

  const deck = store.decks.find((d) => d.id === store.activeDeck) ?? null;
  const deckTracks = useMemo(
    () => (deck ? (deck.trackIds.map((id) => store.tracks.find((t) => t.id === id)).filter(Boolean) as Track[]) : []),
    [deck, store.tracks],
  );
  const current = playing ? store.tracks.find((t) => t.id === playing) : null;
  const shuffle = deck?.shuffle ?? false;
  const repeat = deck?.repeat ?? "off";

  useEffect(() => () => { Object.values(urls).forEach(URL.revokeObjectURL); }, [urls]);

  const attach = useCallback((files: FileList | null) => {
    if (!files?.length || !deck) return;
    const added: Track[] = [];
    const nextUrls: Record<string, string> = {};
    for (const f of Array.from(files)) {
      // Identity is name+size, so re-attaching the same file after a reload
      // matches the remembered entry rather than duplicating it.
      const id = `tr_${f.name}_${f.size}`.replace(/\W/g, "_");
      nextUrls[id] = URL.createObjectURL(f);
      if (!store.tracks.some((t) => t.id === id)) added.push({ id, name: f.name, type: f.type, size: f.size });
    }
    setUrls((u) => ({ ...u, ...nextUrls }));
    if (added.length) store.addTracks(deck.id, added);
  }, [deck, store]);

  const play = useCallback((id: string) => {
    if (!urls[id]) return;
    setPlaying(id);
    // A timeout, not requestAnimationFrame: rAF never fires in a hidden tab,
    // so the next track in a background tab would never start.
    setTimeout(() => { const el = mediaRef.current; if (el) { el.playbackRate = rate; el.play().catch(() => undefined); } }, 0);
  }, [urls, rate]);

  const next = useCallback(() => {
    const available = deckTracks.filter((t) => urls[t.id]);
    if (!available.length) return;
    if (repeat === "one" && playing) return play(playing);
    if (shuffle) {
      // A bag, not a dice roll: every track once before any repeats, and never
      // the same track twice in a row (lib/mediactl.ts, tested).
      const pick = shuffleNext(available.map((t) => t.id), played, playing, Math.random(), repeat === "all");
      if (!pick) { setPlaying(null); setPlayed([]); return; }
      setPlayed(pick.played);
      return play(pick.id);
    }
    const i = available.findIndex((t) => t.id === playing);
    const n = i + 1;
    if (n >= available.length) { if (repeat === "all") play(available[0].id); else setPlaying(null); return; }
    play(available[n].id);
  }, [deckTracks, urls, playing, shuffle, repeat, play, played]);

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input,textarea,select")) return;
    const a = keyAction(e.key, e.shiftKey);
    const el = mediaRef.current;
    if (!a || !el) return;
    e.preventDefault();
    if (a.kind === "toggle") void (el.paused ? el.play() : el.pause());
    else if (a.kind === "seek") el.currentTime = Math.max(0, Math.min(el.duration || 0, el.currentTime + a.by));
    else if (a.kind === "mute") el.muted = !el.muted;
    else if (a.kind === "rate") { const v = clampRate(rate + a.by); setRate(v); el.playbackRate = v; }
    else if (a.kind === "next") next();
  };

  const attachAnalyser = useCallback(() => {
    const el = mediaRef.current;
    const canvas = canvasRef.current;
    if (!el || !canvas || ctxRef.current) return;
    try {
      const ac = new AudioContext();
      ctxRef.current = ac;
      const analyser = ac.createAnalyser();
      analyser.fftSize = 512;
      ac.createMediaElementSource(el).connect(analyser);
      analyser.connect(ac.destination);
      const bins = new Uint8Array(analyser.frequencyBinCount);
      const g = canvas.getContext("2d");
      if (!g) return;
      const draw = () => {
        rafRef.current = requestAnimationFrame(draw);
        const w = canvas.width = canvas.clientWidth;
        const h = canvas.height = canvas.clientHeight;
        analyser.getByteFrequencyData(bins);
        g.clearRect(0, 0, w, h);
        const css = getComputedStyle(document.documentElement);
        const a1 = css.getPropertyValue("--accent").trim() || "#67e8f9";
        const a2 = css.getPropertyValue("--accent2").trim() || "#8b5cf6";
        const bars = 64;
        const bw = w / bars;
        for (let i = 0; i < bars; i++) {
          const v = bins[Math.floor((i / bars) * bins.length)] / 255;
          const bh = v * h * 0.85;
          const grad = g.createLinearGradient(0, h, 0, h - bh);
          grad.addColorStop(0, a2);
          grad.addColorStop(1, a1);
          g.fillStyle = grad;
          g.fillRect(i * bw + 1, h - bh, bw - 2, bh);
        }
      };
      draw();
    } catch { /* analyser unavailable; playback still works */ }
  }, []);

  useEffect(() => () => { cancelAnimationFrame(rafRef.current); ctxRef.current?.close(); }, []);

  const missing = deckTracks.filter((t) => !urls[t.id]).length;
  const isVideo = current?.type.startsWith("video");

  return (
    <div className="app-split flex h-full outline-none" tabIndex={0} onKeyDown={onKey} aria-label="Media Deck. Space plays, arrows seek, N skips, less-than and greater-than change speed." onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); attach(e.dataTransfer.files); }}>
      <div className="app-sidebar flex w-48 shrink-0 flex-col overflow-y-auto border-r border-[var(--border)]">
        <div className="p-2">
          <button
            className="os-btn w-full !py-1 text-[11px]"
            onClick={() => { const n = prompt("Deck name", `Deck ${store.decks.length + 1}`); if (n) store.addDeck(n); }}
          >
            + New deck
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {store.decks.map((d) => (
            <div
              key={d.id}
              onClick={() => store.setActive(d.id)}
              className={cn("group mb-1 flex cursor-pointer items-center gap-1 rounded px-2 py-1.5",
                d.id === store.activeDeck ? "bg-[var(--accent)]/16" : "hover:bg-white/6")}
            >
              <span className="min-w-0 flex-1 truncate text-[12px]">{d.name}</span>
              <span className="text-[10px] text-[var(--muted)]">{d.trackIds.length}</span>
              <button className="text-[10px] opacity-0 group-hover:opacity-60 hover:!opacity-100" onClick={(e) => { e.stopPropagation(); store.removeDeck(d.id); }}><Icon name="close" size={11} /></button>
            </div>
          ))}
          {store.decks.length === 0 && <div className="px-2 py-6 text-center text-[11px] text-[var(--muted)]">No decks</div>}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {!deck ? (
          <Empty icon="mediadeck" title="No deck selected" body="Create a deck, then attach local audio or video files. Nothing is uploaded — files are read straight from your device." />
        ) : (
          <>
            <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5">
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{deck.name}</span>
              <label className="os-btn !py-1 text-[11px]">
                Attach files
                <input type="file" accept="audio/*,video/*" multiple hidden onChange={(e) => { attach(e.target.files); e.target.value = ""; }} />
              </label>
              <button className={cn("os-btn !py-1 text-[11px]", shuffle && "!border-[var(--accent)] !bg-[var(--accent)]/16")} aria-pressed={shuffle} onClick={() => { store.setDeckPrefs(deck.id, { shuffle: !shuffle }); setPlayed([]); }}>⤨ Shuffle</button>
              <select className="os-input !w-auto !py-0.5 text-[11px]" value={rate} aria-label="Playback speed" onChange={(e) => { const v = clampRate(Number(e.target.value)); setRate(v); if (mediaRef.current) mediaRef.current.playbackRate = v; }}>
                {[0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => <option key={r} value={r}>{r}x</option>)}
              </select>
              <button
                className={cn("os-btn !py-1 text-[11px]", repeat !== "off" && "!border-[var(--accent)] !bg-[var(--accent)]/16")}
                aria-label={`Repeat: ${repeat}`}
                onClick={() => store.setDeckPrefs(deck.id, { repeat: repeat === "off" ? "all" : repeat === "all" ? "one" : "off" })}
              >
                ⟳ {repeat}
              </button>
            </div>

            {missing > 0 && (
              <div className="shrink-0 border-b border-[var(--border)] px-2.5 py-1.5 text-[11px]" style={{ color: "var(--warn)" }}>
                {missing} track{missing === 1 ? "" : "s"} remembered but not attached. Browsers cannot hold on to files across reloads — attach them again to play.
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {deckTracks.length === 0 ? (
                <Empty icon="media" title="Empty deck" body="Attach audio or video files, or drag them into this window." />
              ) : (
                deckTracks.map((t, idx) => {
                  const ready = Boolean(urls[t.id]);
                  return (
                    <div
                      key={t.id}
                      onDoubleClick={() => ready && play(t.id)}
                      className={cn("group mb-0.5 flex items-center gap-2 rounded px-2 py-1.5",
                        playing === t.id ? "bg-[var(--accent)]/16" : ready ? "hover:bg-white/6" : "opacity-45")}
                    >
                      <button onClick={() => ready && play(t.id)} disabled={!ready} className="text-[11px]">
                        {playing === t.id ? "▮▮" : "▶"}
                      </button>
                      <span className="min-w-0 flex-1 truncate text-[12px]">{t.name}</span>
                      {!ready && <span className="shrink-0 text-[10px]">not attached</span>}
                      <span className="shrink-0 text-[10px] text-[var(--muted)]">{(t.size / 1048576).toFixed(1)} MB</span>
                      {/* Visible at rest, not only on hover: a phone has no hover, and these were unreachable there. */}
                      <button className="shrink-0 text-[10px] opacity-50 hover:!opacity-100 disabled:opacity-20" disabled={idx === 0} onClick={() => store.moveTrack(deck.id, idx, -1)} aria-label={`Move ${t.name} up`}><Icon name="arrowUp" size={11} /></button>
                      <button className="shrink-0 text-[10px] opacity-50 hover:!opacity-100 disabled:opacity-20" disabled={idx === deckTracks.length - 1} onClick={() => store.moveTrack(deck.id, idx, 1)} aria-label={`Move ${t.name} down`}><Icon name="arrowDown" size={11} /></button>
                      <button className="shrink-0 text-[10px] opacity-50 hover:!opacity-100" onClick={() => store.removeTrack(deck.id, t.id)} aria-label={`Remove ${t.name} from the deck`}><Icon name="close" size={11} /></button>
                    </div>
                  );
                })
              )}
            </div>

            {current && urls[current.id] && (
              <div className="shrink-0 border-t border-[var(--border)] p-2.5">
                <div className="mb-2 h-24">
                  {isVideo ? (
                    <video
                      ref={mediaRef} src={urls[current.id]} controls autoPlay
                      onPlay={attachAnalyser} onEnded={next}
                      onTimeUpdate={(e) => setProgress(e.currentTarget.currentTime / (e.currentTarget.duration || 1))}
                      className="h-full w-full rounded-[calc(var(--radius)*0.6)] bg-black"
                    />
                  ) : (
                    <>
                      <canvas ref={canvasRef} className="h-full w-full rounded-[calc(var(--radius)*0.6)]" style={{ background: "color-mix(in srgb, var(--bg) 55%, transparent)" }} />
                      <video
                        ref={mediaRef} src={urls[current.id]} autoPlay hidden
                        onPlay={attachAnalyser} onEnded={next}
                        onTimeUpdate={(e) => setProgress(e.currentTarget.currentTime / (e.currentTarget.duration || 1))}
                      />
                    </>
                  )}
                </div>
                <div className="mb-1.5 h-1 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full" style={{ width: `${progress * 100}%`, background: "var(--accent)" }} />
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-[12px]">{current.name}</span>
                  <button className="os-btn !py-1 text-[11px]" onClick={() => mediaRef.current?.paused ? mediaRef.current.play() : mediaRef.current?.pause()}>Play / Pause</button>
                  <button className="os-btn !py-1 text-[11px]" onClick={next}>Next ⏭</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
