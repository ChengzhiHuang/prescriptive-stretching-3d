import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Box3, BoxGeometry, Mesh, SkinnedMesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ALL_STRETCH_3D_LIST, STRETCH_3D_SPECS } from '../data/stretches/index.ts';
import { HumanRig, interpolatePoses } from '../engine/HumanRig.ts';
import { MuscleSystem } from '../engine/MuscleSystem.ts';
import { PropSystem } from '../engine/PropSystem.ts';

const MAX_PENETRATION = 0.005;
const SAMPLES_PER_TRANSITION = 51;
const ALL_EXERCISE_SAMPLES = 21;
const SEATED_EXERCISES = new Map([
  ['upper-trapezius', 'chair'],
  ['sternocleidomastoid', 'chair'],
  ['scalenes', 'chair'],
  ['suboccipitals', 'chair'],
  ['levator-scapulae-1', 'chair'],
  ['levator-scapulae-2', 'chair'],
  ['pectoralis-minor-seated', 'bench'],
  ['middle-trapezius-rhomboids-seated', 'bench'],
  ['latissimus-dorsi-seated', 'chair'],
  ['piriformis-seated', 'chair'],
  ['quadratus-lumborum-seated', 'chair'],
]);
const TRANSITIONS = [
  ['setup', 'stretch'],
  ['stretch', 'resist'],
  ['resist', 'deepen'],
  ['deepen', 'setup'],
  ['setup', 'mistake'],
];

async function loadSkinnedSurface(rig) {
  const bytes = await readFile('src/assets/human.glb');
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const { scene } = await new GLTFLoader().parseAsync(buffer, '');
  const meshes = scene.getObjectsByProperty('isSkinnedMesh', true);
  assert.equal(meshes.length, 1, 'Expected one skinned human mesh');
  const [source] = meshes;
  scene.updateMatrixWorld(true);
  const geometry = source.geometry.applyMatrix4(source.bindMatrix);
  const jointNames = source.skeleton.bones.map((bone) => bone.name);
  assert(rig.attachSurface({ geometry, jointNames }), 'Could not bind human mesh to the exercise rig');
  const surface = rig.root.getObjectByName('HumanSurface');
  assert(surface instanceof SkinnedMesh);
  return surface;
}

function supportBounds(spec, type) {
  const prop = spec.props.find((item) => item.type === type);
  assert(prop, `Missing ${type} for ${spec.slug}`);
  const props = new PropSystem();
  props.setProps([prop]);
  props.group.updateMatrixWorld(true);
  const panels = [];
  props.group.traverse((object) => {
    if (object instanceof Mesh && object.geometry instanceof BoxGeometry) {
      const bounds = new Box3().setFromObject(object);
      const size = bounds.getSize(new Vector3());
      const area = size.x * (type === 'wall' ? size.y : size.z);
      panels.push({ bounds, area });
    }
  });
  // The chair seat and wall panel are the largest faces on their contact planes.
  panels.sort((a, b) => b.area - a.area);
  assert(panels.length > 0, `Missing support surface for ${type}`);
  return panels[0].bounds;
}

function minimum(points, predicate, axis) {
  let value = Infinity;
  for (const point of points) {
    if (predicate(point)) value = Math.min(value, point[axis]);
  }
  return value;
}

function insideFootprint(point, bounds) {
  return point.x >= bounds.min.x && point.x <= bounds.max.x &&
    point.z >= bounds.min.z && point.z <= bounds.max.z;
}

function figureFourGap(leftThigh, rightShin) {
  // Estimate contact from signed vertical distances between nearby skin vertices at the left knee.
  const nearKnee = ({ x, y, z }) => x > 0.07 && x < 0.20 && z > 0.29 && z < 0.52 && y > 0.35 && y < 0.68;
  const upperThigh = leftThigh.filter(nearKnee);
  const lowerShin = rightShin.filter(nearKnee);
  let gap = Infinity;
  for (const left of upperThigh) {
    for (const right of lowerShin) {
      if (Math.hypot(left.x - right.x, left.z - right.z) < 0.009) {
        gap = Math.min(gap, right.y - left.y);
      }
    }
  }
  return gap;
}

function validatePiriformisElongation(rig, spec) {
  const muscles = new MuscleSystem();
  muscles.loadFascicles(spec.fascicles, rig);
  const [setup, stretch, deepen, mistake] = ['setup', 'stretch', 'deepen', 'mistake'].map((phase) => {
    rig.applyPose(spec.poses[phase]);
    return muscles.measureAll(rig)['piriformis-sup'];
  });
  muscles.clear();
  assert(setup < stretch && stretch < deepen && mistake < stretch,
    'Seated piriformis should lengthen through the correct phases and measure shorter in the mistake pose');
}

function validateExercise(rig, surface, slug, supportType) {
  const spec = STRETCH_3D_SPECS[slug];
  assert.deepEqual(spec.phases.map(({ id, durationSec }) => [id, durationSec]), [
    ['setup', 6], ['stretch', 8], ['resist', 6], ['deepen', 8],
  ], `${slug} PNF phases and durations`);
  assert.deepEqual(spec.poses.stretch, spec.poses.resist, `${slug} PNF resist pose must be stationary`);
  if (slug === 'piriformis-seated') validatePiriformisElongation(rig, spec);

  const support = supportBounds(spec, supportType);
  const rest = surface.geometry.getAttribute('position');
  const vertices = Array.from({ length: rest.count }, (_, index) => ({
    bind: new Vector3().fromBufferAttribute(rest, index),
    posed: new Vector3(),
  }));
  const points = vertices.map(({ posed }) => posed);
  const region = (select) => vertices.filter(({ bind }) => select(bind)).map(({ posed }) => posed);
  const leftSole = region(({ x, y }) => x > 0 && y < 0.075);
  const leftThigh = region(({ x, y }) => x > 0 && y > 0.30 && y < 0.56);
  const rightShin = region(({ x, y }) => x < 0 && y < 0.41);
  const rightFoot = region(({ x, y }) => x < 0 && y < 0.10);
  const rightKnee = region(({ x, y }) => x < 0 && y > 0.39 && y < 0.51);
  const inWallProjection = ({ x, y }) =>
    x >= support.min.x && x <= support.max.x && y >= support.min.y && y <= support.max.y;
  const overSeat = ({ x, y, z }) =>
    x >= support.min.x && x <= support.max.x && z >= support.min.z && z <= support.max.z && y > 0.18;
  const all = () => true;
  const ranges = new Map();
  const lastSample = SAMPLES_PER_TRANSITION - 1;

  for (const [from, to] of TRANSITIONS) {
    for (let sample = 0; sample <= lastSample; sample++) {
      const context = `${slug} ${from}→${to} sample ${sample}/${lastSample}`;
      const check = (label, distance, maxGap) => {
        assert(Number.isFinite(distance) && distance >= -MAX_PENETRATION && distance <= maxGap,
          `${context}: ${label} gap ${(distance * 1000).toFixed(1)} mm`);
        const range = ranges.get(label) ?? [distance, distance];
        ranges.set(label, [Math.min(range[0], distance), Math.max(range[1], distance)]);
      };

      rig.applyPose(interpolatePoses(spec.poses[from], spec.poses[to], sample / lastSample));
      for (let index = 0; index < points.length; index++) {
        surface.getVertexPosition(index, points[index]).applyMatrix4(surface.matrixWorld);
      }

      // The support plane is y = 0. The visible floor sits 2 mm below it.
      check('lowest body point', minimum(points, all, 'y'), Infinity);
      check('left sole', minimum(leftSole, all, 'y'), 0.010);
      if (supportType === 'chair') {
        check('seat', minimum(points, overSeat, 'y') - support.max.y, 0.020);
        check('crossed-leg contact', figureFourGap(leftThigh, rightShin), 0.005);
      } else {
        check('right knee', minimum(rightKnee, all, 'y'), 0.010);
        check('right foot at wall', minimum(rightFoot, inWallProjection, 'z') - support.max.z, 0.020);
        check('closest body point at wall', minimum(points, inWallProjection, 'z') - support.max.z, Infinity);
      }
    }
  }
  const summary = [...ranges].map(([label, [min, max]]) =>
    `${label}: ${(min * 1000).toFixed(1)} to ${(max * 1000).toFixed(1)} mm`).join(', ');
  console.log(`✓ ${slug}: ${SAMPLES_PER_TRANSITION * TRANSITIONS.length} contact samples passed (${summary})`);
}

const rig = new HumanRig();
const surface = await loadSkinnedSurface(rig);
validateExercise(rig, surface, 'piriformis-seated', 'chair');
validateExercise(rig, surface, 'rectus-femoris-kneeling', 'wall');

function validateAllExercisesContacts(rigInstance, skinnedSurface) {
  const positions = skinnedSurface.geometry.getAttribute('position');
  const skinIndices = skinnedSurface.geometry.getAttribute('skinIndex');
  const skinWeights = skinnedSurface.geometry.getAttribute('skinWeight');
  const boneIndices = new Map(skinnedSurface.skeleton.bones.map((bone, index) => [bone.name, index]));
  const wristBones = ['wristR', 'wristL'].map((name) => boneIndices.get(name));
  const sideSupportRegions = Array.from({ length: positions.count }, (_, index) => {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const weight = (name) => {
      let total = 0;
      for (let component = 0; component < 4; component++) {
        if (skinIndices.getComponent(index, component) === boneIndices.get(name)) {
          total += skinWeights.getComponent(index, component);
        }
      }
      return total;
    };
    if (x < 0 && y < 0.075) return 'right foot';
    if (x < -0.035 && y > 0.79 && y < 0.96 && weight('pelvis') + weight('hipR') > 0.65) {
      return 'right hip';
    }
    if (weight('wristR') > 0.8 || (y > 0.97 && y < 1.07 && weight('elbowR') > 0.4)) {
      return 'right arm';
    }
    return null;
  });
  const point = new Vector3();

  for (const spec of ALL_STRETCH_3D_LIST) {
    const seatType = SEATED_EXERCISES.get(spec.slug);
    const seat = seatType ? supportBounds(spec, seatType) : null;
    const table = spec.slug === 'latissimus-dorsi-seated' || spec.slug === 'quadratus-lumborum-seated'
      ? supportBounds(spec, 'table') : null;
    const usesBenchForHandSupport = spec.slug === 'pectoralis-minor-seated';
    const usesSideSupport = spec.slug === 'quadratus-lumborum-lying';
    const lastSample = (table || usesBenchForHandSupport || usesSideSupport
      ? SAMPLES_PER_TRANSITION : ALL_EXERCISE_SAMPLES) - 1;
    for (const [from, to] of TRANSITIONS) {
      for (let sample = 0; sample <= lastSample; sample++) {
        rigInstance.applyPose(interpolatePoses(spec.poses[from], spec.poses[to], sample / lastSample));
        let minFloorY = Infinity;
        let minSeatGap = Infinity;
        let deepestTableIntersection = 0;
        let rightKneeTableGap = Infinity;
        const benchGaps = usesBenchForHandSupport ? { feet: [Infinity, Infinity], hands: [Infinity, Infinity] } : null;
        const sideGaps = usesSideSupport
          ? { 'right foot': Infinity, 'right hip': Infinity, 'right arm': Infinity } : null;
        for (let index = 0; index < positions.count; index++) {
          skinnedSurface.getVertexPosition(index, point).applyMatrix4(skinnedSurface.matrixWorld);
          if (point.y < minFloorY) minFloorY = point.y;
          if (seat && insideFootprint(point, seat) && point.y > 0.18) {
            minSeatGap = Math.min(minSeatGap, point.y - seat.max.y);
          }
          if (benchGaps && seat) {
            if (positions.getY(index) < 0.075) {
              const side = positions.getX(index) < 0 ? 0 : 1;
              benchGaps.feet[side] = Math.min(benchGaps.feet[side], point.y);
            }
            const side = wristBones.indexOf(skinIndices.getX(index));
            if (side >= 0 && insideFootprint(point, seat)) {
              benchGaps.hands[side] = Math.min(benchGaps.hands[side], point.y - seat.max.y);
            }
          }
          if (sideGaps && sideSupportRegions[index]) {
            const region = sideSupportRegions[index];
            sideGaps[region] = Math.min(sideGaps[region], point.y);
          }
          if (table && insideFootprint(point, table)) {
            deepestTableIntersection = Math.max(deepestTableIntersection, Math.min(
              point.y - table.min.y, table.max.y - point.y,
              point.x - table.min.x, table.max.x - point.x,
              point.z - table.min.z, table.max.z - point.z,
            ));
            const bindY = positions.getY(index);
            if (positions.getX(index) < 0 && bindY > 0.39 && bindY < 0.55 &&
                point.y <= table.min.y + MAX_PENETRATION) {
              rightKneeTableGap = Math.min(rightKneeTableGap, table.min.y - point.y);
            }
          }
        }
        const ctx = `${spec.slug} ${from}→${to} sample ${sample}/${lastSample}`;
        assert(
          minFloorY >= -MAX_PENETRATION,
          `${ctx}: floor penetration ${(minFloorY * 1000).toFixed(1)} mm`,
        );
        if (seat && Number.isFinite(minSeatGap)) {
          assert(
            minSeatGap >= -MAX_PENETRATION,
            `${ctx}: ${seatType} penetration ${(minSeatGap * 1000).toFixed(1)} mm`,
          );
        }
        if (table) {
          assert(
            deepestTableIntersection <= MAX_PENETRATION,
            `${ctx}: tabletop penetration ${(deepestTableIntersection * 1000).toFixed(1)} mm`,
          );
          assert(
            rightKneeTableGap <= 0.010,
            `${ctx}: right knee gap below table ${(rightKneeTableGap * 1000).toFixed(1)} mm`,
          );
        }
        if (benchGaps) {
          for (const [side, gap] of benchGaps.feet.entries()) {
            assert(gap <= 0.010, `${ctx}: ${side ? 'left' : 'right'} sole gap ${(gap * 1000).toFixed(1)} mm`);
          }
          for (const [side, gap] of benchGaps.hands.entries()) {
            assert(gap <= 0.010, `${ctx}: ${side ? 'left' : 'right'} palm gap ${(gap * 1000).toFixed(1)} mm`);
          }
        }
        if (sideGaps) {
          for (const [region, gap] of Object.entries(sideGaps)) {
            assert(gap <= 0.025, `${ctx}: ${region} gap ${(gap * 1000).toFixed(1)} mm`);
          }
        }
      }
    }
  }
  console.log(`✓ All ${ALL_STRETCH_3D_LIST.length}/40 exercises passed floor and prop contact checks (at least ${ALL_EXERCISE_SAMPLES * TRANSITIONS.length} samples/exercise)`);
  console.log(`✓ All four corrected exercises passed support checks (${SAMPLES_PER_TRANSITION * TRANSITIONS.length} samples/exercise)`);
}

validateAllExercisesContacts(rig, surface);
