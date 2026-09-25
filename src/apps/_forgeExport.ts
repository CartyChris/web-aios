"use client";

import * as THREE from "three";
import { buildEntity, type SceneDoc } from "@/lib/forge-scene";

/* Scene export in formats other tools open: binary glTF (.glb) for engines
 * and viewers, Wavefront OBJ for everything older. Built from the document
 * with the same buildEntity the viewport uses, so what is exported is what
 * was on screen — minus the lights, sky and particles, which OBJ cannot hold
 * and which the JSON export already keeps. The exporters ship inside the
 * three package and are loaded only when someone exports. */

export type MeshFormat = "glb" | "obj";

export interface MeshExport {
  blob: Blob;
  filename: string;
  meshes: number;
  bytes: number;
}

export async function exportMeshes(doc: SceneDoc, name: string, format: MeshFormat, only?: string[]): Promise<MeshExport> {
  const root = new THREE.Group();
  root.name = name || "scene";
  let meshes = 0;
  for (const e of doc.entities) {
    if (e.visible === false) continue;
    if (only && !only.includes(e.id)) continue;
    const g = buildEntity(e);
    g.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes++; });
    root.add(g);
  }
  if (!meshes) throw new Error("Nothing visible to export.");
  root.updateMatrixWorld(true);

  const base = (name || "scene").replace(/[^\w -]/g, "").trim().replace(/\s+/g, "_") || "scene";
  try {
    if (format === "obj") {
      const { OBJExporter } = await import("three/examples/jsm/exporters/OBJExporter.js");
      const text = new OBJExporter().parse(root);
      const blob = new Blob([text], { type: "text/plain" });
      return { blob, filename: `${base}.obj`, meshes, bytes: blob.size };
    }
    const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
    const out = await new GLTFExporter().parseAsync(root, { binary: true });
    const blob = new Blob([out as ArrayBuffer], { type: "model/gltf-binary" });
    return { blob, filename: `${base}.glb`, meshes, bytes: blob.size };
  } finally {
    // Materials are per mesh; geometries may be shared with the viewport's
    // cache, so they are left alone.
    root.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m?.dispose();
    });
  }
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
