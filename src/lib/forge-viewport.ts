import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { buildScene, disposeScene, framingFor, type BuiltScene, type SceneDoc } from "./forge-scene";

/* ────────────────────────────────────────────────────────────────────────────
   The Forge viewport.

   A plain class rather than a React component, for the same reason the old
   render loop read refs: this runs at 120fps and must not care what React is
   doing. The app hands it a scene document and it draws; nothing in here ever
   triggers a render.

   What the GPU buys beyond the obvious: a real depth test, so a river lying on
   a ground plane stays visible from every angle instead of disappearing when
   the centroids happen to sort the wrong way; soft shadows, which are most of
   what tells you an object is sitting on the ground rather than floating above
   it; and filmic tone mapping, so a bright key light rolls off instead of
   clipping to flat white.
   ──────────────────────────────────────────────────────────────────────────── */

export interface ViewportOptions {
  onFps?: (fps: number) => void;
  onSelect?: (entityId: string | null) => void;
}

export class ForgeViewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;

  private built: BuiltScene | null = null;
  private doc: SceneDoc | null = null;
  private grid: THREE.GridHelper;
  private selection: THREE.BoxHelper;
  private raf = 0;
  private last = performance.now();
  private frames = 0;
  private fpsClock = this.last;
  private selectedId: string | null = null;
  private resizeObserver: ResizeObserver;
  private disposed = false;

  constructor(private canvas: HTMLCanvasElement, private opts: ViewportOptions = {}) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      // The vision review reads pixels back out of this canvas. Without it the
      // buffer is undefined by the time toDataURL runs and the capture comes
      // back blank or black.
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
    this.camera.position.set(14, 11, 16);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 1.2;
    this.controls.maxDistance = 400;
    // Stop just short of the horizon: orbiting under the ground plane is
    // always an accident, never a shot anyone wanted.
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.target.set(0, 1, 0);

    this.grid = new THREE.GridHelper(120, 120, 0xffffff, 0xffffff);
    const gm = this.grid.material as THREE.Material;
    gm.opacity = 0.07;
    gm.transparent = true;
    this.grid.position.y = -0.002; // under the ground so it never z-fights
    this.scene.add(this.grid);

    this.selection = new THREE.BoxHelper(new THREE.Object3D(), 0x67e8f9);
    this.selection.visible = false;
    this.scene.add(this.selection);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    canvas.addEventListener("pointerdown", this.onPointerDown);

    this.resize();
    this.loop();
  }

  /* ── Scene document ─────────────────────────────────────────────────── */

  setScene(doc: SceneDoc, opts: { reframe?: boolean } = {}) {
    const first = this.doc === null;
    this.doc = doc;
    if (this.built) {
      this.scene.remove(this.built.root);
      disposeScene(this.built);
    }
    this.built = buildScene(doc);
    this.scene.add(this.built.root);

    this.scene.background = new THREE.Color(doc.sky || "#0b1a2e");
    // Fog tied to the sky colour: the horizon fades into the sky instead of
    // ending in a hard line, which is most of what makes a scene feel big.
    this.scene.fog = doc.fog === 0 ? null : new THREE.Fog(doc.sky || "#0b1a2e", 60, doc.fog || 260);

    this.applySelection();
    if (first || opts.reframe) this.frameScene();
  }

  frameScene() {
    if (!this.built) return;
    const { target, distance } = framingFor(this.built.focus);
    this.controls.target.copy(target);
    // A three-quarter view from above: the angle that reads a layout best.
    const dir = new THREE.Vector3(0.82, 0.62, 1).normalize();
    this.camera.position.copy(target).addScaledVector(dir, distance);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  select(entityId: string | null) {
    this.selectedId = entityId;
    this.applySelection();
  }

  private applySelection() {
    const group = this.built?.entities.children.find((c) => c.userData.entityId === this.selectedId);
    if (group) {
      this.selection.setFromObject(group);
      this.selection.visible = true;
    } else {
      this.selection.visible = false;
    }
  }

  /* ── Picking ────────────────────────────────────────────────────────── */

  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private downAt = { x: 0, y: 0 };

  private onPointerDown = (e: PointerEvent) => {
    this.downAt = { x: e.clientX, y: e.clientY };
    const up = (ue: PointerEvent) => {
      this.canvas.removeEventListener("pointerup", up);
      // Only a tap selects. An orbit that happens to end over an object must
      // not change the selection out from under you.
      if (Math.abs(ue.clientX - this.downAt.x) + Math.abs(ue.clientY - this.downAt.y) > 5) return;
      this.pick(ue);
    };
    this.canvas.addEventListener("pointerup", up);
  };

  private pick(e: PointerEvent) {
    if (!this.built || !this.opts.onSelect) return;
    const r = this.canvas.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.built.entities, true);
    if (!hits.length) { this.opts.onSelect(null); return; }
    // Walk up to the entity group — a hit lands on a part.
    let o: THREE.Object3D | null = hits[0].object;
    while (o && o.userData.entityId === undefined) o = o.parent;
    this.opts.onSelect((o?.userData.entityId as string) ?? null);
  }

  /* ── Frame loop ─────────────────────────────────────────────────────── */

  private resize() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private loop = () => {
    if (this.disposed) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.frames++;
    if (now - this.fpsClock > 500) {
      this.opts.onFps?.(Math.round((this.frames * 1000) / (now - this.fpsClock)));
      this.frames = 0;
      this.fpsClock = now;
    }

    if (this.built && this.doc) {
      const fx = this.doc.fx ?? [];
      this.built.fields.forEach((field, i) => { if (fx[i]) field.update(fx[i], dt); });
    }
    if (this.selection.visible) this.selection.update();

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.raf = requestAnimationFrame(this.loop);
  };

  /* ── Capture ────────────────────────────────────────────────────────── */

  /** The viewport as a PNG for a vision model.
   *
   *  Rendered immediately before the read so the buffer is guaranteed current,
   *  and downscaled because image tokens scale with area and nothing here
   *  carries detail past ~1024px. */
  capture(max = 1024): string | null {
    try {
      this.renderer.render(this.scene, this.camera);
      const src = this.renderer.domElement;
      const scale = Math.min(1, max / Math.max(src.width, src.height));
      if (scale >= 1) return src.toDataURL("image/png");
      const off = document.createElement("canvas");
      off.width = Math.round(src.width * scale);
      off.height = Math.round(src.height * scale);
      const g = off.getContext("2d");
      if (!g) return src.toDataURL("image/png");
      g.drawImage(src, 0, 0, off.width, off.height);
      return off.toDataURL("image/png");
    } catch {
      return null;
    }
  }

  setGridVisible(v: boolean) { this.grid.visible = v; }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.controls.dispose();
    if (this.built) disposeScene(this.built);
    this.renderer.dispose();
  }
}
