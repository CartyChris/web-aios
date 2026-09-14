"use client";

import type { CSSProperties } from "react";

/* ────────────────────────────────────────────────────────────────────────────
   The icon set.

   Drawn for this OS rather than borrowed: emoji render as a different picture
   on every platform, carry their own colour that fights the active theme, and
   sit on a baseline instead of a grid — three reasons they never look like a
   designed system.

   Every glyph here is on a 24×24 grid, stroked at 1.6 with round caps, and
   painted in `currentColor`, so an icon inherits the accent of whatever
   surface it sits on and re-colours instantly when the theme changes.
   ──────────────────────────────────────────────────────────────────────────── */

const P = ({ d }: { d: string }) => <path d={d} />;

export const ICONS: Record<string, React.ReactNode> = {
  /* ── AI & agents ──────────────────────────────────────────────────────── */
  // Chat: a speech bubble with a conversation rhythm inside.
  chat: <><P d="M4 5.5h16v10.5H9l-4 3.5v-3.5H4z" /><P d="M8 9h8M8 12h5" /></>,
  // Swarm: a central node with satellites — many agents, one question.
  swarm: <><circle cx="12" cy="12" r="2.4" /><circle cx="5" cy="6.5" r="1.7" /><circle cx="19" cy="6.5" r="1.7" /><circle cx="5" cy="17.5" r="1.7" /><circle cx="19" cy="17.5" r="1.7" /><P d="M6.4 7.8 10 10.6M17.6 7.8 14 10.6M6.4 16.2 10 13.4M17.6 16.2 14 13.4" /></>,
  // Atlas: a sextant — measuring by fixed points, which is what it does.
  atlas: <><P d="M4 19.5 12 4l8 15.5z" /><P d="M7.5 15.5h9" /><circle cx="12" cy="11" r="1.5" /><P d="M12 19.5v-3" /></>,
  // Deep Work: a target with a gate line across it.
  deepwork: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3.6" /><P d="M12 4v4M12 16v4" /></>,
  // Profiler: a document with a read-out.
  profiler: <><P d="M6 3.5h8l4 4v13H6z" /><P d="M14 3.5v4h4" /><P d="M9 12h6M9 15h6M9 18h3" /></>,
  // Agent Loop: a lemniscate — plan, act, verify, learn, repeat.
  loop: <><P d="M12 12c-1.6-2.6-3-3.9-4.6-3.9a3.9 3.9 0 0 0 0 7.8c1.6 0 3-1.3 4.6-3.9zm0 0c1.6 2.6 3 3.9 4.6 3.9a3.9 3.9 0 0 0 0-7.8c-1.6 0-3 1.3-4.6 3.9z" /></>,
  // Memory Vault: a strongbox with a dial.
  vault: <><rect x="3.5" y="5" width="17" height="14" rx="1.6" /><circle cx="12" cy="12" r="3.2" /><P d="M12 8.8v-1.4M12 16.6v-1.4M15.2 12h1.4M7.4 12h1.4" /></>,
  // Observatory: a dome with an aperture on the sky.
  observatory: <><P d="M4 19.5h16" /><P d="M5.5 19.5a6.5 6.5 0 0 1 13 0" /><P d="M9.5 8.5 14.5 5" /><circle cx="15.8" cy="4.3" r="1.3" /></>,

  /* ── Build ────────────────────────────────────────────────────────────── */
  // Code Studio: angle brackets around a caret.
  ide: <><P d="M8.5 8.5 4.5 12l4 3.5M15.5 8.5l4 3.5-4 3.5" /><P d="M13.5 5.5l-3 13" /></>,
  // Forge 3D: an isometric cube, which is literally what its viewport draws.
  forge3d: <><P d="M12 3.2 20 7.6v8.8L12 20.8 4 16.4V7.6z" /><P d="M12 12.4 20 7.6M12 12.4 4 7.6M12 12.4v8.4" /></>,
  // Asset Library: stacked crates.
  assets: <><rect x="3.5" y="11" width="7.5" height="8.5" rx="1" /><rect x="13" y="11" width="7.5" height="8.5" rx="1" /><rect x="8.25" y="3.5" width="7.5" height="7" rx="1" /></>,
  // Builder Labs: a flask.
  labs: <><P d="M10 3.5v6L5 18.2a1.6 1.6 0 0 0 1.4 2.3h11.2a1.6 1.6 0 0 0 1.4-2.3L14 9.5v-6z" /><P d="M9 3.5h6" /><P d="M7.6 14.5h8.8" /></>,
  // HTML Studio: a browser frame with a build caret.
  studio: <><rect x="3.5" y="4.5" width="17" height="15" rx="1.8" /><P d="M3.5 8.8h17" /><P d="M9.5 12.5 12 15l-2.5 2.5" /><P d="M13.5 17.5h3.5" /></>,

  /* ── Research & data ──────────────────────────────────────────────────── */
  // Signals: a broadcast dish.
  intel: <><P d="M12 20.5V13" /><P d="M8 20.5h8" /><P d="M4.6 12.4a8 8 0 0 1 11.3-11.3z" /><circle cx="12" cy="12.6" r="1.4" /></>,
  browser: <><circle cx="12" cy="12" r="8.3" /><P d="M3.7 12h16.6" /><P d="M12 3.7a13 13 0 0 1 0 16.6 13 13 0 0 1 0-16.6z" /></>,

  /* ── Productivity ─────────────────────────────────────────────────────── */
  notes: <><P d="M5.5 3.5h9l4.5 4.5v12.5h-13.5z" /><P d="M14.5 3.5v4.5h4.5" /><P d="M8.5 13h7M8.5 16.5h4.5" /></>,
  tasks: <><rect x="3.5" y="4.5" width="17" height="15" rx="1.8" /><P d="M7.5 11.2l2 2 4-4.4" /><P d="M7.5 16.5h9" /></>,
  files: <><P d="M3.5 6.2a1.6 1.6 0 0 1 1.6-1.6h4l2 2.4h7.3a1.6 1.6 0 0 1 1.6 1.6v9.6a1.6 1.6 0 0 1-1.6 1.6H5.1a1.6 1.6 0 0 1-1.6-1.6z" /></>,
  terminal: <><rect x="3.5" y="4.5" width="17" height="15" rx="1.8" /><P d="M7.5 9.5 10.5 12l-3 2.5" /><P d="M12.5 15h4.5" /></>,
  focus: <><circle cx="12" cy="13" r="7.5" /><P d="M12 9v4l2.6 1.6" /><P d="M9.5 2.8h5" /><P d="M12 2.8v2.7" /></>,
  calc: <><rect x="4.5" y="3.5" width="15" height="17" rx="1.8" /><P d="M7.8 7.6h8.4" /><P d="M8.4 12h.01M12 12h.01M15.6 12h.01M8.4 16h.01M12 16h.01M15.6 16h.01" /></>,
  media: <><circle cx="12" cy="12" r="8.3" /><P d="M10.3 8.8 15.6 12l-5.3 3.2z" /></>,
  mediadeck: <><rect x="3.5" y="5.5" width="17" height="13" rx="1.8" /><P d="M3.5 9.2h17" /><P d="M9.2 12.2 13.4 14.4 9.2 16.6z" /><P d="M6.6 5.5V3.2M17.4 5.5V3.2" /></>,

  /* ── System ───────────────────────────────────────────────────────────── */
  // Personalize: a paint nib splitting into two tones.
  personalize: <><P d="M12 3.2 5.4 12.6a7.2 7.2 0 1 0 13.2 0z" /><P d="M12 3.2v17.4" /></>,
  settings: <><circle cx="12" cy="12" r="3.1" /><P d="M12 2.8v2.6M12 18.6v2.6M21.2 12h-2.6M5.4 12H2.8M18.5 5.5l-1.9 1.9M7.4 16.6l-1.9 1.9M18.5 18.5l-1.9-1.9M7.4 7.4 5.5 5.5" /></>,
  monitor: <><rect x="3.5" y="4.5" width="17" height="12.5" rx="1.6" /><P d="M8.5 21h7" /><P d="M12 17v4" /><P d="M7 13l2.6-3.4 2.4 2.6 2-3.6 2.8 4.4" /></>,
  // Bridge: two piers joined by a span.
  bridge: <><P d="M3 16.5h18" /><P d="M6 16.5V9M18 16.5V9" /><P d="M3 11.5c3.6-3.4 14.4-3.4 18 0" /><P d="M9.8 16.5v-3.2M14.2 16.5v-3.2" /></>,

  /* ── Shell chrome ─────────────────────────────────────────────────────── */
  launcher: <><P d="M9 4.5H6.8A2.3 2.3 0 1 0 9 6.8zm6 0h2.2A2.3 2.3 0 1 1 15 6.8zm-6 15H6.8A2.3 2.3 0 1 1 9 17.2zm6 0h2.2a2.3 2.3 0 1 0-2.2-2.3z" /><rect x="9" y="9" width="6" height="6" rx="0.8" /><P d="M9 9V6.8M15 9V6.8M9 15v2.2M15 15v2.2M9 9H6.8M9 15H6.8M15 9h2.2M15 15h2.2" /></>,
  search: <><circle cx="10.8" cy="10.8" r="6.3" /><P d="M15.4 15.4 20 20" /></>,
  workspaces: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.2" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.2" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.2" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.2" /></>,
  bell: <><P d="M6.8 10.2a5.2 5.2 0 0 1 10.4 0c0 4.2 1.6 5.6 1.6 5.6H5.2s1.6-1.4 1.6-5.6z" /><P d="M10.2 18.8a2 2 0 0 0 3.6 0" /></>,
  network: <><P d="M2.8 9.4a13 13 0 0 1 18.4 0" /><P d="M6.2 12.8a8.2 8.2 0 0 1 11.6 0" /><P d="M9.6 16.2a3.4 3.4 0 0 1 4.8 0" /><circle cx="12" cy="19.4" r="0.9" /></>,
  clock: <><circle cx="12" cy="12" r="8.3" /><P d="M12 7.2V12l3.2 2" /></>,
  calendar: <><rect x="3.5" y="5" width="17" height="15" rx="1.6" /><P d="M3.5 9.6h17" /><P d="M8 5V2.8M16 5V2.8" /><P d="M8 13.4h2M14 13.4h2M8 16.8h2M14 16.8h2" /></>,
  home: <><P d="M3.8 10.6 12 3.6l8.2 7v9a1 1 0 0 1-1 1H4.8a1 1 0 0 1-1-1z" /><P d="M9.4 20.6v-6.4h5.2v6.4" /></>,
  switcher: <><rect x="3.5" y="5.5" width="7.5" height="13" rx="1.3" /><rect x="13" y="5.5" width="7.5" height="13" rx="1.3" /></>,
  grid: <><rect x="3.5" y="3.5" width="6.4" height="6.4" rx="1" /><rect x="14.1" y="3.5" width="6.4" height="6.4" rx="1" /><rect x="3.5" y="14.1" width="6.4" height="6.4" rx="1" /><rect x="14.1" y="14.1" width="6.4" height="6.4" rx="1" /></>,
  menu: <><P d="M4 7h16M4 12h16M4 17h16" /></>,

  /* ── Widgets ──────────────────────────────────────────────────────────── */
  system: <><rect x="3.5" y="5" width="17" height="14" rx="1.6" /><P d="M7 15.2l2.8-4 2.6 2.8 2.2-3.4 2.4 4.6" /></>,
  quick: <><P d="M13.4 2.8 5.2 13.4h5.4l-.8 7.8 8.2-10.6h-5.4z" /></>,
  sticky: <><P d="M4.5 4.5h15v10l-5 5h-10z" /><P d="M19.5 14.5h-5v5" /></>,
  spark: <><P d="M12 3.2l2.1 5.3 5.3 2.1-5.3 2.1L12 18l-2.1-5.3L4.6 10.6l5.3-2.1z" /></>,
  storage: <><ellipse cx="12" cy="6.4" rx="7.6" ry="2.9" /><P d="M4.4 6.4v11.2c0 1.6 3.4 2.9 7.6 2.9s7.6-1.3 7.6-2.9V6.4" /><P d="M4.4 12c0 1.6 3.4 2.9 7.6 2.9s7.6-1.3 7.6-2.9" /></>,

  /* ── Generic UI ───────────────────────────────────────────────────────── */
  plus: <><P d="M12 5v14M5 12h14" /></>,
  close: <><P d="M6 6l12 12M18 6 6 18" /></>,
  check: <><P d="M5 12.5 9.5 17 19 7" /></>,
  warning: <><P d="M12 3.6 21 19.4H3z" /><P d="M12 10v4.2M12 17h.01" /></>,
  info: <><circle cx="12" cy="12" r="8.4" /><P d="M12 11v5.4M12 8h.01" /></>,
  play: <><P d="M7.5 5.2 18.5 12 7.5 18.8z" /></>,
  stop: <><rect x="6.5" y="6.5" width="11" height="11" rx="1.4" /></>,
  copy: <><rect x="8.5" y="8.5" width="11" height="11" rx="1.6" /><P d="M15.5 8.5v-2a1.6 1.6 0 0 0-1.6-1.6H6.1A1.6 1.6 0 0 0 4.5 6.5v7.8a1.6 1.6 0 0 0 1.6 1.6h2" /></>,
  download: <><P d="M12 3.6v11.2" /><P d="M7.6 10.4 12 14.8l4.4-4.4" /><P d="M4.4 19.4h15.2" /></>,
  save: <><P d="M5 4.5h11L19.5 8v11.5H5z" /><P d="M8.4 4.5v5h7v-5" /><rect x="8.4" y="13" width="7.2" height="6.5" rx="0.8" /></>,
  trash: <><P d="M4.8 6.8h14.4" /><P d="M9.4 6.8V4.6h5.2v2.2" /><P d="M6.6 6.8l.9 12.2a1.4 1.4 0 0 0 1.4 1.3h6.2a1.4 1.4 0 0 0 1.4-1.3l.9-12.2" /></>,
  pin: <><P d="M9 3.8h6l-.8 6 3 3.2H6.8l3-3.2z" /><P d="M12 13v7.2" /></>,
  key: <><circle cx="8" cy="12" r="4" /><P d="M12 12h8.2M17.6 12v3.2M20.2 12v2.4" /></>,
  shield: <><P d="M12 3.2 19.6 6v6c0 4.4-3 7.4-7.6 8.8C7.4 19.4 4.4 16.4 4.4 12V6z" /><P d="M9.2 12.2 11.4 14.4 15 10.4" /></>,
  keyboard: <><rect x="2.8" y="6.5" width="18.4" height="11" rx="1.6" /><P d="M6.4 10h.01M9.6 10h.01M12.8 10h.01M16 10h.01M6.4 13.2h.01M9.6 13.2h.01M12.8 13.2h.01M16 13.2h.01M8.4 15.6h7.2" /></>,
  layout: <><rect x="3.5" y="4.5" width="17" height="15" rx="1.6" /><P d="M9.5 4.5v15M9.5 11.5h11" /></>,
  wallpaper: <><rect x="3.5" y="5" width="17" height="14" rx="1.6" /><circle cx="8.6" cy="9.6" r="1.6" /><P d="M3.5 16.6l4.8-4.2 3.6 3 3-2.4 5.1 4.2" /></>,
  tokens: <><P d="M8.6 5 5.8 12l2.8 7M15.4 5l2.8 7-2.8 7" /><P d="M13.2 8.4 10.8 15.6" /></>,
  widgets: <><rect x="3.5" y="3.5" width="8" height="6" rx="1.1" /><rect x="3.5" y="12.5" width="8" height="8" rx="1.1" /><rect x="14.5" y="3.5" width="6" height="8" rx="1.1" /><rect x="14.5" y="14.5" width="6" height="6" rx="1.1" /></>,
  backup: <><P d="M20.2 12a8.2 8.2 0 1 1-2.6-6" /><P d="M20.4 4.2v5.2h-5.2" /></>,
  gate: <><P d="M4 20V6.4A2.4 2.4 0 0 1 6.4 4h11.2A2.4 2.4 0 0 1 20 6.4V20" /><P d="M4 12.8h16" /><P d="M9.2 4v16M14.8 4v16" /></>,
  report: <><P d="M6 3.6h8l4 4v12.8H6z" /><P d="M14 3.6v4h4" /><P d="M9 16.4v-3M12 16.4v-5.4M15 16.4v-2" /></>,
  link: <><P d="M10.4 13.6a3.6 3.6 0 0 0 5.2 0l2.6-2.6a3.7 3.7 0 0 0-5.2-5.2l-1.2 1.2" /><P d="M13.6 10.4a3.6 3.6 0 0 0-5.2 0L5.8 13a3.7 3.7 0 0 0 5.2 5.2l1.2-1.2" /></>,
  claim: <><P d="M12 3.4 14.2 9l6.2.4-4.8 4 1.6 6-5.2-3.4L6.8 19.4l1.6-6-4.8-4L9.8 9z" /></>,
  agents: <><circle cx="8.4" cy="8.4" r="2.8" /><circle cx="16" cy="15.6" r="2.8" /><P d="M4 20c0-2.6 2-4.4 4.4-4.4" /><P d="M20 8.4c0-2.4-1.8-4.4-4.4-4.4" /></>,
  tune: <><P d="M5 8h10M19 8h0.01M5 16h4M13 16h6" /><circle cx="17" cy="8" r="2.2" /><circle cx="11" cy="16" r="2.2" /></>,
  folder: <><P d="M3.5 6.2a1.6 1.6 0 0 1 1.6-1.6h4l2 2.4h7.3a1.6 1.6 0 0 1 1.6 1.6v9.6a1.6 1.6 0 0 1-1.6 1.6H5.1a1.6 1.6 0 0 1-1.6-1.6z" /></>,
  file: <><P d="M6 3.6h8l4 4v12.8H6z" /><P d="M14 3.6v4h4" /></>,
  star: <><P d="M12 3.6 14.3 9l5.9.5-4.5 3.9 1.4 5.8L12 16.1 6.9 19.2l1.4-5.8L3.8 9.5 9.7 9z" /></>,
  pause: <><P d="M9 5.5v13M15 5.5v13" /></>,
  eye: <><P d="M2.6 12S6 6.2 12 6.2 21.4 12 21.4 12 18 17.8 12 17.8 2.6 12 2.6 12z" /><circle cx="12" cy="12" r="2.8" /></>,
  eyeoff: <><P d="M4 4l16 16" /><P d="M9.6 9.8a2.8 2.8 0 0 0 3.9 3.9" /><P d="M6.7 7.2C4.3 8.7 2.6 12 2.6 12s3.4 5.8 9.4 5.8a9.6 9.6 0 0 0 4-.9" /><P d="M17.9 15.1c2-1.5 3.5-3.1 3.5-3.1S18 6.2 12 6.2a9.2 9.2 0 0 0-2.2.3" /></>,
  ban: <><circle cx="12" cy="12" r="8.4" /><P d="M6.1 6.1l11.8 11.8" /></>,
  external: <><P d="M13.4 4.6h6v6" /><P d="M11 13 19.4 4.6" /><P d="M18.4 13.6v4.8a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 18.4V7.2a1.6 1.6 0 0 1 1.6-1.6h4.8" /></>,
  chevronDown: <><P d="M6.5 9.5 12 15l5.5-5.5" /></>,
  chevronRight: <><P d="M9.5 6.5 15 12l-5.5 5.5" /></>,
  arrowUp: <><P d="M12 19V5" /><P d="M6.4 10.6 12 5l5.6 5.6" /></>,
  arrowDown: <><P d="M12 5v14" /><P d="M6.4 13.4 12 19l5.6-5.6" /></>,
  half: <><circle cx="12" cy="12" r="8.2" /><path d="M12 3.8a8.2 8.2 0 0 1 0 16.4z" fill="currentColor" stroke="none" /></>,
  circle: <><circle cx="12" cy="12" r="8.2" /></>,
  doubleCheck: <><P d="M2.8 12.6 6.4 16.2 13 8.4" /><P d="M11 15.4l1.6 1.6L21.2 7" /></>,
  diamond: <><P d="M12 4.2 19.8 12 12 19.8 4.2 12z" /></>,
  caret: <><P d="M9.5 7 15 12l-5.5 5" /></>,
  minimize: <><P d="M5 12h14" /></>,
  maximize: <><rect x="5.5" y="5.5" width="13" height="13" rx="1.6" /></>,
  app: <><rect x="4" y="4" width="16" height="16" rx="3.4" /></>,
};

export type IconName = keyof typeof ICONS | string;

export interface IconProps {
  name: IconName;
  size?: number | string;
  className?: string;
  style?: CSSProperties;
  /** Decorative by default; pass a label when the icon is the only affordance. */
  label?: string;
  strokeWidth?: number;
}

/** Renders one glyph from the set. Unknown names fall back to a generic app
 *  tile rather than rendering nothing, so a typo is visible but not fatal. */
export function Icon({ name, size = "1em", className, style, label, strokeWidth = 1.6 }: IconProps) {
  const glyph = ICONS[name] ?? ICONS.app;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      // inline-block + a baseline nudge: a bare inline <svg> sits ON the text
      // baseline and drags the line box taller, which silently inflates every
      // button it appears in.
      style={{ flexShrink: 0, display: "inline-block", verticalAlign: "-0.135em", ...style }}
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
    >
      {label && <title>{label}</title>}
      {glyph}
    </svg>
  );
}

/* ── Desktop pets ──────────────────────────────────────────────────────────
   Drawn rather than emoji for the same reason as everything else, and because
   an emoji pet is a different animal on every platform. */
export const PET_ICONS: Record<string, React.ReactNode> = {
  cat: <><P d="M5.5 10.5 4.5 5l4.2 2.8a8.4 8.4 0 0 1 6.6 0L19.5 5l-1 5.5a7 7 0 1 1-13 0z" /><P d="M9.4 12.6h.01M14.6 12.6h.01" /><P d="M12 15.2v1.2M9.6 16.8h4.8" /></>,
  dog: <><P d="M6 7.5 4.2 4.8 6.8 4l1.6 2.4a8 8 0 0 1 7.2 0L17.2 4l2.6.8L18 7.5a7.2 7.2 0 1 1-12 0z" /><P d="M9.4 12h.01M14.6 12h.01" /><P d="M12 14.4a1.8 1.8 0 0 0 0 2.8" /></>,
  robot: <><rect x="4.5" y="7.5" width="15" height="11" rx="2.4" /><P d="M12 7.5V4.2" /><circle cx="12" cy="3.2" r="1.2" /><P d="M9 12h.01M15 12h.01" /><P d="M9.6 15.4h4.8" /><P d="M4.5 11.6H2.8M21.2 11.6h-1.7" /></>,
  fox: <><P d="M4.6 5.2 7.8 9a7.6 7.6 0 0 1 8.4 0l3.2-3.8 1 6.6a8 8 0 1 1-16.8 0z" /><P d="M9.6 12.6h.01M14.4 12.6h.01" /><P d="M12 15v1.4" /></>,
  slime: <><P d="M4.4 18.2c0-5.4 3.4-9.8 7.6-9.8s7.6 4.4 7.6 9.8z" /><P d="M4.4 18.2h15.2" /><P d="M9.6 14h.01M14.4 14h.01" /></>,
  dragon: <><P d="M3.4 12.8c3-5.2 7.4-7.8 13.2-7.8l-2 3.6 4 .8-3.4 3 2.6 1.6-4.4 1.4.6 3.4-4-2.2-3 3z" /><P d="M13.4 9.4h.01" /></>,
  ghost: <><P d="M5.4 20.4V11a6.6 6.6 0 0 1 13.2 0v9.4l-2.2-1.8-2.2 1.8-2.2-1.8-2.2 1.8-2.2-1.8z" /><P d="M9.8 10.6h.01M14.2 10.6h.01" /></>,
  penguin: <><P d="M12 3.2a4.4 4.4 0 0 1 4.4 4.4v8.6a4.4 4.4 0 0 1-8.8 0V7.6A4.4 4.4 0 0 1 12 3.2z" /><P d="M10.4 7.4h.01M13.6 7.4h.01" /><P d="M12 9.2l-1.2 1.4h2.4z" /><P d="M7.6 20.4h3M13.4 20.4h3" /></>,
  bunny: <><P d="M8.6 9.4C8.6 6 8 3.2 7 3.2S5.4 5.6 5.6 9.4M15.4 9.4C15.4 6 16 3.2 17 3.2s1.6 2.4 1.4 6.2" /><circle cx="12" cy="15" r="5.2" /><P d="M10.2 14h.01M13.8 14h.01" /><P d="M12 16.2v1.2M10.4 18h3.2" /></>,
  bird: <><P d="M4 14.6c0-3.8 3-6.8 6.8-6.8h6.4l2.8-2.6v4.2a6.8 6.8 0 0 1-6.8 6.8h-2.6l-3 3.4v-3.6A3.8 3.8 0 0 1 4 14.6z" /><P d="M14.6 11h.01" /></>,
  crab: <><P d="M6.4 6.6 8.8 9.6M17.6 6.6 15.2 9.6" /><ellipse cx="12" cy="13.4" rx="5.2" ry="4" /><P d="M10.2 12.4h.01M13.8 12.4h.01" /><P d="M6.8 13h-3M17.2 13h3M7.6 16.4l-2.6 2M16.4 16.4l2.6 2" /></>,
  fish: <><P d="M3.6 12c3-4 6.4-6 9.6-6s5.8 2.4 7.2 6c-1.4 3.6-4 6-7.2 6s-6.6-2-9.6-6z" /><P d="M20.4 12 22 8.6v6.8z" /><P d="M14.4 10.4h.01" /></>,
  bear: <><circle cx="7.4" cy="6.6" r="2.4" /><circle cx="16.6" cy="6.6" r="2.4" /><circle cx="12" cy="13.4" r="6.2" /><P d="M9.8 12.2h.01M14.2 12.2h.01" /><P d="M12 14.6a2 2 0 0 0 0 2.8" /></>,
  alien: <><P d="M12 3.4c4.4 0 7 3.2 7 7 0 4.6-3.6 10.2-7 10.2S5 15 5 10.4c0-3.8 2.6-7 7-7z" /><P d="M8.6 10.2c.8-1.4 2-2 3-1.4M15.4 10.2c-.8-1.4-2-2-3-1.4" /></>,
  mushroom: <><P d="M3.8 11.2a8.2 8.2 0 0 1 16.4 0z" /><P d="M9.4 11.2v6.2a2.6 2.6 0 0 0 5.2 0v-6.2" /><P d="M8.4 7.8h.01M14.4 6.8h.01M11.4 9h.01" /></>,
  octo: <><circle cx="12" cy="8.8" r="5" /><P d="M9.8 8h.01M14.2 8h.01" /><P d="M7.4 12.6c-.8 3-2 4.6-3.6 5M10 13.8c-.4 3.4-1.2 5.2-2.4 5.8M14 13.8c.4 3.4 1.2 5.2 2.4 5.8M16.6 12.6c.8 3 2 4.6 3.6 5" /></>,
};

/** A desktop pet, drawn on the same grid as everything else. */
export function PetIcon({ name, size = 44, className, style }: { name: string; size?: number; className?: string; style?: CSSProperties }) {
  const glyph = PET_ICONS[name];
  if (!glyph) return null;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden>
      {glyph}
    </svg>
  );
}
