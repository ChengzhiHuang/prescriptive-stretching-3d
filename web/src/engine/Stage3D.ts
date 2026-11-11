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
  private phaseIndex = 1; // start at primary stretch view on load so user immediately sees action, or auto-cycle!
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
    this.scene.background = new THREE.Color(0x0f172a);

    const w = Math.max(320, canvasContainer.clientWidth);
    const h = Math.max(280, canvasContainer.clientHeight);

    this.camera = new THREE.PerspectiveCamera(36, w / h, 0.08, 25);
    this.camera.position.set(0.95, 1.25, 2.05);

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
    this.controls.maxDistance = 4.6;
    this.controls.target.set(0, 0.95, 0);

    // Studio lighting
    const hemi = new THREE.HemisphereLight(0xe2e8f0, 0x1e293b, 1.25);
    this.scene.add(hemi);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.55);
    keyLight.position.set(2.2, 3.4, 2.6);
    this.scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x7dd3fc, 0.85);
    rimLight.position.set(-2.4, 2.0, -2.2);
    this.scene.add(rimLight);

    // Floor platform & subtle anatomical alignment grid
    const floorDisc = new THREE.Mesh(
      new THREE.CircleGeometry(1.65, 48),
      new THREE.MeshStandardMaterial({ color: 0x131e33, roughness: 0.9, metalness: 0.05 })
    );
    floorDisc.rotation.x = -Math.PI / 2;
    floorDisc.position.y = -0.002;
    this.scene.add(floorDisc);

    const grid = new THREE.GridHelper(2.8, 14, 0x334155, 0x1e293b);
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

    this.props.setProps(spec.props);
    this.muscles.loadFascicles(spec.fascicles, this.rig);

    // Calibrate setup rest length vs deepen max stretch length for accurate strain %
    this.rig.applyPose(spec.poses.setup);
    const setupLens = this.muscles.measureAll(this.rig);
    this.rig.applyPose(spec.poses.deepen);
    const deepenLens = this.muscles.measureAll(this.rig);
    this.muscles.calibrateLengths(this.rig, setupLens, deepenLens);

    this.overlays.loadStretch(spec);
    this.overlays.rebuildCallouts(this.isMistake);

    if (spec.cameras.length > 0) {
      this.setCameraPreset(spec.cameras[0], true);
    }
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

  public setCameraPreset(preset: CameraPreset, instant = false): void {
    if (instant) {
      this.camera.position.set(...preset.position);
      this.controls.target.set(...preset.target);
      this.controls.update();
      this.camTransition = null;
      return;
    }
    this.camTransition = {
      fromPos: this.camera.position.clone(),
      toPos: new THREE.Vector3(...preset.position),
      fromTarget: this.controls.target.clone(),
      toTarget: new THREE.Vector3(...preset.target),
      t: 0,
    };
  }

  private computeCurrentPose(spec: Stretch3DSpec, phase: PnfPhaseId, phaseProgress: number): PoseAngles {
    if (this.isMistake) {
      // Gently oscillate into the mistake compensation so user clearly sees the bad movement
      const osc = 0.65 + 0.35 * Math.sin(this.totalElapsed * 2.2);
      return interpolatePoses(spec.poses.setup, spec.poses.mistake, osc);
    }

    const rampWindow = 0.28; // smooth transition during first 28% of each phase, then hold steady!
    const t = Math.min(1, phaseProgress / rampWindow);

    switch (phase) {
      case 'setup':
        return interpolatePoses(spec.poses.deepen, spec.poses.setup, Math.min(1, phaseProgress / 0.35));
      case 'stretch':
        return interpolatePoses(spec.poses.setup, spec.poses.stretch, t);
      case 'resist':
        // Isometric contraction: zero joint motion, holds exact stretch end-feel position!
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
  }

  private animate = (): void => {
    this.rafId = requestAnimationFrame(this.animate);
    const now = performance.now();
    const dt = Math.min(0.08, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.totalElapsed += dt;

    if (this.camTransition) {
      this.camTransition.t = Math.min(1, this.camTransition.t + dt * 2.6);
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
      // Visual demo duration caps long 60s holds to 12s in 1x visual loop while displaying authentic countdown!
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
