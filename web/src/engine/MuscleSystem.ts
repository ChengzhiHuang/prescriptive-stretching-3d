import * as THREE from 'three';
import type { HumanRig } from './HumanRig';
import type { FascicleSpec, PnfPhaseId } from './types';

interface FascicleRuntime {
  spec: FascicleSpec;
  mesh: THREE.Mesh;
  originPin: THREE.Mesh;
  insertionPin: THREE.Mesh;
  restLength: number;
  maxLength: number;
  currentLength: number;
}

const RADIAL_SEGMENTS = 12;
const TUBULAR_SEGMENTS = 28;

/**
 * Builds and updates 3D spindle-shaped anatomical muscle fascicles (with ivory tendons
 * at origin/insertion and dynamic tension-colored muscle bellies) between bone sockets.
 */
export class MuscleSystem {
  public readonly group = new THREE.Group();
  private items: FascicleRuntime[] = [];
  private tmpPts: THREE.Vector3[] = [];

  private readonly pinOriginMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
  private readonly pinInsertMat = new THREE.MeshBasicMaterial({ color: 0xfb7185 });

  public loadFascicles(specs: FascicleSpec[], rig: HumanRig): void {
    this.clear();
    for (const spec of specs) {
      const geo = this.createSpindleGeometry();
      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: spec.role === 'nerve' ? 0.35 : 0.42,
        metalness: 0.06,
      });
      const mesh = new THREE.Mesh(geo, mat);
      this.group.add(mesh);

      const pinGeo = new THREE.SphereGeometry(spec.role === 'nerve' ? 0.005 : 0.011, 10, 8);
      const originPin = new THREE.Mesh(pinGeo, this.pinOriginMat);
      const insertionPin = new THREE.Mesh(pinGeo, this.pinInsertMat);
      if (spec.role !== 'nerve') {
        this.group.add(originPin);
        this.group.add(insertionPin);
      }

      const len = this.measurePathLength(spec, rig);
      this.items.push({
        spec,
        mesh,
        originPin,
        insertionPin,
        restLength: len,
        maxLength: len * 1.18,
        currentLength: len,
      });
    }
  }

  public calibrateLengths(
    rig: HumanRig,
    setupLenMap: Record<string, number>,
    deepenLenMap: Record<string, number>
  ): void {
    for (const item of this.items) {
      const l0 = setupLenMap[item.spec.id] ?? item.restLength;
      const lMax = deepenLenMap[item.spec.id] ?? l0 * 1.16;
      item.restLength = l0;
      item.maxLength = Math.max(l0 + 0.015, lMax);
    }
    this.measureAll(rig);
  }

  public measureAll(rig: HumanRig): Record<string, number> {
    const out: Record<string, number> = {};
    for (const item of this.items) {
      const len = this.measurePathLength(item.spec, rig);
      item.currentLength = len;
      out[item.spec.id] = len;
    }
    return out;
  }

  private measurePathLength(spec: FascicleSpec, rig: HumanRig): number {
    const names = [spec.origin, ...(spec.via ?? []), spec.insertion];
    const pts = names.map((n) => rig.getSocketWorldPos(n, new THREE.Vector3()));
    let sum = 0;
    for (let i = 1; i < pts.length; i++) {
      sum += pts[i].distanceTo(pts[i - 1]);
    }
    return sum;
  }

  private createSpindleGeometry(): THREE.BufferGeometry {
    const vertCount = (TUBULAR_SEGMENTS + 1) * (RADIAL_SEGMENTS + 1);
    const positions = new Float32Array(vertCount * 3);
    const normals = new Float32Array(vertCount * 3);
    const colors = new Float32Array(vertCount * 3);
    const indices: number[] = [];

    for (let i = 0; i < TUBULAR_SEGMENTS; i++) {
      for (let j = 0; j < RADIAL_SEGMENTS; j++) {
        const a = i * (RADIAL_SEGMENTS + 1) + j;
        const b = (i + 1) * (RADIAL_SEGMENTS + 1) + j;
        const c = (i + 1) * (RADIAL_SEGMENTS + 1) + (j + 1);
        const d = i * (RADIAL_SEGMENTS + 1) + (j + 1);
        indices.push(a, b, d, b, c, d);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(indices);
    return geo;
  }

  /**
   * Updates muscle geometry and returns average primary-muscle strain (0..1+).
   */
  public update(
    rig: HumanRig,
    phase: PnfPhaseId,
    isMistake: boolean,
    elapsedSec: number
  ): { strainRatio: number; elongationPct: number } {
    let strainSum = 0;
    let primaryCount = 0;

    const tendonCol = new THREE.Color(0xf4efe6);
    const bellyCol = new THREE.Color();
    const tmpCol = new THREE.Color();

    for (const item of this.items) {
      const { spec, mesh, originPin, insertionPin } = item;
      const socketNames = [spec.origin, ...(spec.via ?? []), spec.insertion];
      this.tmpPts = socketNames.map((n) => rig.getSocketWorldPos(n, new THREE.Vector3()));

      originPin.position.copy(this.tmpPts[0]);
      insertionPin.position.copy(this.tmpPts[this.tmpPts.length - 1]);

      const curve = new THREE.CatmullRomCurve3(this.tmpPts, false, 'catmullrom', 0.35);
      const len = curve.getLength();
      item.currentLength = len;

      const rawStrain = THREE.MathUtils.clamp(
        (len - item.restLength) / Math.max(0.012, item.maxLength - item.restLength),
        0,
        1.25
      );

      let bellyBulge = 1.0;
      if (spec.role === 'nerve') {
        // Sciatic / brachial nerve cord: golden yellow, flashes orange if compressed in mistake mode
        if (isMistake) {
          const pulse = 0.5 + 0.5 * Math.sin(elapsedSec * 8.0);
          bellyCol.setRGB(0.98, 0.52 - 0.25 * pulse, 0.12);
        } else {
          bellyCol.setHex(0xfacc15);
        }
      } else if (isMistake) {
        // Slack / ineffective stretch color
        bellyCol.setHex(0x8d7b7c);
      } else if (phase === 'resist') {
        // Isometric PNF contraction: amber-crimson pulse + slight isometric belly thickening!
        const pulse = 0.5 + 0.5 * Math.sin(elapsedSec * 7.5);
        bellyCol.setRGB(0.96, 0.24 + 0.34 * pulse, 0.14 + 0.04 * pulse);
        bellyBulge = 1.06 + 0.08 * pulse;
      } else {
        // Setup (coral) -> Stretch/Deepen (vivid crimson-scarlet proportional to strain)
        const s = THREE.MathUtils.clamp(rawStrain, 0, 1);
        bellyCol.setRGB(
          0.76 + 0.22 * s,
          0.32 - 0.18 * s,
          0.28 - 0.08 * s
        );
        // Poisson thinning as muscle elongates
        bellyBulge = 1.0 - 0.14 * s;
      }

      if (spec.role !== 'nerve' && spec.role !== 'synergist') {
        strainSum += isMistake ? rawStrain * 0.25 : rawStrain;
        primaryCount += 1;
      }

      const frames = curve.computeFrenetFrames(TUBULAR_SEGMENTS, false);
      const posAttr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const normAttr = mesh.geometry.getAttribute('normal') as THREE.BufferAttribute;
      const colAttr = mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
      const tendonRatio = spec.role === 'nerve' ? 0.0 : (spec.tendonRatio ?? 0.2);

      let idx = 0;
      const pt = new THREE.Vector3();
      const normal = new THREE.Vector3();

      for (let i = 0; i <= TUBULAR_SEGMENTS; i++) {
        const u = i / TUBULAR_SEGMENTS;
        curve.getPointAt(u, pt);
        const N = frames.normals[i];
        const B = frames.binormals[i];

        // Spindle profile: tapered tendon ends, fusiform belly in the center
        let rScale = 1.0;
        let tendonMix = 0.0;
        if (spec.role !== 'nerve') {
          const bellyProfile = Math.sin(Math.PI * u);
          rScale = (0.34 + 0.66 * Math.pow(bellyProfile, 0.75)) * bellyBulge;
          if (u < tendonRatio) {
            tendonMix = 1.0 - THREE.MathUtils.smoothstep(u, tendonRatio * 0.35, tendonRatio);
          } else if (u > 1.0 - tendonRatio) {
            tendonMix = THREE.MathUtils.smoothstep(u, 1.0 - tendonRatio, 1.0 - tendonRatio * 0.35);
          }
        }

        const r = spec.radius * rScale;
        for (let j = 0; j <= RADIAL_SEGMENTS; j++) {
          const v = (j / RADIAL_SEGMENTS) * Math.PI * 2;
          const cosV = Math.cos(v);
          const sinV = Math.sin(v);
          // Slight anatomical flattening (ribbon-like 1.0 x 0.72 cross-section) + longitudinal striation
          const striation = spec.role === 'nerve' ? 1.0 : 1.0 + 0.045 * Math.cos(v * 6);
          normal.set(
            cosV * N.x + sinV * B.x,
            cosV * N.y + sinV * B.y,
            cosV * N.z + sinV * B.z
          ).normalize();

          posAttr.setXYZ(
            idx,
            pt.x + normal.x * r * striation,
            pt.y + normal.y * r * 0.78 * striation,
            pt.z + normal.z * r * striation
          );
          normAttr.setXYZ(idx, normal.x, normal.y, normal.z);

          tmpCol.copy(bellyCol).lerp(tendonCol, tendonMix);
          colAttr.setXYZ(idx, tmpCol.r, tmpCol.g, tmpCol.b);
          idx++;
        }
      }

      posAttr.needsUpdate = true;
      normAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
      mesh.geometry.computeBoundingSphere();
    }

    const avgStrain = primaryCount > 0 ? strainSum / primaryCount : 0;
    const refItem = this.items.find((it) => it.spec.role !== 'nerve');
    const elongationPct = refItem
      ? Math.max(0, ((refItem.currentLength - refItem.restLength) / Math.max(0.05, refItem.restLength)) * 100)
      : avgStrain * 16;

    return {
      strainRatio: THREE.MathUtils.clamp(avgStrain, 0, 1.15),
      elongationPct: isMistake ? Math.min(3.5, elongationPct * 0.3) : elongationPct,
    };
  }

  public clear(): void {
    for (const item of this.items) {
      item.mesh.geometry.dispose();
      (item.mesh.material as THREE.Material).dispose();
      item.originPin.geometry.dispose();
      item.insertionPin.geometry.dispose();
    }
    this.items = [];
    this.group.clear();
  }
}
