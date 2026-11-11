import type { Stretch3DSpec } from '../../engine/types';
import { calfUpperArmExtraSpecs } from './calfUpperArmExtra';
import { chestExtraSpecs } from './chestExtra';
import { forearmExtraSpecs } from './forearmExtra';
import { gastrocnemiusSpec } from './gastrocnemius';
import { hamstringsSpec } from './hamstrings';
import { hipLumbarExtraSpecs } from './hipLumbarExtra';
import { infraspinatus1Spec } from './infraspinatus1';
import { neckExtraSpecs } from './neckExtra';
import { pectoralisMajor1Spec } from './pectoralisMajor1';
import { piriformisSeatedSpec } from './piriformisSeated';
import { rotatorCuffExtraSpecs } from './rotatorCuffExtra';
import { thighExtraSpecs } from './thighExtra';
import { upperBackExtraSpecs } from './upperBackExtra';
import { upperTrapeziusSpec } from './upperTrapezius';

export const ALL_STRETCH_3D_LIST: Stretch3DSpec[] = [
  // Region 1: Neck & Shoulder (6)
  upperTrapeziusSpec,
  ...neckExtraSpecs,
  // Region 2: Chest & Upper Back (8)
  pectoralisMajor1Spec,
  ...chestExtraSpecs,
  ...upperBackExtraSpecs,
  // Region 3: Rotator Cuff & Shoulder (5)
  infraspinatus1Spec,
  ...rotatorCuffExtraSpecs,
  // Region 4: Glutes, Hip & Lumbar (7)
  ...hipLumbarExtraSpecs.slice(0, 3),
  piriformisSeatedSpec,
  ...hipLumbarExtraSpecs.slice(3),
  // Region 5: Thigh (6)
  ...thighExtraSpecs.slice(0, 3),
  hamstringsSpec,
  ...thighExtraSpecs.slice(3),
  // Region 6: Calf, Arm & Forearm (8)
  gastrocnemiusSpec,
  ...calfUpperArmExtraSpecs,
  ...forearmExtraSpecs,
];

export const STRETCH_3D_SPECS: Record<string, Stretch3DSpec> = Object.fromEntries(
  ALL_STRETCH_3D_LIST.map((spec) => [spec.slug, spec])
);
