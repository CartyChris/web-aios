"use client";

import { Component, lazy, Suspense, type ComponentType, type ReactNode } from "react";
import { useSettings } from "@/kernel/settings";
import { THREE_WALLPAPERS, threeProps } from "@/lib/customize";
import "@designcodeio/threeui/style.css";

/* ThreeUI live wallpapers (MIT, Meng To, github.com/MengTo/threeui).

   This whole module is loaded only when the ThreeUI wallpaper is chosen, and
   each component below is its own chunk: one static import() per component,
   so the bundler splits them and a person downloads only the one they pick.
   If WebGL fails the wallpaper falls back to the theme gradient instead of
   leaving a black desktop. */

type Any = ComponentType<Record<string, unknown>>;
const as = (c: unknown) => c as Any;

const LOADERS: Record<string, () => Promise<{ default: Any }>> = {
  ConstellationField: () => import("@designcodeio/threeui/components/ConstellationField").then((m) => ({ default: as(m.ConstellationField) })),
  DotMatrixBackground: () => import("@designcodeio/threeui/components/DotMatrixBackground").then((m) => ({ default: as(m.DotMatrixBackground) })),
  CrtBackground: () => import("@designcodeio/threeui/components/CrtBackground").then((m) => ({ default: as(m.CrtBackground) })),
  CondensationBackground: () => import("@designcodeio/threeui/components/CondensationBackground").then((m) => ({ default: as(m.CondensationBackground) })),
  BellFieldBackground: () => import("@designcodeio/threeui/components/BellFieldBackground").then((m) => ({ default: as(m.BellFieldBackground) })),
  RibbonFieldBackground: () => import("@designcodeio/threeui/components/RibbonFieldBackground").then((m) => ({ default: as(m.RibbonFieldBackground) })),
  WarpFieldBackground: () => import("@designcodeio/threeui/components/WarpFieldBackground").then((m) => ({ default: as(m.WarpFieldBackground) })),
  EmeraldHorizonBackground: () => import("@designcodeio/threeui/components/EmeraldHorizonBackground").then((m) => ({ default: as(m.EmeraldHorizonBackground) })),
  LiquidFormBackground: () => import("@designcodeio/threeui/components/LiquidFormBackground").then((m) => ({ default: as(m.LiquidFormBackground) })),
  OrbitalSphereBackground: () => import("@designcodeio/threeui/components/OrbitalSphereBackground").then((m) => ({ default: as(m.OrbitalSphereBackground) })),
  StreamConvergenceBackground: () => import("@designcodeio/threeui/components/StreamConvergenceBackground").then((m) => ({ default: as(m.StreamConvergenceBackground) })),
};

// Built once, at module level: one lazy component per entry, none created during render.
const LAZY: Record<string, Any> = Object.fromEntries(Object.entries(LOADERS).map(([k, load]) => [k, lazy(load) as unknown as Any]));

class Fallback extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div className="absolute inset-0" style={{ background: "linear-gradient(135deg, var(--bg), var(--bg2))" }} data-threeui-failed /> : this.props.children; }
}

export default function ThreeUIWallpaper() {
  const w = useSettings((s) => s.customize.threeWallpaper);
  const def = THREE_WALLPAPERS.find((x) => x.id === w.id) ?? THREE_WALLPAPERS[0];
  const C = LAZY[def.component] ?? LAZY.ConstellationField;
  const props = threeProps(def, w);
  return (
    <div className="absolute inset-0" data-threeui={def.id} style={{ background: "var(--bg)" }}>
      <Fallback key={def.id}>
        <Suspense fallback={null}>
          <C {...props} className="threeui-background" />
        </Suspense>
      </Fallback>
    </div>
  );
}
