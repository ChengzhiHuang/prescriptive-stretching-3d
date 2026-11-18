import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ContactShadows } from './ContactShadows';
import { HumanRig, sampleTransition } from './HumanRig';
import { MuscleSystem } from './MuscleSystem';
import { Overlays3D } from './Overlays3D';
import { PropSystem } from './PropSystem';
import type { CameraPreset, PnfPhaseId, PoseAngles, Stretch3DSpec } from './types';

export interface StageTelemetry {
  phase: PnfPhaseId;
  phaseIndex: number;
  phaseRemainingSec: number;
  phaseDurationSec: number;
  relaxing: boolean;
  phaseProgress: number;
  angleDeg: number;
  strainRatio: number;
  elongationPct: number;
  isPlaying: boolean;
  isMistake: boolean;
}

interface StageOptions {
  mobile?: boolean;
  onFirstFrame?: () => void;
  onContextLost?: () => void;
  onContextRestored?: () => void;
  onRenderError?: (error: unknown) => void;
}

const TRANSITION_SECONDS = 1.2;
const PHASE_ORDER: PnfPhaseId[] = ['setup', 'stretch', 'resist', 'deepen'];

const BODY_EXTENT_SOCKETS: ReadonlyArray<{ name: string; radius: number; yBias?: number }> = [
  { name: 'vertex', radius: 0.08, yBias: 0.04 },
  { name: 'forehead', radius: 0.055 },
  { name: 'occiput', radius: 0.055 },
  { name: 'acromionR', radius: 0.07 },
  { name: 'acromionL', radius: 0.07 },
  { name: 'elbow_jointR', radius: 0.05 },
  { name: 'elbow_jointL', radius: 0.05 },
  { name: 'handR', radius: 0.06 },
  { name: 'handL', radius: 0.06 },
  { name: 'pelvis_center', radius: 0.095 },
  { name: 'ischial_tuberosityR', radius: 0.06 },
  { name: 'ischial_tuberosityL', radius: 0.06 },
  { name: 'knee_jointR', radius: 0.06 },
  { name: 'knee_jointL', radius: 0.06 },
  { name: 'calcaneusR', radius: 0.045, yBias: -0.015 },
  { name: 'calcaneusL', radius: 0.045, yBias: -0.015 },
  { name: 'forefootR', radius: 0.05, yBias: -0.015 },
  { name: 'forefootL', radius: 0.05, yBias: -0.015 },
];

interface BodyExtentSample {
  pos: THREE.Vector3;
  radius: number;
}

export class Stage3D {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private rig: HumanRig;
  private muscles: MuscleSystem;
  private props: PropSystem;
  private overlays: Overlays3D;
  private readonly contactShadows: ContactShadows;

  private container: HTMLElement;
  private currentSpec: Stretch3DSpec | null = null;
  private activePreset: CameraPreset | null = null;
  private actionBodySamples: BodyExtentSample[] = [];
  private actionSampleCount = 0;
  private actionBodyBox = new THREE.Box3();
  private userMovedCamera = false;
  private mobile: boolean;

  private phaseIndex = 1;
  private phaseElapsed = 0;
  private isPlaying = true;
  private playbackSuspended = false;
  private speed = 1.0;
  private isMistake = false;
  private showLabels: boolean;

  private camTransition: {
    fromPos: THREE.Vector3;
    toPos: THREE.Vector3;
    fromTarget: THREE.Vector3;
    toTarget: THREE.Vector3;
    t: number;
  } | null = null;

  private rafId = 0;
  private holdTimer = 0;
  private stageDirty = true;
  private lastPose?: PoseAngles;
  private lastSample = NaN;
  private lastPhase?: PnfPhaseId;
  private relaxing = false;
  private mistakeElapsed = 0;
  private xray = false;
  private muscleReading = { strainRatio: 0, elongationPct: 0 };
  private lastTime = 0;
  private totalElapsed = 0;
  private viewportWidth = 0;
  private viewportHeight = 0;
  private viewportPortrait = false;
  private disposed = false;
  private contextLost = false;
  private renderFailed = false;
  private hasRendered = false;
  private resizeObserver: ResizeObserver;
  public onTelemetry?: (t: StageTelemetry) => void;

  constructor(
    canvasContainer: HTMLElement,
    private readonly overlayContainer: HTMLElement,
    private readonly options: StageOptions = {},
  ) {
    this.container = canvasContainer;
    this.mobile = options.mobile ?? false;
    this.showLabels = !this.mobile;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x101827);

    this.camera = new THREE.PerspectiveCamera(36, 1, 0.08, 28);
    this.camera.position.set(0.95, 1.25, 2.25);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: this.mobile ? 'default' : 'high-performance',
    });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.02;
    const canvas = this.renderer.domElement;
    Object.assign(canvas.style, { display: 'block', width: '100%', height: '100%' });
    canvasContainer.appendChild(canvas);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.65;
    this.controls.maxDistance = this.mobile ? 10 : 6.5;
    this.controls.target.set(0, 0.9, 0);
    this.controls.addEventListener('change', this.invalidate);
    this.controls.addEventListener('start', () => {
      this.userMovedCamera = true;
      this.camTransition = null;
    });

    canvas.addEventListener('dblclick', this.handleDoubleClick);
    canvas.addEventListener('webglcontextlost', this.handleContextLost);
    canvas.addEventListener('webglcontextrestored', this.handleContextRestored);

    // Studio lighting
    const hemi = new THREE.HemisphereLight(0xe8eef5, 0x637384, 1.35);
    this.scene.add(hemi);

    const keyLight = new THREE.DirectionalLight(0xfff4e9, 1.15);
    keyLight.position.set(2.2, 3.4, 2.6);
    this.scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0xc6def9, 0.72);
    rimLight.position.set(-2.4, 2.0, -2.2);
    this.scene.add(rimLight);

    // Floor platform & subtle anatomical alignment grid
    const floorDisc = new THREE.Mesh(
      new THREE.CircleGeometry(1.75, 48),
      new THREE.MeshStandardMaterial({ color: 0x172232, roughness: 1 })
    );
    floorDisc.rotation.x = -Math.PI / 2;
    floorDisc.position.y = -0.002;
    this.scene.add(floorDisc);

    const grid = new THREE.GridHelper(2.4, 12, 0x526075, 0x3b4a60);
    grid.position.y = 0.001;
    grid.renderOrder = -2;
    grid.material.transparent = true;
    grid.material.opacity = 0.22;
    grid.material.depthWrite = false;
    this.scene.add(grid);

    this.contactShadows = new ContactShadows();
    this.props = new PropSystem();
    this.rig = new HumanRig();
    this.muscles = new MuscleSystem();
    this.muscles.group.visible = this.xray;
    this.overlays = new Overlays3D(overlayContainer);

    this.scene.add(this.props.group);
    this.scene.add(this.contactShadows.group);
    this.scene.add(this.rig.root);
    this.scene.add(this.muscles.group);
    this.scene.add(this.overlays.group);

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(canvasContainer);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    this.handleResize();
    void this.loadHumanSurface();
    this.resumeFrames();
  }

  public loadStretch(spec: Stretch3DSpec, initialPhase: PnfPhaseId = 'setup', mistake = false): void {
    this.currentSpec = spec;
    this.isMistake = mistake;
    this.phaseIndex = Math.max(0, PHASE_ORDER.indexOf(initialPhase));
    this.phaseElapsed = 0;
    this.userMovedCamera = false;

    this.lastPose = undefined;
    this.lastPhase = undefined;
    this.relaxing = false;
    this.mistakeElapsed = this.isPlaying ? 0 : 1.2;
    this.lastTime = performance.now();
    this.invalidate();
    this.rig.setTargetMuscles(spec.fascicles);
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

    this.overlays.loadStretch(spec, this.isMistake);

    this.activePreset = spec.cameras[0] ?? null;
    if (this.activePreset) {
      this.applyCameraPreset(this.activePreset, true);
    } else {
      this.fitFullBody(true);
    }
  }

  public getActivePreset(): CameraPreset | null {
    return this.activePreset;
  }

  /**
   * Samples key anatomical sockets with spherical silhouette envelopes across key poses,
   * reusing a pre-allocated sample pool to eliminate per-switch heap/GC churn.
   */
  private sampleActionBodyBounds(spec: Stretch3DSpec): void {
    this.actionSampleCount = 0;
    this.actionBodyBox.makeEmpty();
    const { setup, stretch, resist, deepen, mistake } = spec.poses;
    const poses = [
      setup,
      stretch,
      resist,
      deepen,
      mistake,
      sampleTransition(spec, 'setup', 'stretch', 0.5),
      sampleTransition(spec, 'resist', 'deepen', 0.5),
    ];
    const tmp = new THREE.Vector3();
    const boxMin = new THREE.Vector3();
    const boxMax = new THREE.Vector3();

    for (const p of poses) {
      this.rig.applyPose(p);
      for (const sSpec of BODY_EXTENT_SOCKETS) {
        this.rig.getSocketWorldPos(sSpec.name, tmp);
        if (sSpec.yBias) tmp.y += sSpec.yBias;

        let sample = this.actionBodySamples[this.actionSampleCount];
        if (!sample) {
          sample = { pos: new THREE.Vector3(), radius: sSpec.radius };
          this.actionBodySamples.push(sample);
        }
        sample.pos.copy(tmp);
        sample.radius = sSpec.radius;
        this.actionSampleCount++;

        boxMin.set(tmp.x - sSpec.radius, tmp.y - sSpec.radius, tmp.z - sSpec.radius);
        boxMax.set(tmp.x + sSpec.radius, tmp.y + sSpec.radius, tmp.z + sSpec.radius);
        this.actionBodyBox.expandByPoint(boxMin);
        this.actionBodyBox.expandByPoint(boxMax);
      }
    }
  }

  /**
   * Computes an aspect-aware, HUD-safe camera position and target along `viewDir`
   * so that every sampled anatomical envelope fits cleanly inside the viewport safe zone.
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
    const right = new THREE.Vector3().crossVectors(forward, this.camera.up);
    if (right.lengthSq() < 1e-12) right.set(1, 0, 0);
    right.normalize();
    const camUp = new THREE.Vector3().crossVectors(right, forward).normalize();

    // Desktop has floating controls. The mobile controls are outside the canvas.
    const safeFracY = this.mobile ? 0.9 : Math.max(0.56, 1.0 - 135 / Math.max(1, this.viewportHeight));
    const safeFracX = this.mobile ? 0.88 : Math.max(0.66, 1.0 - 110 / Math.max(1, this.viewportWidth));

    const halfFovV = THREE.MathUtils.degToRad(this.camera.fov * 0.5);
    const tanV = Math.tan(halfFovV) * safeFracY;
    const tanH = Math.tan(halfFovV) * this.camera.aspect * safeFracX;
    const rel = new THREE.Vector3();

    // Iteratively refine target along camUp/right so body sits centered in the safe box at minimal distance
    for (let iter = 0; iter < 2; iter++) {
      let minU = Infinity;
      let maxU = -Infinity;
      let minR = Infinity;
      let maxR = -Infinity;

      for (let i = 0; i < this.actionSampleCount; i++) {
        const sample = this.actionBodySamples[i];
        rel.copy(sample.pos).sub(target);
        const u = rel.dot(camUp);
        const r = rel.dot(right);
        if (u - sample.radius < minU) minU = u - sample.radius;
        if (u + sample.radius > maxU) maxU = u + sample.radius;
        if (r - sample.radius < minR) minR = r - sample.radius;
        if (r + sample.radius > maxR) maxR = r + sample.radius;
      }

      if (Number.isFinite(minU) && Number.isFinite(maxU)) {
        const midU = (minU + maxU) * 0.5;
        const midR = (minR + maxR) * 0.5;
        target.addScaledVector(camUp, midU * 0.85);
        target.addScaledVector(right, midR * 0.65);
      }
    }

    let requiredDist = 1.15;
    const minimumTangent = this.mobile ? 0.08 : 0.12;
    for (let i = 0; i < this.actionSampleCount; i++) {
      const sample = this.actionBodySamples[i];
      rel.copy(sample.pos).sub(target);
      const depthTowardsCam = rel.dot(viewDir) + sample.radius;
      const u = Math.abs(rel.dot(camUp)) + sample.radius;
      const r = Math.abs(rel.dot(right)) + sample.radius;
      const dV = u / Math.max(minimumTangent, tanV) + depthTowardsCam;
      const dH = r / Math.max(minimumTangent, tanH) + depthTowardsCam;
      requiredDist = Math.max(requiredDist, dV, dH);
    }

    // Add 6% breathing room so force arrows and floating callouts have comfortable clearance
    requiredDist = Math.min(requiredDist * 1.06, this.mobile ? 8.5 : 5.2);

    const pos = target.clone().addScaledVector(viewDir, requiredDist);
    if (pos.y < 0.16) pos.y = 0.16;
    return { pos, target };
  }

  public setCameraPreset(preset: CameraPreset, instant = false): void {
    this.activePreset = preset;
    this.userMovedCamera = false;
    this.applyCameraPreset(preset, instant);
  }

  private applyCameraPreset(preset: CameraPreset, instant: boolean): void {
    const rawPos = new THREE.Vector3(...preset.position);
    const rawTarget = new THREE.Vector3(...preset.target);
    const viewDir = rawPos.clone().sub(rawTarget);

    const isPrimaryPreset = preset === this.currentSpec?.cameras[0];
    const isFocusedCloseup =
      !isPrimaryPreset && (preset.label.includes('特写') || viewDir.length() < 1.52);
    let finalPos: THREE.Vector3;
    let finalTarget: THREE.Vector3;

    if (this.actionSampleCount > 0 && !isFocusedCloseup) {
      const framed = this.computeFramedCamera(viewDir, rawTarget, 0.75);
      finalPos = framed.pos;
      finalTarget = framed.target;
    } else if (this.actionSampleCount > 0 && isFocusedCloseup) {
      // Compensate narrow portrait aspect or short landscape height so close-ups never clip shoulders/hands
      const narrowComp = this.camera.aspect < 0.88 ? 0.88 / Math.max(0.45, this.camera.aspect) : 1.0;
      const shortComp = this.viewportHeight > 0 && this.viewportHeight < 440 ? 440 / this.viewportHeight : 1.0;
      const distScale = THREE.MathUtils.clamp(Math.max(narrowComp, shortComp) * 1.04, 1.0, 1.48);
      finalTarget = rawTarget;
      finalPos = rawTarget.clone().addScaledVector(viewDir, distScale);
    } else {
      finalPos = rawPos;
      finalTarget = rawTarget;
    }

    this.moveCamera(finalPos, finalTarget, instant);
  }

  private moveCamera(pos: THREE.Vector3, target: THREE.Vector3, instant: boolean): void {
    this.invalidate();
    if (instant) {
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.controls.update();
      this.camTransition = null;
      return;
    }

    this.camTransition = {
      fromPos: this.camera.position.clone(),
      toPos: pos,
      fromTarget: this.controls.target.clone(),
      toTarget: target,
      t: 0,
    };
  }

  /**
   * Re-frames the full body cleanly along the current camera viewing angle (or active preset).
   */
  public fitFullBody(instant = false): void {
    if (this.actionSampleCount === 0) return;
    this.activePreset = null;
    this.userMovedCamera = false;
    const curDir = this.camera.position.clone().sub(this.controls.target);
    if (curDir.lengthSq() < 1e-4) curDir.set(0.8, 0.4, 1.4);
    const framed = this.computeFramedCamera(curDir);
    this.moveCamera(framed.pos, framed.target, instant);
  }

  public setPhase(phase: PnfPhaseId, pauseAuto = false): void {
    const idx = PHASE_ORDER.indexOf(phase);
    if (idx >= 0) {
      this.phaseIndex = idx;
      this.lastPose = undefined;
      this.phaseElapsed = 0;
      this.relaxing = false;
      if (this.isMistake) this.mistakeElapsed = 1.2;
      this.lastTime = performance.now();
      this.invalidate();
      if (pauseAuto) {
        this.isPlaying = false;
      }
    }
  }

  public setPlaying(playing: boolean): void {
    this.captureTime();
    this.isPlaying = playing;
    this.invalidate();
  }

  public setPlaybackSuspended(suspended: boolean): void {
    this.captureTime();
    this.playbackSuspended = suspended;
    this.invalidate();
  }

  public togglePlaying(): boolean {
    this.setPlaying(!this.isPlaying);
    return this.isPlaying;
  }

  public setSpeed(speed: number): void {
    this.captureTime();
    this.speed = speed;
    this.invalidate();
  }

  public setMistakeMode(mistake: boolean): void {
    if (this.isMistake === mistake) return;
    this.isMistake = mistake;
    this.mistakeElapsed = this.isPlaying ? 0 : 1.2;
    this.lastPose = undefined;
    this.invalidate();
    this.overlays.rebuildCallouts(mistake);
  }

  public setShowLabels(show: boolean): void {
    this.showLabels = show;
    this.invalidate();
  }

  public setXrayMode(xray: boolean): void {
    if (this.xray === xray) return;
    this.xray = xray;
    this.muscles.group.visible = xray;
    this.rig.setXrayMode(xray);
    this.lastPose = undefined;
    this.invalidate();
  }

  private async loadHumanSurface(): Promise<void> {
    try {
      const { loadHumanSurface } = await import('./HumanSurface');
      if (this.disposed) return;
      const surface = await loadHumanSurface();
      if (this.disposed || !this.rig.attachSurface(surface)) {
        surface.geometry.dispose();
      } else {
        this.lastPose = undefined;
        this.invalidate();
      }
    } catch {
      // The procedural rig remains usable if the visual asset fails to load.
    }
  }

  private computeCurrentPose(spec: Stretch3DSpec, phase: PnfPhaseId, elapsed: number): PoseAngles {
    if (this.isMistake) {
      const time = this.mistakeElapsed % 5;
      const amount = time < 1.2 ? time / 1.2 : time < 3.5 ? 1 : Math.max(0, 1 - (time - 3.5) / 1.2);
      return sampleTransition(spec, 'setup', 'mistake', amount);
    }

    const resist = spec.phases[2];
    const returnsDuringRest = spec.technique.resistance === 'move' && !!resist.relaxSec;
    if (phase === 'resist' && returnsDuringRest && elapsed >= resist.durationSec) {
      return sampleTransition(spec, 'resist', 'stretch', Math.min(1, (elapsed - resist.durationSec) / TRANSITION_SECONDS));
    }
    const t = Math.min(1, 1 + elapsed / TRANSITION_SECONDS);
    if (t >= 1) return spec.poses[phase];
    const previous = PHASE_ORDER[(this.phaseIndex + PHASE_ORDER.length - 1) % PHASE_ORDER.length];
    return sampleTransition(spec, phase === 'deepen' && returnsDuringRest ? 'stretch' : previous, phase, t);
  }

  public setMobile(mobile: boolean): void {
    if (this.mobile === mobile) return;
    this.mobile = mobile;
    this.controls.maxDistance = mobile ? 10 : 6.5;
    this.handleResize(true);
  }

  private handleResize(forceRefit = false): void {
    if (this.disposed || this.contextLost || this.renderFailed) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    const ratio = Math.min(window.devicePixelRatio || 1, this.mobile ? 1.5 : 2);
    if (ratio !== this.renderer.getPixelRatio()) this.renderer.setPixelRatio(ratio);

    const activeEl = document.activeElement;
    const isTextInputFocused =
      activeEl instanceof HTMLInputElement ||
      activeEl instanceof HTMLTextAreaElement ||
      (activeEl instanceof HTMLElement && activeEl.isContentEditable);
    const widthUnchanged = this.viewportWidth > 0 && Math.abs(w - this.viewportWidth) <= 2;
    const keyboardResize = this.mobile && isTextInputFocused && widthUnchanged && h < this.viewportHeight;

    const portrait = keyboardResize ? this.viewportPortrait : window.innerWidth <= window.innerHeight;
    const orientationChanged = !keyboardResize && portrait !== this.viewportPortrait;
    if (!forceRefit && !orientationChanged && w === this.viewportWidth && h === this.viewportHeight) return;

    this.viewportWidth = w;
    this.viewportHeight = h;
    this.viewportPortrait = portrait;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.invalidate();

    // Avoid resetting camera while soft keyboard is open or drawer has suspended playback without width change
    if (keyboardResize || (this.mobile && this.playbackSuspended && widthUnchanged && !forceRefit)) {
      return;
    }

    if (this.userMovedCamera) {
      if (this.mobile && (forceRefit || orientationChanged)) this.fitFullBody(true);
    } else if (this.activePreset) {
      this.applyCameraPreset(this.activePreset, true);
    } else {
      this.fitFullBody(true);
    }
  }

  private handleDoubleClick = (): void => {
    this.fitFullBody(false);
  };

  private handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextLost = true;
    this.hasRendered = false;
    this.stopFrames();
    this.options.onContextLost?.();
  };

  private handleContextRestored = (): void => {
    this.contextLost = false;
    this.options.onContextRestored?.();
    this.handleResize();
    this.lastTime = performance.now();
    this.invalidate();
  };

  private handleVisibilityChange = (): void => {
    if (document.hidden) this.stopFrames();
    else {
      this.lastTime = performance.now();
      this.invalidate();
    }
  };

  private canRender(): boolean {
    return !this.disposed && !this.contextLost && !this.renderFailed && !document.hidden;
  }

  private stopFrames(): void {
    clearTimeout(this.holdTimer);
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private invalidate = (): void => {
    this.stageDirty = true;
    clearTimeout(this.holdTimer);
    this.resumeFrames();
  };

  private resumeFrames(): void {
    if (this.rafId || !this.canRender()) return;
    this.rafId = requestAnimationFrame(this.animate);
  }

  private animate = (now: number): void => {
    this.rafId = 0;
    if (!this.canRender()) return;
    const dt = this.lastTime ? Math.max(0, (now - this.lastTime) / 1000) : 0;
    this.lastTime = now;

    try {
      this.drawFrame(dt);
    } catch (error) {
      this.renderFailed = true;
      this.options.onRenderError?.(error);
      return;
    }

    if (!this.hasRendered && this.currentSpec && this.viewportWidth > 0 && !this.renderer.getContext().isContextLost()) {
      this.hasRendered = true;
      this.options.onFirstFrame?.();
    }

  };

  private advanceClock(dt: number): void {
    if (!this.isPlaying || this.playbackSuspended || !this.currentSpec) return;
    this.totalElapsed += dt;
    if (this.isMistake) {
      this.mistakeElapsed += dt * this.speed;
      return;
    }
    const spec = this.currentSpec;
    this.phaseElapsed += dt * this.speed;
    let duration = spec.phases[this.phaseIndex].durationSec + (spec.phases[this.phaseIndex].relaxSec ?? 0);
    while (this.phaseElapsed >= duration) {
      this.phaseElapsed -= duration;
      this.phaseIndex = (this.phaseIndex + 1) % PHASE_ORDER.length;
      const next = spec.phases[this.phaseIndex];
      if (next.id !== 'resist' || spec.technique.resistance === 'move') this.phaseElapsed -= TRANSITION_SECONDS;
      duration = next.durationSec + (next.relaxSec ?? 0);
    }
  }

  private captureTime(): void {
    const now = performance.now();
    if (this.lastTime && this.canRender()) this.advanceClock(Math.max(0, now - this.lastTime) / 1000);
    this.lastTime = now;
  }

  private drawFrame(dt: number): void {
    const advancing = this.isPlaying && !this.playbackSuspended;
    this.advanceClock(dt);
    let redraw = this.stageDirty;
    this.stageDirty = false;

    if (this.camTransition) {
      this.camTransition.t = Math.min(1, this.camTransition.t + dt * 3.0);
      const s = this.camTransition.t * this.camTransition.t * (3 - 2 * this.camTransition.t);
      this.camera.position.lerpVectors(this.camTransition.fromPos, this.camTransition.toPos, s);
      this.controls.target.lerpVectors(this.camTransition.fromTarget, this.camTransition.toTarget, s);
      if (this.camTransition.t >= 1) {
        this.camTransition = null;
      }
    }
    const cameraMoved = this.controls.update();
    redraw ||= cameraMoved;

    if (this.currentSpec) {
      const spec = this.currentSpec;
      const activeInfo = spec.phases[this.phaseIndex];
      const relaxing = !!activeInfo.relaxSec && this.phaseElapsed >= activeInfo.durationSec;
      const restChanged = this.relaxing !== relaxing;
      this.relaxing = relaxing;
      const elapsed = Math.max(0, this.phaseElapsed);
      const progress = Math.min(1, elapsed / activeInfo.durationSec);
      const releasing = relaxing && activeInfo.id === 'resist' && spec.technique.resistance === 'move';
      const sample = this.isMistake ? this.mistakeElapsed : releasing
        ? 1 + Math.min(TRANSITION_SECONDS, elapsed - activeInfo.durationSec) : Math.min(0, this.phaseElapsed);
      const pose = this.lastPose && this.lastPhase === activeInfo.id && this.lastSample === sample
        ? this.lastPose : this.computeCurrentPose(spec, activeInfo.id, this.phaseElapsed);
      this.lastSample = sample;
      const poseChanged = pose !== this.lastPose;
      const phaseChanged = this.lastPhase !== activeInfo.id;
      const pulse = advancing && (this.isMistake || (this.xray && activeInfo.id === 'resist' && !relaxing));
      redraw ||= poseChanged || phaseChanged || restChanged || pulse;
      if (poseChanged) {
        this.rig.applyPose(pose);
        this.contactShadows.update(this.rig);
      }
      if (redraw) this.props.updateDynamicProps(this.rig, this.camera, poseChanged);
      if (poseChanged || phaseChanged || restChanged || (pulse && this.xray)) {
        this.muscleReading = this.muscles.update(this.rig, relaxing ? 'stretch' : activeInfo.id, this.isMistake, this.totalElapsed, poseChanged, this.xray);
      }
      const { strainRatio, elongationPct } = this.muscleReading;
      const angleDeg = redraw ? this.overlays.update(
        this.rig, this.camera, this.viewportWidth, this.viewportHeight, activeInfo.id,
        this.isMistake, this.totalElapsed, this.showLabels, this.xray, this.mobile, relaxing, poseChanged
      ) : this.overlays.angleDeg;
      this.lastPose = pose;
      this.lastPhase = activeInfo.id;

      const inTransition = this.phaseElapsed < 0 || (releasing && elapsed - activeInfo.durationSec < TRANSITION_SECONDS);
      if (this.camTransition || cameraMoved || (advancing && (inTransition || pulse))) {
        this.resumeFrames();
      } else if (advancing) {
        // Static holds only need the next integer countdown tick.
        const seconds = 1 - (elapsed % 1);
        this.holdTimer = window.setTimeout(() => this.resumeFrames(), Math.max(1, seconds * 1000 / this.speed));
      }

      if (this.onTelemetry) {
        const scaledRemaining = relaxing ? activeInfo.durationSec + activeInfo.relaxSec! - elapsed : activeInfo.durationSec - elapsed;
        this.onTelemetry({
          phase: activeInfo.id,
          phaseIndex: this.phaseIndex,
          phaseRemainingSec: scaledRemaining,
          phaseDurationSec: activeInfo.durationSec,
          phaseProgress: progress,
          relaxing,
          angleDeg,
          strainRatio,
          elongationPct,
          isPlaying: this.isPlaying,
          isMistake: this.isMistake,
        });
      }
    }

    if (redraw) this.renderer.render(this.scene, this.camera);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopFrames();
    this.resizeObserver.disconnect();
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('dblclick', this.handleDoubleClick);
    canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);
    this.controls.removeEventListener('change', this.invalidate);
    this.controls.dispose();
    this.props.dispose();
    this.rig.disposeSurface();

    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh || object instanceof THREE.Line)) return;
      geometries.add(object.geometry);
      const meshMaterials = Array.isArray(object.material) ? object.material : [object.material];
      meshMaterials.forEach((material) => materials.add(material));
    });
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    canvas.remove();
    this.overlayContainer.replaceChildren();
  }
}
