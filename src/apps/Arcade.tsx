"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { AppProps } from "@/kernel/types";
import { useSettings } from "@/kernel/settings";
import { bus } from "@/kernel/bus";
import { EGGS, useEggs } from "@/lib/easter";
import { Tabs, Empty } from "./_ui";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";

/* ────────────────────────────────────────────────────────────────────────────
   Arcade.

   Four games that are actually finished rather than four demos, and the place
   the OS keeps its secrets. Every one is canvas or DOM with no dependency, and
   every one works with a finger as well as a keyboard — this OS runs on a
   phone, and a game you cannot play there is half a game.

   The scoreboard is shared so a high score survives a reload, and the games
   read theme tokens rather than hard-coded colours, so the arcade repaints
   with the rest of the desktop.
   ──────────────────────────────────────────────────────────────────────────── */

interface ScoreState {
  best: Record<string, number>;
  submit: (game: string, score: number) => boolean;
}

const useScores = create<ScoreState>()(
  persist(
    (set, get) => ({
      best: {},
      /** True when it is a new record, so the caller can say so. */
      submit: (game, score) => {
        if (score <= (get().best[game] ?? 0)) return false;
        set((s) => ({ best: { ...s.best, [game]: score } }));
        return true;
      },
    }),
    { name: "webaios.arcade.v1", storage: createJSONStorage(() => localStorage) },
  ),
);

const GAMES = [
  { id: "snake", name: "Snake", icon: "loop", blurb: "Arrow keys or swipe. It gets faster." },
  { id: "breakout", name: "Breakout", icon: "grid", blurb: "Drag or use the arrows. Three lives." },
  { id: "tiles", name: "2048", icon: "layers", blurb: "Slide to merge. Reach 2048." },
  { id: "mines", name: "Minesweeper", icon: "warning", blurb: "Click to clear, right-click to flag." },
] as const;

export default function Arcade({ args }: AppProps) {
  const [tab, setTab] = useState<string>((args?.game as string) ?? "snake");
  const scores = useScores();

  return (
    <div className="flex h-full flex-col">
      <Tabs
        tabs={[...GAMES.map((g) => ({ id: g.id, label: g.name, icon: g.icon })), { id: "secrets", label: "Secrets", icon: "trophy" }]}
        active={tab}
        onChange={setTab}
      />
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === "snake" && <Snake onScore={(n) => scores.submit("snake", n)} best={scores.best.snake ?? 0} />}
        {tab === "breakout" && <Breakout onScore={(n) => scores.submit("breakout", n)} best={scores.best.breakout ?? 0} />}
        {tab === "tiles" && <Tiles onScore={(n) => scores.submit("tiles", n)} best={scores.best.tiles ?? 0} />}
        {tab === "mines" && <Mines onScore={(n) => scores.submit("mines", n)} best={scores.best.mines ?? 0} />}
        {tab === "secrets" && <Secrets />}
      </div>
    </div>
  );
}

/* ── Shared chrome ────────────────────────────────────────────────────────── */

function Board({ title, score, best, status, onRestart, children, footer }: {
  title: string; score: number; best: number; status?: string;
  onRestart: () => void; children: React.ReactNode; footer?: string;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5">
        <span className="text-[12.5px] font-medium">{title}</span>
        <span className="os-chip tabular-nums">score {score}</span>
        <span className="os-chip tabular-nums">best {best}</span>
        {status && <span className="os-chip !border-[var(--accent)] !text-[var(--accent)]">{status}</span>}
        <div className="flex-1" />
        <button className="os-btn !py-1 text-[11px]" onClick={onRestart}>
          <Icon name="refresh" size={11} className="mr-1" />New game
        </button>
      </div>
      <div className="grid min-h-0 flex-1 place-items-center overflow-hidden p-2">{children}</div>
      {footer && <div className="shrink-0 border-t border-[var(--border)] px-2.5 py-1 text-[10.5px] text-[var(--muted)]">{footer}</div>}
    </div>
  );
}

/** Read a live theme token, so a game repaints with the OS instead of being
 *  the one surface that ignores the palette. */
function token(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** Swipe detection shared by the two grid games — this OS runs on phones, and
 *  arrow keys are not available there. */
function useSwipe(el: React.RefObject<HTMLElement | null>, onSwipe: (dir: "up" | "down" | "left" | "right") => void) {
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    let sx = 0, sy = 0, active = false;
    const down = (e: PointerEvent) => { sx = e.clientX; sy = e.clientY; active = true; };
    const up = (e: PointerEvent) => {
      if (!active) return;
      active = false;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) < 24 && Math.abs(dy) < 24) return;
      onSwipe(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up");
    };
    node.addEventListener("pointerdown", down);
    node.addEventListener("pointerup", up);
    return () => { node.removeEventListener("pointerdown", down); node.removeEventListener("pointerup", up); };
  }, [el, onSwipe]);
}

/* ── Snake ────────────────────────────────────────────────────────────────── */

function Snake({ onScore, best }: { onScore: (n: number) => boolean; best: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [score, setScore] = useState(0);
  const [dead, setDead] = useState(false);
  const [gen, setGen] = useState(0);
  const dirRef = useRef<[number, number]>([1, 0]);
  const queued = useRef<Array<[number, number]>>([]);

  const turn = useCallback((d: [number, number]) => {
    const last = queued.current[queued.current.length - 1] ?? dirRef.current;
    // Refuse a straight reversal — otherwise one stray keypress is instant death.
    if (last[0] === -d[0] && last[1] === -d[1]) return;
    if (queued.current.length < 2) queued.current.push(d);
  }, []);

  useSwipe(wrapRef, (dir) => turn(dir === "up" ? [0, -1] : dir === "down" ? [0, 1] : dir === "left" ? [-1, 0] : [1, 0]));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const map: Record<string, [number, number]> = {
        ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
        w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0],
      };
      const d = map[e.key];
      if (d) { e.preventDefault(); turn(d); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [turn]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const g = canvas.getContext("2d");
    if (!g) return;

    const N = 20;
    const snake: Array<[number, number]> = [[8, 10], [7, 10], [6, 10]];
    let food: [number, number] = [14, 10];
    let alive = true;
    let points = 0;
    let acc = 0, last = performance.now(), raf = 0;

    dirRef.current = [1, 0];
    queued.current = [];

    const accent = token("--accent", "#67e8f9");
    const accent2 = token("--accent2", "#8b5cf6");
    const border = "rgba(255,255,255,0.07)";

    const place = () => {
      // Never drop food under the snake — on a long snake that can look like
      // the food simply failed to appear.
      const free: Array<[number, number]> = [];
      for (let x = 0; x < N; x++) for (let y = 0; y < N; y++) {
        if (!snake.some(([sx, sy]) => sx === x && sy === y)) free.push([x, y]);
      }
      food = free[Math.floor(Math.random() * free.length)] ?? [0, 0];
    };

    const step = () => {
      const next = queued.current.shift();
      if (next) dirRef.current = next;
      const [dx, dy] = dirRef.current;
      const head: [number, number] = [snake[0][0] + dx, snake[0][1] + dy];
      if (head[0] < 0 || head[1] < 0 || head[0] >= N || head[1] >= N || snake.some(([x, y]) => x === head[0] && y === head[1])) {
        alive = false;
        setDead(true);
        onScore(points);
        return;
      }
      snake.unshift(head);
      if (head[0] === food[0] && head[1] === food[1]) { points += 10; setScore(points); place(); }
      else snake.pop();
    };

    const draw = (now: number) => {
      const size = Math.min(canvas.clientWidth, canvas.clientHeight);
      canvas.width = canvas.height = size;
      const cell = size / N;

      // Speed ramps with length, which is the entire difficulty curve.
      const interval = Math.max(70, 165 - snake.length * 3);
      acc += now - last;
      last = now;
      if (alive && acc > interval) { acc = 0; step(); }

      g.fillStyle = token("--bg2", "#132845");
      g.fillRect(0, 0, size, size);
      g.strokeStyle = border;
      g.lineWidth = 1;
      for (let i = 1; i < N; i++) {
        g.beginPath(); g.moveTo(i * cell, 0); g.lineTo(i * cell, size);
        g.moveTo(0, i * cell); g.lineTo(size, i * cell); g.stroke();
      }

      g.fillStyle = accent2;
      g.beginPath();
      g.arc((food[0] + 0.5) * cell, (food[1] + 0.5) * cell, cell * 0.33, 0, Math.PI * 2);
      g.fill();

      snake.forEach(([x, y], i) => {
        g.fillStyle = i === 0 ? accent : accent;
        g.globalAlpha = i === 0 ? 1 : Math.max(0.35, 1 - i / (snake.length + 6));
        const pad = cell * 0.09;
        g.beginPath();
        g.roundRect(x * cell + pad, y * cell + pad, cell - pad * 2, cell - pad * 2, cell * 0.24);
        g.fill();
      });
      g.globalAlpha = 1;

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [gen, onScore]);

  return (
    <Board
      title="Snake"
      score={score}
      best={best}
      status={dead ? "game over" : undefined}
      onRestart={() => { setScore(0); setDead(false); setGen((g) => g + 1); }}
      footer="Arrow keys, WASD, or swipe. The snake speeds up as it grows."
    >
      <div ref={wrapRef} className="grid h-full w-full place-items-center touch-none">
        <canvas ref={canvasRef} className="max-h-full max-w-full rounded-[calc(var(--radius)*0.6)] border border-[var(--border)]" style={{ aspectRatio: "1", height: "100%" }} />
      </div>
    </Board>
  );
}

/* ── Breakout ─────────────────────────────────────────────────────────────── */

function Breakout({ onScore, best }: { onScore: (n: number) => boolean; best: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(3);
  const [status, setStatus] = useState<string | undefined>();
  const [gen, setGen] = useState(0);
  const paddleX = useRef(0.5);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const g = canvas.getContext("2d");
    if (!g) return;

    const COLS = 9, ROWS = 5;
    const bricks = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => 1));
    // Normalised coordinates throughout: the board then scales to any window
    // without a single magic pixel value.
    let ball = { x: 0.5, y: 0.7, vx: 0.4, vy: -0.55 };
    let points = 0, left = 3, running = true;
    let last = performance.now(), raf = 0;

    const reset = () => { ball = { x: paddleX.current, y: 0.7, vx: (Math.random() - 0.5) * 0.6, vy: -0.6 }; };

    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      paddleX.current = Math.max(0.08, Math.min(0.92, (e.clientX - r.left) / r.width));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") paddleX.current = Math.max(0.08, paddleX.current - 0.06);
      if (e.key === "ArrowRight") paddleX.current = Math.min(0.92, paddleX.current + 0.06);
    };
    canvas.addEventListener("pointermove", onMove);
    window.addEventListener("keydown", onKey);

    const draw = (now: number) => {
      const dt = Math.min(0.033, (now - last) / 1000);
      last = now;
      const w = canvas.width = canvas.clientWidth;
      const h = canvas.height = canvas.clientHeight;
      const accent = token("--accent", "#67e8f9");
      const accent2 = token("--accent2", "#8b5cf6");

      if (running) {
        ball.x += ball.vx * dt;
        ball.y += ball.vy * dt;
        if (ball.x < 0.015 || ball.x > 0.985) { ball.vx *= -1; ball.x = Math.max(0.015, Math.min(0.985, ball.x)); }
        if (ball.y < 0.015) { ball.vy *= -1; ball.y = 0.015; }

        // Paddle: the contact point steers the bounce, which is the only thing
        // that makes the game a game rather than a coin flip.
        if (ball.y > 0.93 && ball.y < 0.965 && Math.abs(ball.x - paddleX.current) < 0.085 && ball.vy > 0) {
          const offset = (ball.x - paddleX.current) / 0.085;
          ball.vy = -Math.abs(ball.vy) * 1.015;
          ball.vx = offset * 0.72;
        }

        if (ball.y > 1.02) {
          left -= 1; setLives(left);
          if (left <= 0) { running = false; setStatus("game over"); onScore(points); }
          else reset();
        }

        const bw = 1 / COLS, bh = 0.055;
        const col = Math.floor(ball.x / bw);
        const row = Math.floor((ball.y - 0.08) / bh);
        if (row >= 0 && row < ROWS && col >= 0 && col < COLS && bricks[row][col]) {
          bricks[row][col] = 0;
          ball.vy *= -1;
          points += (ROWS - row) * 10;
          setScore(points);
          if (bricks.every((r) => r.every((b) => !b))) { running = false; setStatus("cleared"); onScore(points); }
        }
      }

      g.fillStyle = token("--bg2", "#132845");
      g.fillRect(0, 0, w, h);

      bricks.forEach((r, ri) => r.forEach((b, ci) => {
        if (!b) return;
        g.fillStyle = ri % 2 ? accent : accent2;
        g.globalAlpha = 0.92 - ri * 0.1;
        const pad = w * 0.004;
        g.beginPath();
        g.roundRect(ci * (w / COLS) + pad, (0.08 + ri * 0.055) * h + pad, w / COLS - pad * 2, 0.055 * h - pad * 2, 3);
        g.fill();
      }));
      g.globalAlpha = 1;

      g.fillStyle = accent;
      g.beginPath();
      g.roundRect((paddleX.current - 0.085) * w, 0.955 * h, 0.17 * w, 0.018 * h, 4);
      g.fill();

      g.beginPath();
      g.arc(ball.x * w, ball.y * h, Math.max(3, w * 0.011), 0, Math.PI * 2);
      g.fillStyle = "#fff";
      g.fill();

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointermove", onMove);
      window.removeEventListener("keydown", onKey);
    };
  }, [gen, onScore]);

  return (
    <Board
      title="Breakout"
      score={score}
      best={best}
      status={status ?? `${lives} lives`}
      onRestart={() => { setScore(0); setLives(3); setStatus(undefined); setGen((g) => g + 1); }}
      footer="Move the pointer, or use the arrow keys. Where the ball hits the paddle decides where it goes."
    >
      <canvas ref={canvasRef} className="h-full w-full max-w-[640px] touch-none rounded-[calc(var(--radius)*0.6)] border border-[var(--border)]" />
    </Board>
  );
}

/* ── 2048 ─────────────────────────────────────────────────────────────────── */

type Grid = number[][];
const emptyGrid = (): Grid => Array.from({ length: 4 }, () => [0, 0, 0, 0]);

function addTile(g: Grid): Grid {
  const free: Array<[number, number]> = [];
  g.forEach((row, y) => row.forEach((v, x) => { if (!v) free.push([x, y]); }));
  if (!free.length) return g;
  const [x, y] = free[Math.floor(Math.random() * free.length)];
  const next = g.map((r) => [...r]);
  next[y][x] = Math.random() < 0.9 ? 2 : 4;
  return next;
}

/** Slide and merge one row leftwards. Every direction is this function with
 *  the grid rotated into place, which is the whole trick to 2048. */
function slide(row: number[]): { row: number[]; gained: number } {
  const vals = row.filter(Boolean);
  const out: number[] = [];
  let gained = 0;
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] === vals[i + 1]) { out.push(vals[i] * 2); gained += vals[i] * 2; i++; }
    else out.push(vals[i]);
  }
  while (out.length < 4) out.push(0);
  return { row: out, gained };
}

const rotate = (g: Grid): Grid => g[0].map((_, i) => g.map((r) => r[i]).reverse());
const rotateN = (g: Grid, n: number): Grid => { let out = g; for (let i = 0; i < n; i++) out = rotate(out); return out; };

function move(g: Grid, dir: "left" | "up" | "right" | "down"): { grid: Grid; gained: number; moved: boolean } {
  const turns = { left: 0, up: 3, right: 2, down: 1 }[dir];
  let work = rotateN(g, turns);
  let gained = 0;
  work = work.map((r) => { const s = slide(r); gained += s.gained; return s.row; });
  const grid = rotateN(work, (4 - turns) % 4);
  return { grid, gained, moved: JSON.stringify(grid) !== JSON.stringify(g) };
}

const TILE_TINT: Record<number, number> = { 2: 8, 4: 16, 8: 26, 16: 36, 32: 48, 64: 60, 128: 70, 256: 80, 512: 88, 1024: 94, 2048: 100 };

function Tiles({ onScore, best }: { onScore: (n: number) => boolean; best: number }) {
  const [grid, setGrid] = useState<Grid>(() => addTile(addTile(emptyGrid())));
  const [score, setScore] = useState(0);
  const [status, setStatus] = useState<string | undefined>();
  const wrapRef = useRef<HTMLDivElement>(null);
  const eggs = useEggs();

  // The whole move is computed before any state is written. A state updater
  // has to be pure: calling setScore (and through it the scoreboard store)
  // from inside setGrid's updater updates one component while another is
  // rendering, which React warns about and which double-counts in StrictMode.
  const push = useCallback((dir: "left" | "up" | "right" | "down") => {
    const res = move(grid, dir);
    if (!res.moved) return;
    const next = addTile(res.grid);
    const total = score + res.gained;
    const won = next.some((r) => r.includes(2048));
    const stuck = (["left", "up", "right", "down"] as const).every((d) => !move(next, d).moved);

    setGrid(next);
    setScore(total);
    setStatus(stuck ? "no moves left" : won ? "2048!" : undefined);
    onScore(total);
    if (won && eggs.find("arcade")) {
      bus.emit("notify", { title: "2048", body: "Secret found: High roller.", kind: "success" });
    }
  }, [grid, score, onScore, eggs]);

  useSwipe(wrapRef, push);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const map: Record<string, "left" | "up" | "right" | "down"> = {
        ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
        a: "left", d: "right", w: "up", s: "down",
      };
      const d = map[e.key];
      if (d) { e.preventDefault(); push(d); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [push]);

  return (
    <Board
      title="2048"
      score={score}
      best={best}
      status={status}
      onRestart={() => { setGrid(addTile(addTile(emptyGrid()))); setScore(0); setStatus(undefined); }}
      footer="Arrow keys, WASD, or swipe. Equal tiles merge; the board fills whether you merge or not."
    >
      <div ref={wrapRef} className="grid aspect-square h-full max-h-full w-full max-w-[460px] touch-none grid-cols-4 gap-1.5 rounded-[calc(var(--radius)*0.7)] border border-[var(--border)] bg-black/20 p-1.5">
        {grid.flatMap((row, y) => row.map((v, x) => (
          <div
            key={`${x}-${y}`}
            className="grid place-items-center rounded-[calc(var(--radius)*0.5)] tabular-nums transition-colors"
            style={{
              background: v ? `color-mix(in srgb, var(--accent) ${TILE_TINT[v] ?? 100}%, var(--panel-solid))` : "color-mix(in srgb, var(--muted) 10%, transparent)",
              color: v >= 64 ? "#08121f" : "var(--text)",
              fontSize: v >= 1024 ? "clamp(12px, 3.4cqw, 22px)" : "clamp(14px, 4.4cqw, 30px)",
              fontWeight: 600,
            }}
          >
            {v || ""}
          </div>
        )))}
      </div>
    </Board>
  );
}

/* ── Minesweeper ──────────────────────────────────────────────────────────── */

interface Cell { mine: boolean; open: boolean; flag: boolean; n: number }

function buildMines(w: number, h: number, mines: number): Cell[][] {
  const grid: Cell[][] = Array.from({ length: h }, () => Array.from({ length: w }, () => ({ mine: false, open: false, flag: false, n: 0 })));
  let placed = 0;
  while (placed < mines) {
    const x = Math.floor(Math.random() * w), y = Math.floor(Math.random() * h);
    if (grid[y][x].mine) continue;
    grid[y][x].mine = true;
    placed++;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (grid[y][x].mine) continue;
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const ny = y + dy, nx = x + dx;
      if (ny >= 0 && nx >= 0 && ny < h && nx < w && grid[ny][nx].mine) n++;
    }
    grid[y][x].n = n;
  }
  return grid;
}

const NUM_COLOR = ["", "#60a5fa", "#4ade80", "#fb7185", "#a78bfa", "#fbbf24", "#22d3ee", "#f472b6", "#94a3b8"];

function Mines({ onScore, best }: { onScore: (n: number) => boolean; best: number }) {
  const W = 12, H = 12, MINES = 20;
  const [grid, setGrid] = useState(() => buildMines(W, H, MINES));
  const [status, setStatus] = useState<string | undefined>();
  const [started, setStarted] = useState<number | null>(null);
  const [score, setScore] = useState(0);

  const open = useCallback((x: number, y: number) => {
    if (status) return;
    if (grid[y][x].flag || grid[y][x].open) return;
    const startedAt = started ?? Date.now();
    if (started === null) setStarted(startedAt);

    // Computed first, committed after — see the note in 2048. Reveals here
    // also have to set a status and a score, and doing that from inside the
    // updater is the same impurity.
    {
      const next = grid.map((r) => r.map((c) => ({ ...c })));
      if (next[y][x].mine) {
        next.forEach((r) => r.forEach((c) => { if (c.mine) c.open = true; }));
        setGrid(next);
        setStatus("boom");
        return;
      }
      // Flood-fill the zero region iteratively. Recursion here overflows the
      // stack on a large empty board, which is exactly the good opening move.
      const queue: Array<[number, number]> = [[x, y]];
      while (queue.length) {
        const [cx, cy] = queue.pop()!;
        const cell = next[cy][cx];
        if (cell.open || cell.flag) continue;
        cell.open = true;
        if (cell.n === 0) {
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx, ny = cy + dy;
            if (nx >= 0 && ny >= 0 && nx < W && ny < H && !next[ny][nx].open) queue.push([nx, ny]);
          }
        }
      }
      setGrid(next);
      const cleared = next.flat().filter((c) => c.open && !c.mine).length;
      if (cleared === W * H - MINES) {
        const secs = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        // Faster is better, so the score has to invert the clock.
        const points = Math.max(1, Math.round(10000 / secs));
        setScore(points);
        onScore(points);
        setStatus(`cleared in ${secs}s`);
      }
    }
  }, [status, started, grid, onScore]);

  // Toggling a flag writes nothing but the grid, so an updater is fine here.
  const flag = useCallback((x: number, y: number) => {
    if (status) return;
    setGrid((g) => g.map((r, ry) => r.map((c, rx) => (rx === x && ry === y && !c.open ? { ...c, flag: !c.flag } : c))));
  }, [status]);

  const flags = grid.flat().filter((c) => c.flag).length;

  return (
    <Board
      title="Minesweeper"
      score={score}
      best={best}
      status={status ?? `${MINES - flags} left`}
      onRestart={() => { setGrid(buildMines(W, H, MINES)); setStatus(undefined); setStarted(null); setScore(0); }}
      footer="Click to clear, right-click or long-press to flag. Clearing faster scores higher."
    >
      <div
        className="grid aspect-square h-full max-h-full w-full max-w-[460px] gap-[2px] rounded-[calc(var(--radius)*0.6)] border border-[var(--border)] bg-black/20 p-1"
        style={{ gridTemplateColumns: `repeat(${W}, minmax(0, 1fr))` }}
      >
        {grid.flatMap((row, y) => row.map((c, x) => (
          <button
            key={`${x}-${y}`}
            onClick={() => open(x, y)}
            onContextMenu={(e) => { e.preventDefault(); flag(x, y); }}
            className={cn("grid place-items-center rounded-[2px] text-[clamp(8px,1.8cqw,13px)] font-semibold tabular-nums")}
            style={{
              background: c.open
                ? c.mine ? "var(--danger)" : "color-mix(in srgb, var(--muted) 12%, transparent)"
                : "color-mix(in srgb, var(--panel-solid) 85%, transparent)",
              color: c.open && !c.mine ? NUM_COLOR[c.n] : "var(--text)",
              border: c.open ? "1px solid transparent" : "1px solid var(--border)",
            }}
          >
            {c.open ? (c.mine ? <Icon name="warning" size={10} /> : c.n || "") : c.flag ? <Icon name="pin" size={10} style={{ color: "var(--accent)" }} /> : ""}
          </button>
        )))}
      </div>
    </Board>
  );
}

/* ── Secrets ──────────────────────────────────────────────────────────────── */

function Secrets() {
  const eggs = useEggs();
  const funMode = useSettings((s) => s.funMode);
  const found = eggs.found.length;

  if (!funMode) {
    return (
      <Empty
        icon="eyeoff"
        title="Fun mode is off"
        body="Secrets and their key sequences are disabled. Turn fun mode back on in Personalize → Personality if you want them."
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="mb-3 flex items-center gap-2">
        <Icon name="trophy" size={16} style={{ color: "var(--accent)" }} />
        <span className="text-[13px] font-medium">{found} of {EGGS.length} found</span>
        <div className="h-1.5 min-w-24 flex-1 overflow-hidden rounded-full bg-black/25">
          <div className="h-full rounded-full transition-all" style={{ width: `${(found / EGGS.length) * 100}%`, background: "var(--accent)" }} />
        </div>
        {found > 0 && <button className="os-btn !py-0.5 text-[10.5px]" onClick={() => eggs.reset()}>Forget them</button>}
      </div>
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))" }}>
        {EGGS.map((e) => {
          const got = eggs.found.includes(e.id);
          return (
            <div key={e.id} className={cn("os-card", got && "!border-[var(--accent)]")}>
              <div className="mb-1 flex items-center gap-1.5">
                <Icon name={got ? "check" : "eyeoff"} size={12} style={{ color: got ? "var(--accent)" : "var(--muted)" }} />
                <span className="text-[12.5px] font-medium">{got ? e.name : "???"}</span>
              </div>
              <div className="text-[11px] leading-relaxed text-[var(--muted)]">{got ? e.reveal : e.hint}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
