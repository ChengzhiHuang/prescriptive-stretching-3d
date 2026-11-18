import type { WindowLocation } from './AnatomicalWindow';

export type PnfPhaseId = 'setup' | 'stretch' | 'resist' | 'deepen';

export interface Euler3 {
  flex?: number;
  turnLeft?: number;
  tiltLeft?: number;
}

export interface SpineAngles {
  flex?: number;      // + = round/flex forward, - = arch/extend backward
  twistLeft?: number; // + = twist torso left, - = twist right
  leanLeft?: number;  // + = lateral bend left, - = lateral bend right
}

export interface ClavicleAngles {
  elevate?: number;  // + = shrug up, - = depress/lock down
  protract?: number; // + = protract forward, - = retract back
}

export interface BallJointAngles {
  flex?: number;   // + = flex forward, - = extend backward
  abduct?: number; // + = abduct away from midline, - = adduct across midline
  extRot?: number; // + = external rotation, - = internal rotation
}

export interface PoseAngles {
  /** Right and left hand closure, from open (0) to fist (1). */
  grip?: [number, number];
  rootPos?: [number, number, number];
  supportPath?: { spec: Stretch3DSpec; from: PoseId; to: PoseId; weight: number };
  rootYaw?: number;
  rootPitch?: number; // -90 = supine lying on back, +90 = prone
  rootRoll?: number;  // -90 = right-side lying (beach position), +90 = left-side lying
  pelvis?: {
    pitch?: number; // + = anterior pelvic tilt / hip hinge forward, - = posterior pelvic tuck
    yaw?: number;   // + = rotate left
    roll?: number;  // + = tilt left
  };
  lumbar?: SpineAngles;
  thoracic?: SpineAngles;
  neck?: Euler3;
  head?: Euler3;
  clavicleR?: ClavicleAngles;
  clavicleL?: ClavicleAngles;
  shoulderR?: BallJointAngles;
  shoulderL?: BallJointAngles;
  elbowR?: { flex?: number; pronate?: number };
  elbowL?: { flex?: number; pronate?: number };
  wristR?: { flex?: number; deviate?: number };
  wristL?: { flex?: number; deviate?: number };
  hipR?: BallJointAngles;
  hipL?: BallJointAngles;
  kneeR?: { flex?: number };
  kneeL?: { flex?: number };
  ankleR?: { dorsiflex?: number; invert?: number };
  ankleL?: { dorsiflex?: number; invert?: number };
}

export interface FascicleSpec {
  window: WindowLocation;
  id: string;
  label?: string;
  origin: string;
  via?: string[];
  insertion: string;
  radius: number;
  tendonRatio?: number; // 0.1..0.42 fraction of length rendered as ivory tendon
  role?: 'primary' | 'synergist' | 'nerve';
}

export interface AnchorCalloutSpec {
  socket: string;
  label: string;
  kind: 'lock' | 'origin' | 'insertion' | 'target' | 'warning';
  offset?: [number, number, number];
  phases?: PnfPhaseId[];
}

export interface ForceArrowSpec {
  socket: string;
  direction: [number, number, number]; // world-space unit/scaled direction
  length?: number;
  label: string;
  kind: 'effort' | 'reaction' | 'motion';
  phases: PnfPhaseId[];
}

export interface AngleGaugeSpec {
  vertexSocket: string;
  fromDir: [number, number, number];
  toSocket: string;
  labelPrefix: string;
  targetRangeLabel: string;
  radius?: number;
}

export interface PropSpec {
  showUnderside?: boolean; // See the knee contact through a desk top.
  type: 'chair' | 'doorframe' | 'bench' | 'step' | 'table' | 'wall' | 'corner-wall' | 'bar';
  position: [number, number, number];
  rotationY?: number;
  scale?: [number, number, number];
  attachSockets?: string[]; // optional dynamic cord/stick rendered between rig sockets
}

export interface CameraPreset {
  id: string;
  label: string;
  position: [number, number, number];
  target: [number, number, number];
}

export interface PhaseInfo {
  id: PnfPhaseId;
  stepNumber: number;
  title: string;
  durationSec: number;
  relaxSec?: number;
  cue: string;
  breathingTip: string;
}

export type PoseId = PnfPhaseId | 'mistake';
export type PlantedLimb = 'ankleR' | 'ankleL' | 'wristR' | 'wristL';

export interface Stretch3DSpec {
  /** End effectors that retain contact during transitions between the authored poses. */
  planted?: PlantedLimb[];
  /** Interpolate this contact in a moving bone's frame, e.g. a hand on the nape. */
  supportBone?: Partial<Record<PlantedLimb, string>>;
  /** The right elbow slides along the vertical inner face of a door jamb. */
  elbowOnJamb?: boolean;
  /** Clearance arc in the support frame for a planted extremity as the palm/sole turns. */
  supportArc?: { limb: PlantedLimb; offset: [number, number, number]; transitions?: [PoseId, PoseId][] };
  slug: string;
  nameZh: string;
  nameEn: string;
  regionName: string;
  printedPage: number;
  sourcePage: number;
  technique: {
    pages: string;
    /** Without a phase list the support is retained through all four correct steps. */
    contacts: { at: string; on: string; phases?: PnfPhaseId[] }[];
    support: string;
    movement: string;
    effort: string;
    resistance: 'hold' | 'move';
  };
  anatomySummary: {
    originZh: string;
    insertionZh: string;
    actionZh: string;
  };
  degreeGuide: {
    angleTarget: string;
    sensationTarget: string;
    stopRedFlags: string[];
  };
  props: PropSpec[];
  fascicles: FascicleSpec[];
  poses: {
    setup: PoseAngles;
    stretch: PoseAngles;
    resist: PoseAngles;
    deepen: PoseAngles;
    mistake: PoseAngles;
  };
  // Arm positions on the way from setup to a held pose, including the reverse release.
  approach?: Partial<Record<'stretch' | 'deepen' | 'mistake', PoseAngles>>;
  mistakeInfo: {
    title: string;
    description: string;
    overloadSocket: string;
    overloadLabel: string;
  };
  phases: [PhaseInfo, PhaseInfo, PhaseInfo, PhaseInfo];
  callouts: AnchorCalloutSpec[];
  mistakeCallouts?: AnchorCalloutSpec[];
  forceArrows: ForceArrowSpec[];
  angleGauge: AngleGaugeSpec;
  cameras: CameraPreset[];
}

export interface BookStretchEntry {
  order: number;
  slug: string;
  chinese: string;
  english: string;
  regionId: string;
  regionName: string;
  printedPage: string;
  sourcePageStart: number;
  has3D: boolean;
}

export interface BookIndexData {
  bookTitle: string;
  englishTitle: string;
  author: string;
  publisher: string;
  regions: {
    id: string;
    name: string;
    stretches: string[];
  }[];
  stretches: BookStretchEntry[];
  painPrograms: {
    chinese: string;
    english: string;
    category: 'waking' | 'program';
    printedPage: string;
    tip: string;
    recommendedStretches: string[];
  }[];
}
