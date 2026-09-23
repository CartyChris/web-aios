/* ────────────────────────────────────────────────────────────────────────────
   Shader wallpapers as node graphs.

   The ComfyUI idea, applied to GLSL: a wallpaper is not a 300-line monolith,
   it is a short RECIPE wired from small reusable NODES —

       hash -> noise -> fbm -> warp -> (recipe) -> grade -> grain -> screen

   Each node declares the nodes it depends on. `composeFragment` walks that
   graph, emits every node exactly once in dependency order, and appends the
   recipe's own main(). Adding a wallpaper is writing ~30 lines of main() over
   nodes that already exist and are already known to compile.

   Colour pipeline, as three.js does it: theme tokens are sRGB hex, so they are
   linearised here on the CPU (`hexToLinear`), all shading happens in linear
   light, a soft highlight shoulder keeps glow from clipping, and `finish`
   encodes back to sRGB and adds triangular dither so slow gradients never band.

   Pure: no DOM, no WebGL, no imports. The renderer lives in
   shell/ShaderWallpaper.tsx; everything here is testable in node.
   ──────────────────────────────────────────────────────────────────────────── */

export interface ShaderNode {
  id: string;
  deps: readonly string[];
  glsl: string;
}

export interface ShaderRecipe {
  /** Wallpaper id; must also appear in WALLPAPERS in kernel/themes.ts. */
  id: string;
  name: string;
  /** Theme id this wallpaper was designed against. */
  theme: string;
  /** Nodes main() calls directly. Their dependencies are pulled in for free. */
  nodes: readonly string[];
  /** Backing-store resolution as a fraction of CSS pixels. Soft fields render
   *  at half resolution and let the browser upscale; line work renders at 1. */
  scale: number;
  main: string;
}

/** Fullscreen triangle from gl_VertexID: no vertex buffer, no attribute, no
 *  VAO state to leak. One triangle rather than a quad avoids the diagonal seam
 *  where two triangles would each shade the same 2x2 quads. */
export const VERTEX_SHADER = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const HEADER = `#version 300 es
precision highp float;
uniform vec2 u_res;
uniform float u_time;
uniform vec3 u_bg;
uniform vec3 u_bg2;
uniform vec3 u_a1;
uniform vec3 u_a2;
uniform float u_dark;
out vec4 fragColor;
`;

/* ── Nodes ────────────────────────────────────────────────────────────────── */

export const SHADER_NODES: Record<string, ShaderNode> = {
  // Sine-free hashes (Dave Hoskins). sin()-based hashes lose precision on
  // mobile GPUs and show as visible grid artefacts at large coordinates.
  hash: {
    id: "hash",
    deps: [],
    glsl: `
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
`,
  },
  // 2D gradient noise, quintic fade. Output roughly -0.7..0.7.
  noise: {
    id: "noise",
    deps: ["hash"],
    glsl: `
float gnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(hash22(i) * 2.0 - 1.0, f);
  float b = dot(hash22(i + vec2(1.0, 0.0)) * 2.0 - 1.0, f - vec2(1.0, 0.0));
  float c = dot(hash22(i + vec2(0.0, 1.0)) * 2.0 - 1.0, f - vec2(0.0, 1.0));
  float d = dot(hash22(i + vec2(1.0, 1.0)) * 2.0 - 1.0, f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
`,
  },
  // 3D value noise, 0..1. Eight hashes; used only by the volumetric recipe.
  noise3: {
    id: "noise3",
    deps: ["hash"],
    glsl: `
float vnoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i), n100 = hash13(i + vec3(1, 0, 0));
  float n010 = hash13(i + vec3(0, 1, 0)), n110 = hash13(i + vec3(1, 1, 0));
  float n001 = hash13(i + vec3(0, 0, 1)), n101 = hash13(i + vec3(1, 0, 1));
  float n011 = hash13(i + vec3(0, 1, 1)), n111 = hash13(i + vec3(1, 1, 1));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}
`,
  },
  // Fractal sum with a per-octave rotation so the lattice never lines up.
  fbm: {
    id: "fbm",
    deps: ["noise"],
    glsl: `
const mat2 FBM_ROT = mat2(0.8, -0.6, 0.6, 0.8);
float fbm(vec2 p, int octaves) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    s += a * gnoise(p);
    p = FBM_ROT * p * 2.02 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return s;
}
`,
  },
  // Two-level domain warp (Quilez). q and r are exposed so a recipe can
  // colour by HOW the field was bent, which is where the silky look comes from.
  warp: {
    id: "warp",
    deps: ["fbm"],
    glsl: `
float warped(vec2 p, float t, int octaves, out vec2 q, out vec2 r) {
  q = vec2(fbm(p + vec2(0.0, 0.0) + 0.05 * t, octaves), fbm(p + vec2(5.2, 1.3) - 0.04 * t, octaves));
  r = vec2(fbm(p + 3.0 * q + vec2(1.7, 9.2) + 0.07 * t, octaves), fbm(p + 3.0 * q + vec2(8.3, 2.8) - 0.05 * t, octaves));
  return fbm(p + 3.0 * r, octaves);
}
`,
  },
  // Colour from the live theme: every wallpaper repaints when the accent does.
  palette: {
    id: "palette",
    deps: [],
    glsl: `
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 saturation(vec3 c, float s) { return mix(vec3(luma(c)), c, s); }
vec3 themeRamp(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c = mix(u_bg, u_bg2, smoothstep(0.0, 0.35, t));
  c = mix(c, u_a2, smoothstep(0.3, 0.7, t));
  return mix(c, u_a1, smoothstep(0.65, 1.0, t));
}
vec3 cosPalette(float t, vec3 a, vec3 b, vec3 c, vec3 d) { return a + b * cos(6.28318 * (c * t + d)); }
`,
  },
  stars: {
    id: "stars",
    deps: ["hash"],
    glsl: `
float stars(vec2 p, float threshold, float t) {
  vec2 i = floor(p);
  vec2 f = fract(p) - 0.5;
  vec2 h = hash22(i);
  vec2 o = (h - 0.5) * 0.7;
  float d = length(f - o);
  float lit = step(threshold, h.x);
  float tw = 0.65 + 0.35 * sin(t * (0.8 + h.y * 2.5) + h.y * 40.0);
  float size = mix(0.03, 0.08, h.y * h.y);
  return lit * tw * (smoothstep(size, 0.0, d) + 0.12 * exp(-d * 22.0));
}
`,
  },
  vignette: {
    id: "vignette",
    deps: [],
    glsl: `
float vignette(vec2 uv, float k) { vec2 d = uv - 0.5; return clamp(1.0 - k * dot(d, d) * 2.2, 0.0, 1.0); }
`,
  },
  // Highlight shoulder: exact below the knee, so theme backgrounds are not
  // crushed the way a full ACES curve would crush a #07111f.
  grade: {
    id: "grade",
    deps: [],
    glsl: `
vec3 shoulder(vec3 c) {
  const float k = 0.78;
  vec3 x = max(c - k, 0.0);
  return min(c, vec3(k)) + x / (1.0 + x / (1.0 - k));
}
vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
`,
  },
  // Triangular-PDF dither in display space. Hides 8-bit banding in the long
  // dark gradients these wallpapers are made of; at higher amounts it reads as
  // film grain.
  grain: {
    id: "grain",
    deps: ["hash"],
    glsl: `
vec3 grain(vec3 srgb, vec2 fc, float t, float amount) {
  float n = hash12(fc + fract(t * 7.13) * 113.0) + hash12(fc * 1.37 + 17.1) - 1.0;
  return srgb + n * amount;
}
`,
  },
  finish: {
    id: "finish",
    deps: ["grade", "grain"],
    glsl: `
vec4 finish(vec3 linear, vec2 fc, float grainAmount) {
  vec3 s = linearToSrgb(shoulder(linear));
  return vec4(grain(s, fc, u_time, max(grainAmount, 1.0 / 255.0)), 1.0);
}
`,
  },
};

/* ── Recipes ──────────────────────────────────────────────────────────────── */

export const SHADER_RECIPES: readonly ShaderRecipe[] = [
  {
    id: "borealis",
    name: "Aurora Ridge",
    theme: "borealis",
    nodes: ["fbm", "noise", "stars", "vignette", "finish"],
    scale: 0.5,
    main: `
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  float asp = u_res.x / u_res.y;
  vec2 p = vec2(uv.x * asp, uv.y);
  float t = u_time;
  vec3 col = mix(u_bg2 * 0.85, u_bg * 0.55, smoothstep(0.1, 1.0, uv.y));
  col += stars(p * 70.0, 0.9, t) * vec3(0.85, 0.9, 1.0) * smoothstep(0.3, 0.75, uv.y) * 0.9;

  vec3 glow = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float n = fbm(vec2(p.x * 0.8 + fi * 4.1, t * 0.03 + fi * 2.0), 4);
    float d = uv.y - (0.44 + fi * 0.11 + n * 0.4);
    float body = smoothstep(-0.02, 0.015, d) * exp(-max(d, 0.0) * (4.5 - fi));
    float rays = 0.5 + 0.5 * gnoise(vec2(p.x * 34.0 + n * 16.0, t * 0.2 + fi * 7.0));
    vec3 c = mix(u_a1, u_a2, clamp(d * 2.2 + fi * 0.3, 0.0, 1.0));
    glow += c * body * mix(0.35, 1.0, rays) * (0.6 - fi * 0.15);
  }
  col += glow;

  float aa = 1.5 / u_res.y;
  float far = 0.25 + 0.1 * fbm(vec2(p.x * 1.1 + 8.0, 1.3), 4);
  col = mix(col, mix(u_bg2 * 0.5, glow * 0.2 + u_bg * 0.4, 0.5), smoothstep(aa, -aa, uv.y - far) * 0.85);
  float near = 0.16 + 0.12 * fbm(vec2(p.x * 1.7, 3.7), 5);
  float inside = smoothstep(aa, -aa, uv.y - near);
  float rim = exp(-max(near - uv.y, 0.0) * 90.0);
  col = mix(col, u_bg * 0.2 + glow * 0.06 * rim + u_a1 * 0.05 * rim, inside);

  col *= vignette(uv, 0.4);
  fragColor = finish(col, gl_FragCoord.xy, 0.01);
}
`,
  },
  {
    id: "chrome",
    name: "Liquid Chrome",
    theme: "chrome",
    nodes: ["palette", "vignette", "finish"],
    scale: 0.5,
    main: `
float chromeField(vec2 p, float t) {
  for (int i = 1; i < 6; i++) {
    float fi = float(i);
    p += vec2(0.6 / fi * sin(fi * p.y + t * 0.3 + 0.3 * fi), 0.5 / fi * cos(fi * p.x + t * 0.23 + 0.5 * fi));
  }
  return sin(p.x) * cos(p.y);
}
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y * 2.6;
  float t = u_time;
  const float e = 0.01;
  float h = chromeField(p, t);
  float hx = chromeField(p + vec2(e, 0.0), t);
  float hy = chromeField(p + vec2(0.0, e), t);
  vec3 n = normalize(vec3((h - hx) / e * 0.35, (h - hy) / e * 0.35, 1.0));
  vec3 r = reflect(vec3(0.0, 0.0, -1.0), n);

  float sky = r.y * 0.5 + 0.5;
  vec3 env = mix(u_bg * 0.4, u_bg2 * 1.4 + vec3(0.05), smoothstep(0.25, 0.85, sky));
  env += vec3(0.5) * smoothstep(0.035, 0.0, abs(r.y - 0.12)) * 0.6;
  env += u_a1 * smoothstep(0.6, 1.0, sky) * 0.35;

  float fres = clamp((1.0 - n.z) * 3.0, 0.0, 1.0);
  vec3 film = 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + h * 0.5 + fres * 1.1));
  vec3 tint = mix(u_a1, u_a2, film.x);
  vec3 col = env * mix(vec3(0.9), tint * 1.7 + 0.1, 0.45 + 0.35 * fres);
  float spec = pow(max(dot(r, normalize(vec3(-0.4, 0.6, 0.7))), 0.0), 48.0);
  col += spec * 0.9 + saturation(film, 0.7) * fres * 0.12;

  col *= vignette(uv, 0.55);
  fragColor = finish(col, gl_FragCoord.xy, 0.008);
}
`,
  },
  {
    id: "nebula",
    name: "Nebula",
    theme: "nebula",
    nodes: ["noise3", "stars", "vignette", "finish"],
    scale: 0.4,
    main: `
float density(vec3 q) {
  // Large-scale mask first, so whole regions are empty sky and the cloud has
  // a shape; detail octaves only sculpt what the mask lets through.
  float mask = smoothstep(0.28, 0.62, vnoise3(q * 0.33 + 11.0));
  float d = vnoise3(q * 1.1) * 0.55 + vnoise3(q * 2.6 + 3.1) * 0.3 + vnoise3(q * 5.9 + 1.7) * 0.15;
  return smoothstep(0.42, 0.85, d) * mask;
}
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  float t = u_time * 0.04;
  vec3 ro = vec3(t * 0.6, t * 0.25, t);
  vec3 rd = normalize(vec3(p, 1.3));

  vec3 col = u_bg * 0.5 + stars(p * 26.0 + 3.0, 0.8, u_time) * vec3(0.85, 0.9, 1.0) * 1.3;
  vec3 acc = vec3(0.0);
  float alpha = 0.0;
  // Jittered start: ten steps with a per-pixel offset read as smooth volume,
  // ten aligned steps read as ten stacked slices.
  float z = 0.4 + hash12(gl_FragCoord.xy) * 0.34;
  for (int i = 0; i < 10; i++) {
    if (alpha > 0.95) break;
    vec3 q = ro + rd * z;
    float d = density(q);
    if (d > 0.001) {
      // Hue drifts across the volume on a cheap large-scale wave, so both
      // accents appear without another noise lookup per step.
      float hue = 0.5 + 0.5 * sin(q.x * 1.4 + q.y * 0.9 - q.z * 0.7);
      vec3 emit = mix(u_a1, u_a2, smoothstep(0.2, 0.8, hue));
      emit = mix(emit, vec3(1.0), smoothstep(0.6, 1.0, d) * 0.35);
      float a = d * 0.42;
      acc += (1.0 - alpha) * a * emit * 2.1;
      alpha += (1.0 - alpha) * a;
    }
    z += 0.34;
  }
  col = col * (1.0 - alpha) + acc;
  col *= vignette(uv, 0.6);
  fragColor = finish(col, gl_FragCoord.xy, 0.007);
}
`,
  },
  {
    id: "biolume",
    name: "Bioluminescence",
    theme: "biolume",
    nodes: ["fbm", "hash", "vignette", "finish"],
    scale: 0.5,
    main: `
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  float asp = u_res.x / u_res.y;
  vec2 p = vec2(uv.x * asp, uv.y);
  float t = u_time;

  vec3 col = mix(u_bg * 0.35, u_bg2 * 1.1, pow(uv.y, 1.6));
  vec2 lp = vec2(0.5 * asp + 0.25 * sin(t * 0.04), 1.35);
  vec2 dv = p - lp;
  float ang = atan(dv.x, -dv.y);
  float rays = fbm(vec2(ang * 7.0, t * 0.06), 3) + 0.5;
  rays = pow(clamp(rays, 0.0, 1.0), 3.0) * smoothstep(0.05, 1.0, uv.y);
  col += (u_bg2 * 0.9 + u_a2 * 0.06) * rays * 0.9;

  for (int L = 0; L < 3; L++) {
    float fl = float(L);
    float sc = 6.0 + fl * 5.0;
    vec2 q = p * sc + vec2(fl * 13.1, -t * (0.05 + 0.03 * fl) * sc * 0.25);
    vec2 ci = floor(q);
    vec2 f = fract(q) - 0.5;
    vec2 h = hash22(ci + fl * 7.0);
    vec2 o = (h - 0.5) * 0.55 + 0.12 * vec2(sin(t * 0.5 + h.x * 6.28), cos(t * 0.43 + h.y * 6.28));
    float d = length(f - o);
    float pulse = 0.5 + 0.5 * sin(t * (0.6 + h.y) + h.x * 20.0);
    float on = step(0.62, h.y);
    float core = smoothstep(0.045, 0.0, d) + 0.35 * exp(-d * 10.0);
    vec3 c = mix(u_a1, u_a2, step(0.72, h.x));
    col += c * on * pulse * core * (1.1 / (1.0 + fl * 0.9));
  }
  vec2 sq = p * 42.0 + vec2(0.0, -t * 0.6);
  vec2 sh = hash22(floor(sq));
  float snow = step(0.93, sh.x) * smoothstep(0.08, 0.0, length(fract(sq) - 0.5 - (sh - 0.5) * 0.6));
  col += vec3(0.5, 0.6, 0.65) * snow * 0.18;

  col *= vignette(uv, 0.7);
  fragColor = finish(col, gl_FragCoord.xy, 0.012);
}
`,
  },
  {
    id: "silk",
    name: "Soft Silk",
    theme: "silk",
    nodes: ["noise", "palette", "finish"],
    scale: 0.5,
    main: `
void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  float t = u_time * 0.12;
  vec2 w = p + 0.3 * vec2(gnoise(p * 1.1 + t * 0.4), gnoise(p * 1.1 + vec2(5.3, 1.1) - t * 0.3));

  // Softened accents: a gradient mesh is pastel on light themes and deep on dark ones.
  vec3 a1 = mix(u_a1 * 0.8, mix(u_a1, vec3(1.0), 0.22), 1.0 - u_dark);
  vec3 a2 = mix(u_a2 * 0.8, mix(u_a2, vec3(1.0), 0.22), 1.0 - u_dark);
  vec3 cols[5] = vec3[5](u_bg2, a1, a2, mix(a1, a2, 0.5), u_bg);
  vec2 pts[5] = vec2[5](
    vec2(-0.7 + 0.25 * sin(t * 0.9), 0.3 + 0.2 * cos(t * 0.7)),
    vec2(0.55 + 0.2 * cos(t * 0.8), 0.35 + 0.15 * sin(t * 1.1)),
    vec2(-0.2 + 0.3 * sin(t * 0.6 + 2.0), -0.35 + 0.15 * cos(t * 0.9)),
    vec2(0.75 + 0.2 * sin(t * 0.7 + 1.0), -0.4 + 0.2 * cos(t * 0.5)),
    vec2(0.0 + 0.4 * cos(t * 0.4), 0.05 + 0.3 * sin(t * 0.5 + 1.0))
  );
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 5; i++) {
    vec2 d = w - pts[i];
    // A steep falloff keeps each colour's own territory; a shallow one
    // averages the five into grey.
    float wi = 1.0 / (pow(dot(d, d), 1.9) + 0.002);
    acc += cols[i] * wi;
    wsum += wi;
  }
  vec3 col = acc / wsum;
  float sheen = smoothstep(0.35, 0.0, abs(w.x * 0.6 + w.y - 0.2 + 0.15 * sin(t))) * 0.06;
  col += sheen * mix(vec3(0.6), vec3(1.0), 1.0 - u_dark);
  fragColor = finish(col, gl_FragCoord.xy, 0.02);
}
`,
  },
  {
    id: "contours",
    name: "Contour Lines",
    theme: "survey",
    nodes: ["fbm", "noise", "vignette", "finish"],
    scale: 1,
    main: `
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y * 1.8;
  float t = u_time * 0.025;
  float h = fbm(p + vec2(t, -t * 0.6), 4) * 1.3 + 0.5 + 0.2 * gnoise(p * 0.35 - t);

  float v = h * 16.0;
  float fw = max(fwidth(v), 1e-4);
  float line = 1.0 - smoothstep(fw * 0.5, fw * 1.5, abs(fract(v + 0.5) - 0.5));
  float vm = v / 5.0;
  float major = 1.0 - smoothstep(fw * 0.7, fw * 2.0, abs(fract(vm + 0.5) - 0.5) * 5.0);

  vec2 g = vec2(dFdx(h), dFdy(h)) * u_res.y;
  float shade = dot(normalize(vec3(-g * 1.5, 1.0)), normalize(vec3(-0.5, 0.6, 0.65)));
  vec3 base = mix(u_bg, u_bg2, smoothstep(0.15, 0.85, h));
  base *= 0.9 + 0.2 * shade;

  vec3 col = mix(base, u_a2, line * 0.32);
  col = mix(col, u_a1, major * 0.75);
  col *= mix(vignette(uv, 0.3), 1.0, 1.0 - u_dark);
  fragColor = finish(col, gl_FragCoord.xy, 0.006);
}
`,
  },
  {
    id: "horizon",
    name: "Synth Horizon",
    theme: "dusk",
    nodes: ["fbm", "vignette", "finish"],
    scale: 1,
    main: `
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  float t = u_time;
  float y0 = -0.08;

  vec3 col = mix(u_a2 * 0.32 + u_bg2 * 0.7, u_bg * 0.5, smoothstep(y0, 0.55, p.y));
  vec2 c = vec2(0.0, y0 + 0.19);
  float r = 0.26;
  float d = length(p - c);
  float aa = 1.5 / u_res.y;
  vec3 sunCol = mix(u_a2, u_a1, smoothstep(c.y - r, c.y + r, p.y));
  float below = clamp((c.y - p.y) / r, 0.0, 1.0);
  float cut = step(fract((p.y - c.y) * 16.0 + t * 0.15), below * 0.55) * step(p.y, c.y);
  float sun = smoothstep(r, r - aa, d) * (1.0 - cut);
  col += u_a1 * exp(-max(d - r, 0.0) * 5.0) * 0.28;
  col = mix(col, sunCol * 1.1, sun);

  float ridge = y0 + (0.035 + 0.12 * (fbm(vec2(p.x * 2.4, 4.0), 4) + 0.35)) * smoothstep(0.08, 0.7, abs(p.x));
  float mtn = smoothstep(aa, -aa, p.y - ridge) * step(y0, p.y);
  col = mix(col, u_bg * 0.35 + u_a2 * 0.05, mtn);

  // Derivatives are taken OUTSIDE any branch: fwidth in non-uniform control
  // flow is undefined, and some drivers return garbage at the horizon edge.
  float depth = max(y0 - p.y, 1e-3);
  float z = 0.35 / depth;
  vec2 g = vec2(p.x * z * 1.6, z + t * 0.6);
  vec2 gw = fwidth(g);
  vec2 lines = 1.0 - smoothstep(gw * 0.6, gw * 1.6, abs(fract(g + 0.5) - 0.5));
  float grid = max(lines.x, lines.y) * smoothstep(0.02, 0.2, depth * 10.0);
  float fog = exp(-z * 0.12);
  vec3 floorCol = u_bg * 0.3 + u_a2 * 0.04;
  floorCol += u_a1 * grid * 0.55 * fog;
  floorCol += u_a1 * 0.18 * exp(-depth * 18.0) + sunCol * 0.1 * exp(-abs(p.x) * 4.0) * exp(-depth * 8.0);
  col = mix(col, floorCol, step(p.y, y0));
  col += u_a2 * 0.12 * exp(-abs(p.y - y0) * 40.0);
  col *= vignette(uv, 0.45);
  fragColor = finish(col, gl_FragCoord.xy, 0.01);
}
`,
  },
  {
    id: "ink",
    name: "Ink in Water",
    theme: "sumi",
    nodes: ["warp", "vignette", "finish"],
    scale: 0.45,
    main: `
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y * 1.7;
  vec2 q, r;
  float f = warped(p, u_time * 0.5, 4, q, r);
  float field = f + 0.35 * length(q) - 0.05;
  float dens = smoothstep(-0.12, 0.32, field);
  float wash = smoothstep(-0.4, 0.2, field) * 0.22;
  float fil = smoothstep(0.03, 0.0, abs(f - 0.1)) * smoothstep(0.1, 0.5, length(r));
  vec3 dye = mix(u_a1, u_a2, smoothstep(0.35, 0.7, length(r) + 0.35 * q.y));
  vec3 water = mix(u_bg, u_bg2, uv.y * 0.7 + 0.15 * q.x);
  vec3 col = mix(water, dye, wash);
  col = mix(col, dye * mix(1.0, 0.9, u_dark), dens * dens * 0.78);
  col = mix(col, mix(dye * 1.4, dye * 0.6, 1.0 - u_dark), fil * 0.35);
  col *= mix(vignette(uv, 0.5), 1.0, (1.0 - u_dark) * 0.7);
  fragColor = finish(col, gl_FragCoord.xy, 0.014);
}
`,
  },
];

export const SHADER_WALLPAPER_IDS: readonly string[] = SHADER_RECIPES.map((r) => r.id);

export function isShaderWallpaper(id: string): boolean {
  return SHADER_WALLPAPER_IDS.includes(id);
}

export function shaderRecipe(id: string): ShaderRecipe | undefined {
  return SHADER_RECIPES.find((r) => r.id === id);
}

/* ── Graph ────────────────────────────────────────────────────────────────── */

/** Topological order of `ids` plus everything they depend on, each once.
 *  Throws on an unknown node or a cycle: both are authoring errors that should
 *  fail a test, not produce a shader that fails to compile on someone's GPU. */
export function resolveNodes(ids: readonly string[], nodes: Record<string, ShaderNode> = SHADER_NODES): string[] {
  const out: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, path: string[]) => {
    const s = state.get(id);
    if (s === "done") return;
    if (s === "visiting") throw new Error(`shader node cycle: ${[...path, id].join(" -> ")}`);
    const node = nodes[id];
    if (!node) throw new Error(`unknown shader node "${id}"${path.length ? ` (needed by ${path[path.length - 1]})` : ""}`);
    state.set(id, "visiting");
    for (const d of node.deps) visit(d, [...path, id]);
    state.set(id, "done");
    out.push(id);
  };
  for (const id of ids) visit(id, []);
  return out;
}

/** The full fragment shader for a recipe. */
export function composeFragment(recipe: Pick<ShaderRecipe, "nodes" | "main">, nodes: Record<string, ShaderNode> = SHADER_NODES): string {
  const order = resolveNodes(recipe.nodes, nodes);
  return HEADER + order.map((id) => `// node: ${id}${nodes[id].glsl}`).join("") + recipe.main;
}

/* ── Colour and sizing ────────────────────────────────────────────────────── */

/** A CSS colour token (#rgb, #rrggbb, rgb()/rgba() in either syntax) as
 *  LINEAR-light 0..1 floats. Unparseable input gives black rather than NaN,
 *  which would poison every pixel of the shader. */
export function hexToLinear(css: string): [number, number, number] {
  const s = css.trim();
  let rgb: [number, number, number] | null = null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const full = hex[1].length === 3 ? hex[1].split("").map((c) => c + c).join("") : hex[1];
    const n = parseInt(full, 16);
    rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  } else {
    const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
    if (fn) rgb = [Number(fn[1]), Number(fn[2]), Number(fn[3])];
  }
  if (!rgb || rgb.some((v) => !Number.isFinite(v))) return [0, 0, 0];
  return rgb.map((v) => {
    const x = Math.min(255, Math.max(0, v)) / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
}

/** Relative luminance of an already-linear colour. */
export function linearLuminance(c: readonly [number, number, number]): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** Backing-store size for a canvas of `cssW` x `cssH` CSS pixels.
 *
 *  devicePixelRatio is capped (three.js apps cap at 2; a wallpaper does not
 *  need even that), then scaled by the recipe's render scale, then clamped to a
 *  pixel budget so a 6K display costs no more than a 1440p one. Never zero —
 *  a zero-sized drawing buffer is a GL error, not an empty picture. */
export function backingSize(
  cssW: number,
  cssH: number,
  dpr: number,
  scale: number,
  opts: { maxDpr?: number; maxPixels?: number } = {},
): { width: number; height: number } {
  const maxDpr = opts.maxDpr ?? 1.5;
  const maxPixels = opts.maxPixels ?? 1_600_000;
  const d = Math.min(Number.isFinite(dpr) && dpr > 0 ? dpr : 1, maxDpr) * Math.max(0.1, scale);
  let w = Math.max(0, cssW) * d;
  let h = Math.max(0, cssH) * d;
  if (w * h > maxPixels) {
    const k = Math.sqrt(maxPixels / (w * h));
    w *= k;
    h *= k;
  }
  return { width: Math.max(1, Math.floor(w)), height: Math.max(1, Math.floor(h)) };
}
