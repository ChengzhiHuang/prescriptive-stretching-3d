import * as THREE from 'three';
import type { HumanRig } from './HumanRig';
import type { FascicleSpec, PnfPhaseId } from './types';

interface FascicleRuntime {
  spec: FascicleSpec;
  mesh: THREE.Mesh;
  originPin: THREE.Mesh;
  insertionPin: THREE.Mesh;
  sockets: string[];
  curve: THREE.CatmullRomCurve3;
  samples: THREE.Vector3[];
  frames?: ReturnType<THREE.Curve<THREE.Vector3>['computeFrenetFrames']>;
  restLength: number;
  maxLength: number;
  currentLength: number;
}

const RADIAL_SEGMENTS = 12;
const TUBULAR_SEGMENTS = 28;
const IVORY_TENDON = new THREE.Color(0xf4efe6);
const SYNERGIST_TENDON = new THREE.Color(0xcec4ba);
const SYNERGIST_BELLY = new THREE.Color(0xa18c90);

/**
 * Builds and updates 3D spindle-shaped anatomical muscle fascicles (with ivory tendons
 * at origin/insertion and dynamic tension-colored muscle bellies) between bone sockets.
 */
export class MuscleSystem {
  public readonly group = new THREE.Group();
  private items: FascicleRuntime[] = [];


  private readonly pinOriginMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
  private readonly pinInsertMat = new THREE.MeshBasicMaterial({ color: 0xfb7185 });

  public loadFascicles(specs: FascicleSpec[], rig: HumanRig): void {
    this.clear();
    for (const spec of specs) {
      const isNerve = spec.role === 'nerve';
      const geo = this.createSpindleGeometry(isNerve ? 0 : (spec.tendonRatio ?? 0.2));
      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: isNerve ? 0.48 : 0.77,
      });
      if (!isNerve) {
        mat.onBeforeCompile = (shader) => {
          shader.vertexShader = `varying vec2 vFiberUv;\n${shader.vertexShader}`.replace(
            '#include <uv_vertex>',
            '#include <uv_vertex>\nvFiberUv = uv;',
          );
          shader.fragmentShader = `varying vec2 vFiberUv;\n${shader.fragmentShader}`.replace(
            '#include <color_fragment>',
            `#include <color_fragment>
            // Longitudinal fibers follow the curved tube and fade into the tendon.
            float around = vFiberUv.x * 6.2831853;
            float fibers = 0.5 + 0.5 * cos(13.0 * around + 0.9 * sin(3.0 * around));
            float resolved = 1.0 - smoothstep(0.022, 0.065, fwidth(vFiberUv.x));
            diffuseColor.rgb *= 1.0 - 0.21 * fibers * resolved * (1.0 - vFiberUv.y);`,
          );
        };
      }
      const mesh = new THREE.Mesh(geo, mat);
      this.group.add(mesh);

      const pinGeo = new THREE.SphereGeometry(spec.role === 'nerve' ? 0.005 : 0.011, 10, 8);
      const originPin = new THREE.Mesh(pinGeo, this.pinOriginMat);
      const insertionPin = new THREE.Mesh(pinGeo, this.pinInsertMat);
      if (spec.role !== 'nerve') {
        this.group.add(originPin);
        this.group.add(insertionPin);
      }

      const sockets = [spec.origin, ...(spec.via ?? []), spec.insertion];
      const curve = new THREE.CatmullRomCurve3(sockets.map(name => rig.getSocketWorldPos(name)), false, 'catmullrom', 0.35);
      const len = curve.getLength();
      this.items.push({
        spec, sockets, curve, samples: [],
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
      this.updatePath(item, rig);
      out[item.spec.id] = item.currentLength;
    }
    return out;
  }

  private updatePath(item: FascicleRuntime, rig: HumanRig): void {
    item.sockets.forEach((name, index) => rig.getSocketWorldPos(name, item.curve.points[index]));
    item.curve.updateArcLengths();
    item.currentLength = item.curve.getLength();
    item.frames = undefined;
  }

  private createSpindleGeometry(tendonRatio: number): THREE.BufferGeometry {
    const vertCount = (TUBULAR_SEGMENTS + 1) * (RADIAL_SEGMENTS + 1);
    const uvs = new Float32Array(vertCount * 2);
    const indices: number[] = [];

    for (let i = 0; i <= TUBULAR_SEGMENTS; i++) {
      const u = i / TUBULAR_SEGMENTS;
      const distanceFromEnd = Math.min(u, 1 - u);
      const tendonMix = tendonRatio > 0
        ? 1 - THREE.MathUtils.smoothstep(distanceFromEnd, tendonRatio * 0.25, tendonRatio)
        : 0;
      for (let j = 0; j <= RADIAL_SEGMENTS; j++) {
        const a = i * (RADIAL_SEGMENTS + 1) + j;
        uvs[a * 2] = j / RADIAL_SEGMENTS;
        uvs[a * 2 + 1] = tendonMix;

        if (i === TUBULAR_SEGMENTS || j === RADIAL_SEGMENTS) continue;
        const b = a + RADIAL_SEGMENTS + 1;
        // The circumference derivative crossed with the path tangent points outward.
        indices.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }

    const geo = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'color']) {
      const attribute = new THREE.BufferAttribute(new Float32Array(vertCount * 3), 3);
      geo.setAttribute(name, attribute.setUsage(THREE.DynamicDrawUsage));
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
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
    elapsedSec: number,
    poseChanged = true,
    drawFibers = true
  ): { strainRatio: number; elongationPct: number } {
    let strainSum = 0;
    let primaryCount = 0;

    const bellyCol = new THREE.Color();
    const ringColor = new THREE.Color();

    for (const item of this.items) {
      const { spec, mesh, originPin, insertionPin } = item;
      const isNerve = spec.role === 'nerve';
      const isSynergist = spec.role === 'synergist';
      const tendonCol = isSynergist ? SYNERGIST_TENDON : IVORY_TENDON;
      if (poseChanged) this.updatePath(item, rig);
      const { curve, currentLength: len } = item;

      const rawStrain = THREE.MathUtils.clamp(
        (len - item.restLength) / Math.max(0.012, item.maxLength - item.restLength),
        0,
        1.25
      );

      let bellyBulge = 1.0;
      if (isNerve) {
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

      if (isSynergist) bellyCol.lerp(SYNERGIST_BELLY, 0.58);
      if (!isNerve && !isSynergist) {
        strainSum += isMistake ? rawStrain * 0.25 : rawStrain;
        primaryCount += 1;
      }

      if (!drawFibers) continue;
      originPin.position.copy(curve.points[0]);
      insertionPin.position.copy(curve.points[curve.points.length - 1]);
      if (!item.frames) {
        item.frames = curve.computeFrenetFrames(TUBULAR_SEGMENTS, false);
        for (let i = 0; i <= TUBULAR_SEGMENTS; i++) {
          curve.getPointAt(i / TUBULAR_SEGMENTS, item.samples[i] ??= new THREE.Vector3());
        }
      }
      const frames = item.frames;
      const posAttr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const normAttr = mesh.geometry.getAttribute('normal') as THREE.BufferAttribute;
      const colAttr = mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
      const uvAttr = mesh.geometry.getAttribute('uv');

      let idx = 0;
      const normal = new THREE.Vector3();

      for (let i = 0; i <= TUBULAR_SEGMENTS; i++) {
        const u = i / TUBULAR_SEGMENTS;
        const pt = item.samples[i];
        const N = frames.normals[i];
        const B = frames.binormals[i];

        // Spindle profile: tapered tendon ends, fusiform belly in the center
        const tendonMix = uvAttr.getY(idx);
        const bellyProfile = Math.sin(Math.PI * u);
        const rScale = isNerve ? 1 : (0.34 + 0.66 * Math.pow(bellyProfile, 0.75)) * bellyBulge;
        const r = spec.radius * rScale;
        ringColor.copy(bellyCol).lerp(tendonCol, tendonMix);
        for (let j = 0; j <= RADIAL_SEGMENTS; j++) {
          const v = (j / RADIAL_SEGMENTS) * Math.PI * 2;
          const cosV = Math.cos(v);
          const sinV = Math.sin(v);
          normal.set(
            cosV * N.x + sinV * B.x,
            cosV * N.y + sinV * B.y,
            cosV * N.z + sinV * B.z
          );

          posAttr.setXYZ(
            idx,
            pt.x + normal.x * r,
            pt.y + normal.y * r * 0.78,
            pt.z + normal.z * r,
          );
          normal.y /= 0.78;
          normal.normalize();
          normAttr.setXYZ(idx, normal.x, normal.y, normal.z);
          colAttr.setXYZ(idx, ringColor.r, ringColor.g, ringColor.b);
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

    }
    this.items = [];
    this.group.clear();
  }
}
