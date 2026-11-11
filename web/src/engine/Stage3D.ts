import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { HumanRig, interpolatePoses } from './HumanRig';
import { MuscleSystem } from './MuscleSystem';
import { Overlays3D } from './Overlays3D';
import { PropSystem } from './PropSystem';
import type { CameraPreset, PnfPhaseId, PoseAngles, Stretch3DSpec } from './types';

export interface StageTelemetry {
  phase: PnfPhaseId;
  phaseIndex: number;
  phaseRemainingSec: number;
  phaseDurationSec: number;
  phaseProgress: number;
  angleDeg: number;
  strainRatio: number;
  elongationPct: number;
  isPlaying: boolean;
  isMistake: boolean;
}

const PHASE_ORDER: PnfPhaseId[] = ['setup', 'stretch', 'resist', 'deepen'];

const BODY_EXTENT_SOCKETS = [
  'vertex',
  'forehead',
  'occiput',
  'acromionR',
  'acromionL',
  'elbow_jointR',
  'elbow_jointL',
  'handR',
  'handL',
  'pelvis_center',
  'ischial_tuberosityR',
  'ischial_tuberosityL',
  'knee_jointR',
  'knee_jointL',
  'calcaneusR',
  'calcaneusL',
  'forefootR',
  'forefootL',
];

export class Stage3D {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private rig: HumanRig;
  private muscles: MuscleSystem;
  private props: PropSystem;
  private overlays: Overlays3D;

  private container: HTMLElement;
  private currentSpec: Stretch3DSpec | null = null;
  private activePreset: CameraPreset | null = null;
  private actionBodyPoints: THREE.Vector3[] = [];
  private actionBodyBox = new THREE.Box3();
  private userMovedCamera = false;

  private phaseIndex = 1;
  private phaseElapsed = 0;
  private isPlaying = true;
  private speed = 1.0;
  private isMistake = false;
  private showLabels = true;
  private xrayMode = false;

  private camTransition: {
    fromPos: THREE.Vector3;
    toPos: THREE.Vector3;
    fromTarget: THREE.Vector3;
    toTarget: THREE.Vector3;
    t: number;
  } | null = null;

  private rafId = 0;
  private lastTime = performance.now();
  private totalElapsed = 0;
  private resizeObserver: ResizeObserver;
  public onTelemetry?: (t: StageTelemetry) => void;

  constructor(canvasContainer: HTMLElement, overlayContainer: HTMLElement) {
    this.container = canvasContainer;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b1222);

    const w = Math.max(320, canvasContainer.clientWidth);
    const h = Math.max(280, canvasContainer.clientHeight);

    this.camera = new THREE.PerspectiveCamera(36, w / h, 0.08, 28);
    this.camera.position.set(0.95, 1.25, 2.25);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    canvasContainer.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.65;
    this.controls.maxDistance = 6.5;
    this.controls.target.set(0, 0.9, 0);
    this.controls.addEventListener('start', () => {
      this.userMovedCamera = true;
      this.camTransition = null;
    });

    // Double-click canvas to immediately re-center full body!
    this.renderer.domElement.addEventListener('dblclick', () => {
      this.fitFullBody(false);
    });

    // Studio lighting
    const hemi = new THREE.HemisphereLight(0xe2e8f0, 0x1e293b, 1.28);
    this.scene.add(hemi);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.55);
    keyLight.position.set(2.2, 3.4, 2.6);
    this.scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x7dd3fc, 0.85);
    rimLight.position.set(-2.4, 2.0, -2.2);
    this.scene.add(rimLight);

    // Floor platform & subtle anatomical alignment grid
    const floorDisc = new THREE.Mesh(
      new THREE.CircleGeometry(1.75, 48),
      new THREE.MeshStandardMaterial({ color: 0x111c30, roughness: 0.9, metalness: 0.05 })
    );
    floorDisc.rotation.x = -Math.PI / 2;
    floorDisc.position.y = -0.002;
    this.scene.add(floorDisc);

    const grid = new THREE.GridHelper(3.0, 15, 0x334155, 0x1e293b);
    grid.position.y = 0.001;
    this.scene.add(grid);

    this.props = new PropSystem();
    this.rig = new HumanRig();
    this.muscles = new MuscleSystem();
    this.overlays = new Overlays3D(overlayContainer);

    this.scene.add(this.props.group);
    this.scene.add(this.rig.root);
    this.scene.add(this.muscles.group);
    this.scene.add(this.overlays.group);

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(canvasContainer);

    this.animate();
  }

  public loadStretch(spec: Stretch3DSpec, initialPhase: PnfPhaseId = 'setup', mistake = false): void {
    this.currentSpec = spec;
    this.isMistake = mistake;
    this.phaseIndex = Math.max(0, PHASE_ORDER.indexOf(initialPhase));
    this.phaseElapsed = 0;
    this.userMovedCamera = false;

    this.props.setProps(spec.props);
    this.muscles.loadFascicles(spec.fascicles, this.rig);

    // Calibrate setup rest length vs deepen max stretch length for accurate strain %
    this.rig.applyPose(spec.poses.setup);
    const setupLens = this.muscles.measureAll(this.rig);
    this.rig.applyPose(spec.poses.deepen);
    const deepenLens = this.muscles.measureAll(this.rig);
    this.muscles.calibrateLengths(this.rig, setupLens, deepenLens);

    // Sample full-body 3D bounding points across all key poses for smart camera auto-framing
    this.sampleActionBodyBounds(spec);

    this.overlays.loadStretch(spec);
    this.overlays.rebuildCallouts(this.isMistake);

    if (spec.cameras.length > 0) {
      this.setCameraPreset(spec.cameras[0], true);
    }
  }

  /**
   * Samples key anatomical sockets across setup, stretch, deepen, and mistake poses
   * (with a slight margin around head/feet/hands) so camera framing guarantees zero clipping.
   */
  private sampleActionBodyBounds(spec: Stretch3DSpec): void {
    this.actionBodyPoints = [];
    this.actionBodyBox.makeEmpty();
    const poses = [spec.poses.setup, spec.poses.stretch, spec.poses.deepen, spec.poses.mistake];
    const tmp = new THREE.Vector3();

    for (const p of poses) {
      this.rig.applyPose(p);
      for (const sName of BODY_EXTENT_SOCKETS) {
        this.rig.getSocketWorldPos(sName, tmp);
        // Add small anatomical radius padding (head crown +0.06m, foot sole -0.03m)
        const padY = sName === 'vertex' ? 0.06 : sName.startsWith('forefoot') || sName.startsWith('calcaneus') ? -0.025 : 0;
        const pt = new THREE.Vector3(tmp.x, tmp.y + padY, tmp.z);
        this.actionBodyPoints.push(pt);
        this.actionBodyBox.expandByPoint(pt);
      }
    }
  }

  /**
   * Computes an aspect-aware, HUD-safe camera position and target along `viewDir`
   * so that every sampled point in `points` fits cleanly inside the viewport safe zone.
   */
  private computeFramedCamera(
    viewDirInput: THREE.Vector3,
    anchorTarget?: THREE.Vector3,
    blendCenter = 0.72
  ): { pos: THREE.Vector3; target: THREE.Vector3 } {
    const viewDir = viewDirInput.clone().normalize();
    const boxCenter = new THREE.Vector3();
    this.actionBodyBox.getCenter(boxCenter);

    const target = anchorTarget
      ? anchorTarget.clone().lerp(boxCenter, blendCenter)
      : boxCenter.clone();

    // Orthonormal camera basis: forward = -viewDir, right = forward x worldUp, camUp = right x forward
    const forward = viewDir.clone().negate();
    const worldUp = Math.abs(forward.y) > 0.96 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(forward, worldUp).normalize();
    const camUp = new THREE.Vector3().crossVectors(right, forward).normalize();

    const w = Math.max(280, this.container.clientWidth);
    const h = Math.max(240, this.container.clientHeight);
    const aspect = w / h;

    // Reserve top & bottom HUD safe margins (top chips ~54px, bottom playback bar ~58px) + side label margin
    const safeFracY = Math.max(0.56, 1.0 - 135 / h);
    const safeFracX = Math.max(0.66, 1.0 - 110 / w);

    const halfFovV = THREE.MathUtils.degToRad(this.camera.fov * 0.5);
    const tanV = Math.tan(halfFovV) * safeFracY;
    const tanH = Math.tan(halfFovV) * aspect * safeFracX;

    // Iteratively refine target along camUp/right so body sits centered in the safe box at minimal distance
    for (let iter = 0; iter < 2; iter++) {
      let minU = Infinity;
      let maxU = -Infinity;
      let minR = Infinity;
      let maxR = -Infinity;

      for (const pt of this.actionBodyPoints) {
        const rel = pt.clone().sub(target);
        const u = rel.dot(camUp);
        const r = rel.dot(right);
        if (u < minU) minU = u;
        if (u > maxU) maxU = u;
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
      }

      if (Number.isFinite(minU) && Number.isFinite(maxU)) {
        const midU = (minU + maxU) * 0.5;
        const midR = (minR + maxR) * 0.5;
        target.addScaledVector(camUp, midU * 0.85);
        target.addScaledVector(right, midR * 0.65);
      }
    }

    let requiredDist = 1.15;
    for (const pt of this.actionBodyPoints) {
      const rel = pt.clone().sub(target);
      const depthTowardsCam = rel.dot(viewDir); // positive if point is closer to camera than target
      const u = Math.abs(rel.dot(camUp));
      const r = Math.abs(rel.dot(right));
      const dV = u / Math.max(0.12, tanV) + depthTowardsCam;
      const dH = r / Math.max(0.12, tanH) + depthTowardsCam;
      requiredDist = Math.max(requiredDist, dV, dH);
    }

    // Add 6% breathing room so force arrows and floating callouts have comfortable clearance
    requiredDist = THREE.MathUtils.clamp(requiredDist * 1.06, 1.05, 5.2);

    const pos = target.clone().addScaledVector(viewDir, requiredDist);
    // Keep camera above floor plane unless viewing slightly from low angle
    if (pos.y < 0.18) pos.y = 0.18;
    return { pos, target };
  }

  public setCameraPreset(preset: CameraPreset, instant = false): void {
    this.activePreset = preset;
    this.userMovedCamera = false;

    const rawPos = new THREE.Vector3(...preset.position);
    const rawTarget = new THREE.Vector3(...preset.target);
    const viewDir = rawPos.clone().sub(rawTarget);

    // Check if preset is an intentional anatomical close-up (label contains 特写)
    const isCloseup = preset.label.includes('特写');
    let finalPos: THREE.Vector3;
    let finalTarget: THREE.Vector3;

    if (this.actionBodyPoints.length > 0 && !isCloseup) {
      const framed = this.computeFramedCamera(viewDir, rawTarget, 0.78);
      finalPos = framed.pos;
      finalTarget = framed.target;
    } else if (this.actionBodyPoints.length > 0 && isCloseup) {
      // Even for close-ups, ensure aspect ratio changes don't overly zoom in on short/narrow screens
      const w = Math.max(280, this.container.clientWidth);
      const h = Math.max(240, this.container.clientHeight);
      const aspectComp = h < 480 ? 480 / h : w < 480 ? 480 / w : 1.0;
      finalTarget = rawTarget;
      finalPos = rawTarget.clone().addScaledVector(viewDir, Math.min(1.45, aspectComp * 1.08));
    } else {
      finalPos = rawPos;
      finalTarget = rawTarget;
    }

    if (instant) {
      this.camera.position.copy(finalPos);
      this.controls.target.copy(finalTarget);
      this.controls.update();
      this.camTransition = null;
      return;
    }

    this.camTransition = {
      fromPos: this.camera.position.clone(),
      toPos: finalPos,
      fromTarget: this.controls.target.clone(),
      toTarget: finalTarget,
      t: 0,
    };
  }

  /**
   * Re-frames the full body cleanly along the current camera viewing angle (or active preset).
   */
  public fitFullBody(instant = false): void {
    if (this.actionBodyPoints.length === 0) return;
    this.userMovedCamera = false;
    const curDir = this.camera.position.clone().sub(this.controls.target);
    if (curDir.lengthSq() < 1e-4) curDir.set(0.8, 0.4, 1.4);
    const framed = this.computeFramedCamera(curDir, undefined, 1.0);

    if (instant) {
      this.camera.position.copy(framed.pos);
      this.controls.target.copy(framed.target);
      this.controls.update();
      this.camTransition = null;
      return;
    }
    this.camTransition = {
      fromPos: this.camera.position.clone(),
      toPos: framed.pos,
      fromTarget: this.controls.target.clone(),
      toTarget: framed.target,
      t: 0,
    };
  }

  public setPhase(phase: PnfPhaseId, pauseAuto = false): void {
    const idx = PHASE_ORDER.indexOf(phase);
    if (idx >= 0) {
      this.phaseIndex = idx;
      this.phaseElapsed = 0;
      if (pauseAuto) {
        this.isPlaying = false;
      }
    }
  }

  public setPlaying(playing: boolean): void {
    this.isPlaying = playing;
  }

  public togglePlaying(): boolean {
    this.isPlaying = !this.isPlaying;
    return this.isPlaying;
  }

  public setSpeed(speed: number): void {
    this.speed = speed;
  }

  public setMistakeMode(mistake: boolean): void {
    if (this.isMistake === mistake) return;
    this.isMistake = mistake;
    this.overlays.rebuildCallouts(mistake);
  }

  public setShowLabels(show: boolean): void {
    this.showLabels = show;
  }

  public setXrayMode(xray: boolean): void {
    this.xrayMode = xray;
    this.rig.setXrayOpacity(xray ? 0.1 : 0.34);
  }

  private computeCurrentPose(spec: Stretch3DSpec, phase: PnfPhaseId, phaseProgress: number): PoseAngles {
    if (this.isMistake) {
      const osc = 0.65 + 0.35 * Math.sin(this.totalElapsed * 2.2);
      return interpolatePoses(spec.poses.setup, spec.poses.mistake, osc);
    }

    const rampWindow = 0.28;
    const t = Math.min(1, phaseProgress / rampWindow);

    switch (phase) {
      case 'setup':
        return interpolatePoses(spec.poses.deepen, spec.poses.setup, Math.min(1, phaseProgress / 0.35));
      case 'stretch':
        return interpolatePoses(spec.poses.setup, spec.poses.stretch, t);
      case 'resist':
        return interpolatePoses(spec.poses.stretch, spec.poses.resist, t);
      case 'deepen':
        return interpolatePoses(spec.poses.resist, spec.poses.deepen, t);
    }
  }

  private handleResize(): void {
    const w = Math.max(240, this.container.clientWidth);
    const h = Math.max(220, this.container.clientHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    if (!this.userMovedCamera && this.activePreset) {
      this.setCameraPreset(this.activePreset, true);
    }
  }

  private animate = (): void => {
    this.rafId = requestAnimationFrame(this.animate);
    const now = performance.now();
    const dt = Math.min(0.08, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.totalElapsed += dt;

    if (this.camTransition) {
      this.camTransition.t = Math.min(1, this.camTransition.t + dt * 3.0);
      const s = this.camTransition.t * this.camTransition.t * (3 - 2 * this.camTransition.t);
      this.camera.position.lerpVectors(this.camTransition.fromPos, this.camTransition.toPos, s);
      this.controls.target.lerpVectors(this.camTransition.fromTarget, this.camTransition.toTarget, s);
      if (this.camTransition.t >= 1) {
        this.camTransition = null;
      }
    }
    this.controls.update();

    if (this.currentSpec) {
      const phaseInfo = this.currentSpec.phases[this.phaseIndex];
      const simDuration = phaseInfo.durationSec > 15 ? 12 : phaseInfo.durationSec;

      if (this.isPlaying && !this.isMistake) {
        this.phaseElapsed += dt * this.speed;
        if (this.phaseElapsed >= simDuration) {
          this.phaseElapsed = 0;
          this.phaseIndex = (this.phaseIndex + 1) % 4;
        }
      }

      const activeInfo = this.currentSpec.phases[this.phaseIndex];
      const activeSimDur = activeInfo.durationSec > 15 ? 12 : activeInfo.durationSec;
      const progress = THREE.MathUtils.clamp(this.phaseElapsed / activeSimDur, 0, 1);
      const pose = this.computeCurrentPose(this.currentSpec, activeInfo.id, this.isPlaying ? progress : 1.0);

      this.rig.applyPose(pose);
      this.props.updateDynamicProps(this.rig);
      const { strainRatio, elongationPct } = this.muscles.update(
        this.rig,
        activeInfo.id,
        this.isMistake,
        this.totalElapsed
      );
      const w = this.container.clientWidth;
      const h = this.container.clientHeight;
      const angleDeg = this.overlays.update(
        this.rig,
        this.camera,
        w,
        h,
        activeInfo.id,
        this.isMistake,
        this.totalElapsed,
        this.showLabels
      );

      if (this.onTelemetry) {
        const scaledRemaining = Math.max(0, activeInfo.durationSec * (1 - progress));
        this.onTelemetry({
          phase: activeInfo.id,
          phaseIndex: this.phaseIndex,
          phaseRemainingSec: scaledRemaining,
          phaseDurationSec: activeInfo.durationSec,
          phaseProgress: progress,
          angleDeg,
          strainRatio,
          elongationPct,
          isPlaying: this.isPlaying,
          isMistake: this.isMistake,
        });
      }
    }

    this.renderer.render(this.scene, this.camera);
  };

  public dispose(): void {
    cancelAnimationFrame(this.rafId);
    this.resizeObserver.disconnect();
    this.muscles.clear();
    this.renderer.dispose();
  }
}
