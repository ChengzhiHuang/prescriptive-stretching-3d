import * as THREE from 'three';
import type { FascicleSpec } from './types';

interface SurfaceRegion {
  // Limb names refer to the target side. Directions are in right-side bind coordinates.
  bones: string[];
  outward: [number, number, number];
}
const upperTorso = ['thoracic', 'clavicle'];
const upperBack = [...upperTorso, 'neck', 'shoulder'];
const hip = ['pelvis', 'hip', 'lumbar'];
const thigh = ['pelvis', 'hip', 'knee'];
const calf = ['hip', 'knee', 'ankle'];
const regions = {
  nape: { bones: [...upperBack, 'head'], outward: [-0.45, 0.2, -1] },
  frontNeck: { bones: [...upperTorso, 'neck', 'head'], outward: [-0.8, 0, 0.65] },
  occipital: { bones: ['head', 'neck', 'thoracic'], outward: [0, 0, -1] },
  chest: { bones: [...upperTorso, 'shoulder'], outward: [-0.15, 0, 1] },
  scapula: { bones: upperBack, outward: [-0.2, 0, -1] },
  shoulderTop: { bones: upperBack, outward: [-0.45, 1, -0.55] },
  back: { bones: [...upperBack, 'lumbar', 'pelvis'], outward: [-0.5, 0, -1] },
  waist: { bones: ['lumbar', 'thoracic', 'pelvis'], outward: [-0.65, 0, -1] },
  buttock: { bones: hip, outward: [-0.65, 0, -1] },
  hipFront: { bones: [...hip, 'thoracic'], outward: [-0.3, 0, 1] },
  thighFront: { bones: thigh, outward: [0, 0, 1] },
  thighSide: { bones: thigh, outward: [-1, 0, 0.1] },
  thighBack: { bones: thigh, outward: [0, 0, -1] },
  innerThigh: { bones: thigh, outward: [0.8, 0, 0.6] },
  calfBack: { bones: calf, outward: [0, 0, -1] },
  shin: { bones: ['knee', 'ankle'], outward: [-0.35, 0, 1] },
  upperArmFront: { bones: ['shoulder', 'elbow'], outward: [-0.35, 0, 1] },
  upperArmBack: { bones: ['shoulder', 'elbow'], outward: [-0.35, 0, -1] },
  forearmPalm: { bones: ['shoulder', 'elbow', 'wrist'], outward: [0.25, 0, 1] },
  forearmBack: { bones: ['shoulder', 'elbow', 'wrist'], outward: [-0.25, 0, -1] },
} satisfies Record<string, SurfaceRegion>;
export type WindowLocation = `${keyof typeof regions}${'R' | 'L'}`;

/** Bound skin regions stay on the same tissue as joints cross or fingers curl. */
export class AnatomicalWindow {
  private readonly points: THREE.Vector3[];
  private readonly normals: THREE.Vector3[];
  private readonly owners: string[];
  private readonly neighbors: number[][];
  private readonly cache = new WeakMap<FascicleSpec[], Uint8Array>();
  readonly attribute: THREE.Uint8BufferAttribute;

  constructor(geometry: THREE.BufferGeometry, bones: string[]) {
    const { position, normal, skinIndex, skinWeight } = geometry.attributes;
    this.points = Array.from({ length: position.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(position, i));
    this.normals = this.points.map((_, i) => new THREE.Vector3().fromBufferAttribute(normal, i));
    this.owners = this.points.map((_, i) => {
      let largest = 0;
      for (let j = 1; j < 4; j++) if (skinWeight.getComponent(i, j) > skinWeight.getComponent(i, largest)) largest = j;
      return bones[skinIndex.getComponent(i, largest)];
    });
    this.neighbors = this.points.map(() => []);
    const faces = geometry.getIndex()!;
    for (let i = 0; i < faces.count; i += 3) {
      const a = faces.getX(i), b = faces.getX(i + 1), c = faces.getX(i + 2);
      this.neighbors[a].push(b, c);
      this.neighbors[b].push(a, c);
      this.neighbors[c].push(a, b);
    }
    this.attribute = new THREE.Uint8BufferAttribute(position.count, 1, true);
    geometry.setAttribute('muscleWindow', this.attribute);
  }

  select(fascicles: FascicleSpec[], bindPosition: (name: string) => THREE.Vector3): void {
    let mask = this.cache.get(fascicles);
    if (!mask) {
      mask = new Uint8Array(this.points.length);
      for (const f of fascicles) {
        if (f.role === 'synergist' || f.role === 'nerve') continue;
        const path = [f.origin, ...(f.via ?? []), f.insertion].map(bindPosition);
        this.addBundle(mask, f, path);
      }
      this.cache.set(fascicles, mask);
    }
    this.attribute.array.set(mask);
    this.attribute.needsUpdate = true;
  }

  private addBundle(mask: Uint8Array, fascicle: FascicleSpec, path: THREE.Vector3[]): void {
    const side = fascicle.window.slice(-1);
    const region = regions[fascicle.window.slice(0, -1) as keyof typeof regions];
    const direction = new THREE.Vector3(...region.outward).normalize();
    const sign = side === 'L' ? 1 : -1;
    direction.x *= -sign;
    const bones = new Set(region.bones.flatMap(name => [name, name + side]));
    const segments = path.slice(1).map((p, i) => new THREE.Line3(path[i], p));
    const delta = new THREE.Vector3();
    const influence = new Uint8Array(mask.length);
    const radius = 0.052 + 2.6 * fascicle.radius;
    for (let i = 0; i < influence.length; i++) {
      const p = this.points[i];
      if (!bones.has(this.owners[i]) || sign * p.x < -0.001) continue;
      const facing = this.normals[i].dot(direction);
      if (facing < -0.22) continue;
      let nearest = Infinity;
      for (const line of segments) {
        line.closestPointToPoint(p, true, delta).sub(p);
        // Deep targets project onto the outward-facing skin, with a narrow lateral margin.
        const depth = delta.dot(direction);
        nearest = Math.min(nearest, Math.sqrt(Math.max(0, delta.lengthSq() - 0.67 * depth * depth)));
      }
      const weight = (1 - THREE.MathUtils.smoothstep(nearest, radius * 0.6, radius)) *
        THREE.MathUtils.smoothstep(facing, -0.22, 0.13);
      influence[i] = Math.round(255 * weight);
    }
    // Keep the connected skin patch with the greatest coverage. Nearby disconnected
    // triangles (e.g. the opposite face of a flexor surface) cannot open a window.
    let best: number[] = [], bestWeight = 0;
    const visited = new Uint8Array(mask.length);
    for (let root = 0; root < influence.length; root++) {
      if (!influence[root] || visited[root]) continue;
      const patch = [root];
      visited[root] = 1;
      let total = 0;
      for (let j = 0; j < patch.length; j++) {
        const i = patch[j];
        total += influence[i];
        for (const n of this.neighbors[i]) {
          if (influence[n] && !visited[n]) { visited[n] = 1; patch.push(n); }
        }
      }
      if (total > bestWeight) { bestWeight = total; best = patch; }
    }
    for (const i of best) mask[i] = Math.max(mask[i], influence[i]);
  }
}
