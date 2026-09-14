import type { ComponentType } from "react";

/** Every surface the OS can show is one of these. */
export type AppCategory = "ai" | "research" | "build" | "system" | "media" | "productivity" | "game";

export interface AppManifest {
  id: string;
  name: string;
  /** Name of a glyph in the icon set (src/shell/icons.tsx). */
  icon: string;
  category: AppCategory;
  description: string;
  /** Lazily-loaded surface. Every app receives its own window handle. */
  component: ComponentType<AppProps>;
  defaultSize?: { w: number; h: number };
  minSize?: { w: number; h: number };
  /** Only one live instance allowed (Settings, Personalize, …). */
  singleton?: boolean;
  /** Declared up front so the Privacy panel can show what an app can touch. */
  permissions?: Permission[];
  /** Shown on the app's launcher tile. */
  accent?: string;
  /** Apps flagged heavy get a "still loading" affordance rather than a blank pane. */
  heavy?: boolean;
}

export type Permission = "network" | "ai" | "storage" | "clipboard" | "files" | "camera" | "microphone";

export interface AppProps {
  /** The window this instance is painted into. */
  win: WindowInstance;
  /** Arbitrary launch payload — e.g. open Notes at a given note id. */
  args?: Record<string, unknown>;
}

export type WindowState = "normal" | "minimized" | "maximized" | "fullscreen";

export interface WindowInstance {
  id: string;
  appId: string;
  title: string;
  icon: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  state: WindowState;
  workspace: number;
  /** Geometry to restore to when un-maximizing. */
  restore?: { x: number; y: number; w: number; h: number };
  args?: Record<string, unknown>;
  createdAt: number;
  /** Windows pinned to a workspace-independent "always visible" layer. */
  pinned?: boolean;
}

export interface Notification {
  id: string;
  title: string;
  body?: string;
  kind: "info" | "success" | "warn" | "error";
  appId?: string;
  ts: number;
  read?: boolean;
}
