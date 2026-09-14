import * as THREE from "three";
import { buildEntity, type ScenePart } from "./forge-scene";

/* ────────────────────────────────────────────────────────────────────────────
   Asset thumbnails, rendered with the same engine as the viewport.

   One WebGL context for the whole library, not one per card. A browser caps
   you at roughly sixteen live contexts and then starts silently killing the
   oldest, so a grid of thirty assets each with its own canvas loses half its
   previews and there is no error to tell you why.

   So: render offscreen, read a PNG, hand back a data URL, reuse the context.
   Results are cached on the asset's id and mtime, which means scrolling a
   library costs nothing after the first pass.
   ──────────────────────────────────────────────────────────────────────────── */

let renderer: THREE.WebGLRenderer | null = null;
const cache = new Map<string, string>();

function getRenderer(size: number): THREE.WebGLRenderer | null {
  if (typeof document === "undefined") return null;
  if (!renderer) {
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.1;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
    } catch {
      return null; // no WebGL — callers fall back to an icon
    }
  }
  renderer.setSize(size, size, false);
  return renderer;
}

export interface ThumbAsset {
  id: string;
  updatedAt?: number;
  parts: ScenePart[];
}

/** Render one asset to a PNG data URL. Returns null if WebGL is unavailable. */
export function renderThumbnail(asset: ThumbAsset, size = 256): string | null {
  const key = `${asset.id}:${asset.updatedAt ?? 0}:${size}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const r = getRenderer(size);
  if (!r || !asset.parts?.length) return null;

  const scene = new THREE.Scene();
  const group = buildEntity({
    id: asset.id, name: "thumb",
    position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
    visible: true, parts: asset.parts,
  });
  scene.add(group);

  // A three-point-ish rig: warm key, cool fill, sky bounce. Enough to read
  // form and material without inventing a colour the asset does not have.
  const key1 = new THREE.DirectionalLight(0xfff2dd, 2.1);
  key1.position.set(-4, 6, 5);
  key1.castShadow = true;
  key1.shadow.mapSize.set(1024, 1024);
  key1.shadow.camera.near = 0.5;
  key1.shadow.camera.far = 40;
  const fill = new THREE.DirectionalLight(0x9cc4ff, 0.7);
  fill.position.set(5, 2, -4);
  scene.add(key1, fill, new THREE.HemisphereLight(0xbcd8ff, 0x33302e, 1.1));

  // A shadow catcher, so an asset sits on something instead of floating.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60).rotateX(-Math.PI / 2),
    new THREE.ShadowMaterial({ opacity: 0.28 }),
  );
  ground.receiveShadow = true;
  scene.add(ground);

  // Frame by the actual bounds, so a four-metre lamp post and a crate both
  // fill the card instead of one of them rendering as a speck.
  const box = new THREE.Box3().setFromObject(group);
  const sizeV = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(sizeV.x, sizeV.y, sizeV.z, 0.4) * 0.5;

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
  const dir = new THREE.Vector3(0.9, 0.55, 1.15).normalize();
  camera.position.copy(center).addScaledVector(dir, radius * 3.5 + 1.2);
  camera.lookAt(center);

  r.render(scene, camera);
  const url = r.domElement.toDataURL("image/png");

  scene.clear();
  ground.geometry.dispose();
  (ground.material as THREE.Material).dispose();

  // Bounded so a long session cannot grow the cache without limit.
  if (cache.size > 200) cache.clear();
  cache.set(key, url);
  return url;
}

/** Drop cached renders, e.g. after editing an asset in place. */
export function invalidateThumbnail(assetId: string) {
  for (const k of [...cache.keys()]) if (k.startsWith(`${assetId}:`)) cache.delete(k);
}
