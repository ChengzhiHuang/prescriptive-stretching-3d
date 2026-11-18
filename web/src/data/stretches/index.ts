import type { Stretch3DSpec } from '../../engine/types';
import neckShoulder from './regions/neck-shoulder';
import chestBack from './regions/chest-back';
import rotatorCuff from './regions/rotator-cuff';
import hipLumbar from './regions/hip-lumbar';
import thigh from './regions/thigh';
import calfArm from './regions/calf-arm';

export const ALL_STRETCH_3D_LIST = [
  ...neckShoulder,
  ...chestBack,
  ...rotatorCuff,
  ...hipLumbar,
  ...thigh,
  ...calfArm,
];

export const STRETCH_3D_SPECS: Record<string, Stretch3DSpec> = Object.fromEntries(
  ALL_STRETCH_3D_LIST.map((spec) => [spec.slug, spec])
);
