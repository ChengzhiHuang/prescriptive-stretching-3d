// Signed hand-to-scalp clearance on the deformed GLB. The head patch is open at
// the neck, so classify a point as inside only if both lateral rays cross it.
import { Box3, Ray, Triangle, Vector3 } from 'three';

export function vertexRegions(mesh) {
  const { skinIndex, skinWeight } = mesh.geometry.attributes;
  const regions = new Map();
  for (let i = 0; i < skinIndex.count; i++) {
    let strongest = 0;
    for (let j = 1; j < 4; j++) {
      if (skinWeight.getComponent(i, j) > skinWeight.getComponent(i, strongest)) strongest = j;
    }
    const name = mesh.skeleton.bones[skinIndex.getComponent(i, strongest)].name;
    if (!regions.has(name)) regions.set(name, []);
    regions.get(name).push(i);
  }
  return regions;
}

export function boxClearance(point, box) {
  const x = Math.max(box.min.x - point.x, point.x - box.max.x);
  const y = Math.max(box.min.y - point.y, point.y - box.max.y);
  const z = Math.max(box.min.z - point.z, point.z - box.max.z);
  return Math.hypot(Math.max(x, 0), Math.max(y, 0), Math.max(z, 0)) + Math.min(0, Math.max(x, y, z));
}

export function scalpProbe(mesh, regions) {
  const head = new Set(regions.get('head'));
  const positions = new Map([...head].map(i => [i, new Vector3()]));
  const index = mesh.geometry.index.array;
  const triangles = [];
  for (let i = 0; i < index.length; i += 3) {
    const [a, b, c] = [index[i], index[i + 1], index[i + 2]].map(v => positions.get(v));
    if (a && b && c) triangles.push(new Triangle(a, b, c));
  }

  return (hand, stride = 1) => {
    const headBone = mesh.skeleton.bones.find(b => b.name === 'head');
    const worldToHead = headBone.matrixWorld.clone().invert().multiply(mesh.matrixWorld);
    const bounds = new Box3();
    for (const [i, p] of positions) {
      mesh.getVertexPosition(i, p).applyMatrix4(worldToHead);
      bounds.expandByPoint(p);
    }
    const bins = new Map();
    const cell = 0.02;
    const key = (y, z) => y * 1000 + z;
    for (const tri of triangles) {
      const { a, b, c } = tri;
      const yMax = Math.floor(Math.max(a.y, b.y, c.y) / cell);
      const zMax = Math.floor(Math.max(a.z, b.z, c.z) / cell);
      for (let y = Math.floor(Math.min(a.y, b.y, c.y) / cell); y <= yMax; y++) {
        for (let z = Math.floor(Math.min(a.z, b.z, c.z) / cell); z <= zMax; z++) {
          const k = key(y, z);
          if (!bins.has(k)) bins.set(k, []);
          bins.get(k).push(tri);
        }
      }
    }
    const ray = new Ray(new Vector3(), new Vector3(1, 0, 0));
    const back = new Ray(ray.origin, new Vector3(-1, 0, 0));
    const hit = new Vector3();
    let clearance = Infinity;
    for (let j = 0; j < hand.length; j += stride) {
      const p = mesh.getVertexPosition(hand[j], ray.origin).applyMatrix4(worldToHead);
      const bound = bounds.distanceToPoint(p);
      if (bound > 0 && bound >= clearance) continue;
      const y = Math.floor(p.y / cell), z = Math.floor(p.z / cell);
      let left = 0, right = 0;
      for (const t of bins.get(key(y, z)) ?? []) {
        if (ray.intersectTriangle(t.a, t.b, t.c, false, hit)) right++;
        if (back.intersectTriangle(t.a, t.b, t.c, false, hit)) left++;
      }
      const inside = (left % 2 === 1 && right % 2 === 1);
      if (!inside && clearance <= 0) continue;
      let d2 = Infinity;
      // Expand the neighborhood until all triangles potentially closer than the
      // current best have been considered, including very distant approach poses.
      for (let radius = 0; radius <= 32; radius++) {
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dz = -radius; dz <= radius; dz++) {
            if (Math.max(Math.abs(dy), Math.abs(dz)) !== radius) continue;
            for (const tri of bins.get(key(y + dy, z + dz)) ?? []) {
              d2 = Math.min(d2, tri.closestPointToPoint(p, hit).distanceToSquared(p));
            }
          }
        }
        if (radius * cell >= Math.sqrt(d2) || (!inside && radius * cell >= clearance)) break;
      }
      clearance = Math.min(clearance, (inside ? -1 : 1) * Math.sqrt(d2));
    }
    return clearance;
  };
}
