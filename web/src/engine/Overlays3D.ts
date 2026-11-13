import * as THREE from 'three';
import type { HumanRig } from './HumanRig';
import type { AnchorCalloutSpec, AngleGaugeSpec, ForceArrowSpec, PnfPhaseId, Stretch3DSpec } from './types';

interface ArrowRuntime {
  spec: ForceArrowSpec;
  group: THREE.Group;
  shaft: THREE.Mesh;
  head: THREE.Mesh;
  tipWorld: THREE.Vector3;
}

/**
 * Manages 3D pedagogical overlays:
 * 1. PNF isometric force & counter-force vector arrows
 * 2. Live 3D joint angle protractor sector & degree readout
 * 3. Compensation overload warning halo in mistake mode
 * 4. Projected 2D HTML floating labels tethered to 3D sockets
 */
export class Overlays3D {
  public readonly group = new THREE.Group();
  private labelLayer: HTMLElement;
  private calloutEls: { spec: AnchorCalloutSpec; el: HTMLDivElement }[] = [];
  private arrowRuntimes: ArrowRuntime[] = [];
  private arrowLabelEls: HTMLDivElement[] = [];

  private angleSectorMesh: THREE.Mesh | null = null;
  private angleArcLine: THREE.Line | null = null;
  private angleLabelEl: HTMLDivElement;
  private overloadRing: THREE.Mesh;
  private overloadRingOuter: THREE.Mesh;

  private currentSpec: Stretch3DSpec | null = null;
  private readonly projScratch = new THREE.Vector3();
  private readonly labelMetrics = new WeakMap<
    HTMLElement,
    { halfW: number; halfH: number; widthKey: number }
  >();

  constructor(overlayDomContainer: HTMLElement) {
    this.labelLayer = overlayDomContainer;
    this.angleLabelEl = document.createElement('div');
    this.angleLabelEl.className = 'overlay-tag tag-angle';
    this.labelLayer.appendChild(this.angleLabelEl);

    const ringGeo = new THREE.RingGeometry(0.055, 0.075, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xef4444,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
      depthWrite: false,
    });
    this.overloadRing = new THREE.Mesh(ringGeo, ringMat);
    this.overloadRing.renderOrder = 8;
    this.overloadRing.visible = false;

    const outerGeo = new THREE.RingGeometry(0.085, 0.096, 32);
    const outerMat = new THREE.MeshBasicMaterial({
      color: 0xfca5a5,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.55,
      depthTest: false,
      depthWrite: false,
    });
    this.overloadRingOuter = new THREE.Mesh(outerGeo, outerMat);
    this.overloadRingOuter.renderOrder = 8;
    this.overloadRingOuter.visible = false;
  }

  public loadStretch(spec: Stretch3DSpec): void {
    this.currentSpec = spec;
    this.labelMetrics.delete(this.angleLabelEl);
    this.group.clear();
    this.group.add(this.overloadRing);
    this.group.add(this.overloadRingOuter);

    for (const c of this.calloutEls) c.el.remove();
    for (const a of this.arrowLabelEls) a.remove();
    this.calloutEls = [];
    this.arrowRuntimes = [];
    this.arrowLabelEls = [];

    // Build 3D force arrows
    for (const fSpec of spec.forceArrows) {
      const color = fSpec.kind === 'effort' ? 0xf59e0b : fSpec.kind === 'reaction' ? 0x38bdf8 : 0x34d399;
      const mat = new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.45,
        roughness: 0.3,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.92,
      });
      const len = fSpec.length ?? 0.2;
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, len * 0.72, 10), mat);
      shaft.position.y = len * 0.36;
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.022, len * 0.3, 12), mat);
      head.position.y = len * 0.84;
      const ag = new THREE.Group();
      ag.renderOrder = 10;
      ag.add(shaft, head);
      this.group.add(ag);

      const lbl = document.createElement('div');
      lbl.className = `overlay-tag tag-force tag-force-${fSpec.kind}`;
      lbl.textContent = fSpec.label;
      this.labelLayer.appendChild(lbl);
      this.arrowLabelEls.push(lbl);

      this.arrowRuntimes.push({
        spec: fSpec,
        group: ag,
        shaft,
        head,
        tipWorld: new THREE.Vector3(),
      });
    }

    // Angle gauge meshes (rebuilt dynamically per frame)
    this.angleSectorMesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.24,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
      })
    );
    this.angleSectorMesh.renderOrder = 8;
    this.angleArcLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({
        color: 0x7dd3fc,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
        depthWrite: false,
      })
    );
    this.angleArcLine.renderOrder = 9;
    this.group.add(this.angleSectorMesh, this.angleArcLine);

    this.rebuildCallouts(false);
  }

  public rebuildCallouts(isMistake: boolean): void {
    for (const c of this.calloutEls) c.el.remove();
    this.calloutEls = [];
    if (!this.currentSpec) return;

    const list = isMistake
      ? [
          ...(this.currentSpec.mistakeCallouts ?? []),
          {
            socket: this.currentSpec.mistakeInfo.overloadSocket,
            label: `⚠️ ${this.currentSpec.mistakeInfo.overloadLabel}`,
            kind: 'warning' as const,
            offset: [0, 0.06, 0] as [number, number, number],
          },
        ]
      : this.currentSpec.callouts;

    for (const spec of list) {
      const el = document.createElement('div');
      el.className = `overlay-tag tag-${spec.kind}`;
      const badge =
        spec.kind === 'lock'
          ? '锚点固定'
          : spec.kind === 'origin'
          ? '起点'
          : spec.kind === 'insertion'
          ? '止点'
          : spec.kind === 'warning'
          ? '错误代偿'
          : '靶区';
      el.innerHTML = `<span class="tag-pill">${badge}</span><span>${spec.label}</span>`;
      this.labelLayer.appendChild(el);
      this.calloutEls.push({ spec, el });
    }
  }

  public update(
    rig: HumanRig,
    camera: THREE.PerspectiveCamera,
    width: number,
    height: number,
    phase: PnfPhaseId,
    isMistake: boolean,
    elapsedSec: number,
    showLabels = true
  ): number {
    if (!this.currentSpec) return 0;

    // 1. Update Overload Ring in mistake mode
    if (isMistake) {
      const wp = rig.getSocketWorldPos(this.currentSpec.mistakeInfo.overloadSocket);
      const pulse = 1.0 + 0.22 * Math.sin(elapsedSec * 6.5);
      this.overloadRing.visible = true;
      this.overloadRingOuter.visible = true;
      this.overloadRing.position.copy(wp);
      this.overloadRingOuter.position.copy(wp);
      this.overloadRing.quaternion.copy(camera.quaternion);
      this.overloadRingOuter.quaternion.copy(camera.quaternion);
      this.overloadRing.scale.setScalar(pulse);
      this.overloadRingOuter.scale.setScalar(1.3 - 0.15 * Math.sin(elapsedSec * 6.5));
    } else {
      this.overloadRing.visible = false;
      this.overloadRingOuter.visible = false;
    }

    // 2. Update 3D Force Arrows
    this.arrowRuntimes.forEach((ar, i) => {
      const visible = !isMistake && ar.spec.phases.includes(phase);
      ar.group.visible = visible;
      const lbl = this.arrowLabelEls[i];
      if (!visible || !showLabels) {
        lbl.style.display = 'none';
        if (!visible) return;
      }
      const origin = rig.getSocketWorldPos(ar.spec.socket);
      const dir = new THREE.Vector3(...ar.spec.direction).normalize();
      const pulseScale = phase === 'resist' ? 0.92 + 0.16 * Math.sin(elapsedSec * 8.0) : 1.0;
      ar.group.position.copy(origin);
      ar.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      ar.group.scale.set(1, pulseScale, 1);

      const len = (ar.spec.length ?? 0.2) * pulseScale;
      ar.tipWorld.copy(origin).addScaledVector(dir, len + 0.03);
      if (showLabels) {
        this.projectToScreen(ar.tipWorld, camera, width, height, lbl);
      }
    });

    // 3. Update 3D Angle Protractor Arc
    const gSpec = this.currentSpec.angleGauge;
    const vPos = rig.getSocketWorldPos(gSpec.vertexSocket);
    const toPos = rig.getSocketWorldPos(gSpec.toSocket);
    const vRef = new THREE.Vector3(...gSpec.fromDir).normalize();
    const vCur = toPos.clone().sub(vPos).normalize();
    const angleRad = Math.acos(THREE.MathUtils.clamp(vRef.dot(vCur), -1, 1));
    const angleDeg = Math.round((angleRad * 180) / Math.PI);

    if (this.angleSectorMesh && this.angleArcLine) {
      const radius = gSpec.radius ?? 0.17;
      const steps = 18;
      const arcPts: THREE.Vector3[] = [];
      const triVerts: number[] = [];
      const axis = new THREE.Vector3().crossVectors(vRef, vCur);
      if (axis.lengthSq() < 1e-6) axis.set(0, 0, 1);
      axis.normalize();

      for (let s = 0; s <= steps; s++) {
        const pt = vRef.clone().applyAxisAngle(axis, (angleRad * s) / steps).multiplyScalar(radius).add(vPos);
        arcPts.push(pt);
      }
      for (let s = 0; s < steps; s++) {
        triVerts.push(
          vPos.x, vPos.y, vPos.z,
          arcPts[s].x, arcPts[s].y, arcPts[s].z,
          arcPts[s + 1].x, arcPts[s + 1].y, arcPts[s + 1].z
        );
      }
      this.angleSectorMesh.geometry.dispose();
      const sGeo = new THREE.BufferGeometry();
      sGeo.setAttribute('position', new THREE.Float32BufferAttribute(triVerts, 3));
      this.angleSectorMesh.geometry = sGeo;

      this.angleArcLine.geometry.dispose();
      this.angleArcLine.geometry = new THREE.BufferGeometry().setFromPoints([vPos, ...arcPts, vPos]);

      if (showLabels) {
        const midPt = arcPts[Math.floor(steps / 2)].clone().lerp(vPos, -0.28);
        this.angleLabelEl.textContent = `${gSpec.labelPrefix} ${angleDeg}°`;
        this.projectToScreen(midPt, camera, width, height, this.angleLabelEl);
      } else {
        this.angleLabelEl.style.display = 'none';
      }
    }

    // 4. Project Callouts
    for (const item of this.calloutEls) {
      if (!showLabels || (item.spec.phases && !item.spec.phases.includes(phase))) {
        item.el.style.display = 'none';
        continue;
      }
      const wp = rig.getSocketWorldPos(item.spec.socket);
      if (item.spec.offset) {
        wp.x += item.spec.offset[0];
        wp.y += item.spec.offset[1];
        wp.z += item.spec.offset[2];
      }
      this.projectToScreen(wp, camera, width, height, item.el);
    }

    return angleDeg;
  }

  private projectToScreen(
    worldPos: THREE.Vector3,
    camera: THREE.PerspectiveCamera,
    width: number,
    height: number,
    el: HTMLElement
  ): void {
    const p = this.projScratch.copy(worldPos).project(camera);
    if (p.z > 1 || p.z < -1) {
      el.style.display = 'none';
      return;
    }
    const rawX = (p.x * 0.5 + 0.5) * width;
    const rawY = (-p.y * 0.5 + 0.5) * height;
    el.style.display = 'inline-flex';

    let metrics = this.labelMetrics.get(el);
    if (!metrics || metrics.widthKey !== width || metrics.halfW === 0) {
      metrics = {
        halfW: el.offsetWidth * 0.5,
        halfH: el.offsetHeight * 0.5,
        widthKey: width,
      };
      this.labelMetrics.set(el, metrics);
    }

    const padX = 8;
    const padY = 8;
    const minX = padX + metrics.halfW;
    const maxX = width - padX - metrics.halfW;
    const minY = padY + metrics.halfH;
    const maxY = height - padY - metrics.halfH;

    const x = minX <= maxX ? THREE.MathUtils.clamp(rawX, minX, maxX) : width * 0.5;
    const y = minY <= maxY ? THREE.MathUtils.clamp(rawY, minY, maxY) : height * 0.5;

    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
  }
}
