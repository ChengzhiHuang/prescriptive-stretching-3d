import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Box3, BoxGeometry, CylinderGeometry, Mesh, SkinnedMesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ALL_STRETCH_3D_LIST, STRETCH_3D_SPECS } from '../data/stretches/index.ts';
import { HumanRig, sampleTransition } from '../engine/HumanRig.ts';
import { MuscleSystem } from '../engine/MuscleSystem.ts';
import { PropSystem } from '../engine/PropSystem.ts';

import { boxClearance, scalpProbe, vertexRegions } from './skinClearance.mjs';

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
  props.dispose();
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

function motionTransitions(spec) {
  return spec.technique.resistance === 'move' && spec.phases[2].relaxSec
    ? [...TRANSITIONS, ['resist', 'stretch'], ['stretch', 'deepen']] : TRANSITIONS;
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

      rig.applyPose(sampleTransition(spec, from, to, sample / lastSample));
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

// Use the same skinned surface and eased/IK path as the interactive viewer.
function validateTeachingContacts() {
  const regions = vertexRegions(surface);
  const scalp = scalpProbe(surface, regions);
  const p = new Vector3();
  rig.applyPose({});
  const inverse = surface.skeleton.boneInverses[surface.skeleton.bones.findIndex(b => b.name === 'wristR')];
  const palm = [], fingertips = [];
  for (const i of regions.get('wristR')) {
    p.fromBufferAttribute(surface.geometry.attributes.position, i).applyMatrix4(inverse);
    if (p.y < -0.040 && p.y > -0.086 && p.x > 0.010) palm.push(i);
    if (p.y < -0.093) fingertips.push(i);
  }
  const regionGap = (indices, box) => {
    let min = Infinity;
    for (const i of indices) {
      surface.getVertexPosition(i, p).applyMatrix4(surface.matrixWorld);
      min = Math.min(min, boxClearance(p, box));
    }
    return min;
  };
  const boxGap = (bone, box) => regionGap(regions.get(bone), box);
  const cases = [
    ['upper-trapezius', 'chair', 'wristR', 0.005],
    ['levator-scapulae-1', 'chair', 'wristR', 0.005],
    ['pectoralis-major-1', 'doorframe', 'wristR', 0.010],
    ['rectus-femoris-supine', 'bench', 'hipR', 0.010],
    ['gastrocnemius', 'step', 'ankleR', 0.005],
    ['forearm-extensors', 'table', 'wristR', 0.010],
  ];
  for (const [slug, prop, bone, maxGap] of cases) {
    const spec = STRETCH_3D_SPECS[slug];
    const bounds = prop === 'doorframe' ? jambBounds(spec) : supportBounds(spec, prop);
    rig.applyPose(spec.poses.setup);
    const pivotName = prop === 'step' ? 'forefootR' : 'handR';
    const initialPivot = rig.getSocketWorldPos(pivotName);
    const headContact = prop === 'chair';
    let minSupport = Infinity, maxSupport = -Infinity, minHead = Infinity;
    for (const [from, to] of TRANSITIONS) {
      for (let k = 0; k < SAMPLES_PER_TRANSITION; k++) {
        const t = k / (SAMPLES_PER_TRANSITION - 1);
        rig.applyPose(sampleTransition(spec, from, to, t));
        const context = `${slug} ${from}→${to} t=${t.toFixed(2)}`;
        const gap = boxGap(bone, bounds);
        assert(gap >= -MAX_PENETRATION && gap <= maxGap, `${context}: ${bone} support ${(gap * 1000).toFixed(1)} mm`);
        minSupport = Math.min(minSupport, gap);
        maxSupport = Math.max(maxSupport, gap);
        if ((headContact || prop === 'step') && from !== 'mistake' && to !== 'mistake') {
          const pivot = rig.getSocketWorldPos(pivotName);
          const slide = Math.hypot(pivot.x - initialPivot.x, pivot.z - initialPivot.z);
          assert(slide < 0.015, `${context}: planted contact slid ${(slide * 1000).toFixed(1)} mm`);
        }
        if (slug === 'rectus-femoris-supine' && to !== 'mistake') {
          const chestGap = boxGap('thoracic', bounds);
          assert(chestGap >= -MAX_PENETRATION && chestGap <= 0.012, `${context}: chest/bench ${chestGap} m`);
          let sole = Infinity;
          for (const i of regions.get('ankleL')) sole = Math.min(sole, surface.getVertexPosition(i, p).applyMatrix4(surface.matrixWorld).y);
          assert(sole >= -MAX_PENETRATION && sole <= 0.010, `${context}: planted sole ${sole} m`);
        }
        if (headContact) {
          assert(regionGap(palm, bounds) <= 0.012, `${context}: palm separated from chair edge`);
          assert(regionGap(fingertips, bounds) <= 0.008, `${context}: fingertips separated from chair edge`);
          const headGap = scalp(regions.get('wristL'));
          minHead = Math.min(minHead, headGap);
          assert(headGap >= -MAX_PENETRATION, `${context}: palm inside head ${(headGap * 1000).toFixed(1)} mm`);
          const held = (from !== 'setup' && to !== 'setup') || (to !== 'setup' && t === 1);
          if (held) assert(headGap <= 0.012, `${context}: palm separated from head`);
        }
        if (slug === 'pectoralis-major-1') {
          const elbow = boxGap('elbowR', bounds);
          assert(elbow >= -MAX_PENETRATION && elbow <= 0.015, `${context}: forearm at jamb ${(elbow * 1000).toFixed(1)} mm`);
        }
      }
    }
    const millimeters = v => (1000 * v).toFixed(1);
    console.log(`✓ ${slug}: ${bone} support ${millimeters(minSupport)}…${millimeters(maxSupport)} mm` +
      (headContact ? `, minimum palm/scalp clearance ${millimeters(minHead)} mm` : ''));
  }
  for (const [slug, hands] of [
    ['scalenes', ['wristL']], ['suboccipitals', ['wristL', 'wristR']],
    ['levator-scapulae-2', ['wristL', 'wristR']], ['teres-major', ['wristL', 'wristR']],
    ['triceps-brachii', ['wristL', 'wristR']],
  ]) {
    for (const [from, to] of TRANSITIONS) {
      for (let k = 0; k < ALL_EXERCISE_SAMPLES; k++) {
        rig.applyPose(sampleTransition(STRETCH_3D_SPECS[slug], from, to, k / (ALL_EXERCISE_SAMPLES - 1)));
        for (const hand of hands) {
          const gap = scalp(regions.get(hand));
          assert(gap >= -MAX_PENETRATION, `${slug} ${from}→${to} sample ${k}: ${hand}/scalp ${gap} m`);
        }
      }
    }
  }
  // Displacements are measured on the landmark that moves in the book figure.
  for (const [slug, landmark, low, high] of [
    ['pectoralis-minor-seated', 'pelvis_center', 0.04, 0.06],
    ['quadratus-lumborum-seated', 'head', 0.007, 0.02],
    ['psoas-iliacus', 'forefootR', 0.04, 0.06],
    ['gracilis', 'forefootR', 0.02, 0.035],
  ]) {
    const spec = STRETCH_3D_SPECS[slug];
    rig.applyPose(spec.poses.stretch);
    const start = rig.getSocketWorldPos(landmark).y;
    rig.applyPose(spec.poses.resist);
    const dy = rig.getSocketWorldPos(landmark).y - start;
    assert(dy >= low && dy <= high, `${slug}: resistance displacement ${dy} m`);
  }
  const calf = STRETCH_3D_SPECS.gastrocnemius;
  assert.equal(calf.phases.find(p => p.id === 'stretch').durationSec, 60);
  const rise = calf.poses.resist.rootPos[1] - calf.poses.stretch.rootPos[1];
  assert(rise >= 0.025 && rise <= 0.05, 'Gastrocnemius resistance should lift the body 2.5–5 cm');
}

function jambBounds(spec) {
  const props = new PropSystem();
  props.setProps(spec.props);
  props.group.updateMatrixWorld(true);
  const bounds = new Box3().setFromObject(props.group.children[0].children[0]);
  props.dispose();
  return bounds;
}

// Keep each panel in its own local frame. A world-aligned box around an oblique
// wall would incorrectly classify empty space beside the wall as penetration.
function cylinderClearance(p, { cylinder, scale }) {
  const height = cylinder.height * scale.y;
  const u = Math.max(0, Math.min(1, p.y / height + 0.5));
  const radius = cylinder.radiusBottom + (cylinder.radiusTop - cylinder.radiusBottom) * u;
  const side = (Math.hypot(p.x / scale.x, p.z / scale.z) - radius) * Math.min(scale.x, scale.z);
  return Math.max(side, Math.abs(p.y) - height / 2);
}

function propSolids(spec) {
  const props = new PropSystem();
  props.setProps(spec.props);
  props.group.updateMatrixWorld(true);
  const solids = [];
  props.group.traverse(object => {
    const cylinder = object.geometry instanceof CylinderGeometry && !object.isInstancedMesh;
    if (!(object.geometry instanceof BoxGeometry) && !cylinder) return;
    object.geometry.computeBoundingBox();
    const scale = object.getWorldScale(new Vector3());
    const box = object.geometry.boundingBox.clone();
    box.min.multiply(scale);
    box.max.multiply(scale);
    solids.push({ box, cylinder: cylinder ? object.geometry.parameters : null, scale, inverse: object.matrixWorld.clone().invert(), world: new Box3().setFromObject(object) });
  });
  props.dispose();
  return solids;
}

validateTeachingContacts();

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
  const rightHand = new Set(vertexRegions(skinnedSurface).get('wristR'));

  for (const spec of ALL_STRETCH_3D_LIST) {
    const solids = propSolids(spec);
    const local = new Vector3();
    const seatType = SEATED_EXERCISES.get(spec.slug);
    const gripsChair = spec.technique.contacts.some(c => c.at === 'handR' && c.on === 'chair');
    const seat = seatType ? supportBounds(spec, seatType) : null;
    const table = spec.slug === 'latissimus-dorsi-seated' || spec.slug === 'quadratus-lumborum-seated'
      ? supportBounds(spec, 'table') : null;
    const usesBenchForHandSupport = spec.slug === 'pectoralis-minor-seated';
    const usesSideSupport = spec.slug === 'quadratus-lumborum-lying';
    const lastSample = (table || usesBenchForHandSupport || usesSideSupport
      ? SAMPLES_PER_TRANSITION : ALL_EXERCISE_SAMPLES) - 1;
    for (const [from, to] of motionTransitions(spec)) {
      for (let sample = 0; sample <= lastSample; sample++) {
        rigInstance.applyPose(sampleTransition(spec, from, to, sample / lastSample));
        let minFloorY = Infinity;
        let minSeatGap = Infinity;
        let deepestTableIntersection = 0;
        let rightKneeTableGap = Infinity;
        const benchGaps = usesBenchForHandSupport ? { feet: [Infinity, Infinity], hands: [Infinity, Infinity] } : null;
        const sideGaps = usesSideSupport
          ? { 'right foot': Infinity, 'right hip': Infinity, 'right arm': Infinity } : null;
        for (let index = 0; index < positions.count; index++) {
          skinnedSurface.getVertexPosition(index, point).applyMatrix4(skinnedSurface.matrixWorld);
          for (const solid of solids) {
            if (!solid.world.containsPoint(point)) continue;
            local.copy(point).applyMatrix4(solid.inverse).multiply(solid.scale);
            const gap = solid.cylinder ? cylinderClearance(local, solid) : boxClearance(local, solid.box);
            assert(gap >= -MAX_PENETRATION,
              `${spec.slug} ${from}→${to} sample ${sample}/${lastSample}: prop penetration ${(gap * 1000).toFixed(1)} mm`);
          }
          if (point.y < minFloorY) minFloorY = point.y;
          // Fingers wrapping the outer edge can lie below seat-top height.
          // Their signed distance to the actual solid is checked above, including
          // the side and underside. Seated load-bearing regions use the top plane.
          if (seat && insideFootprint(point, seat) && point.y > 0.18 && !(gripsChair && rightHand.has(index))) {
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
  console.log(`✓ Detailed seated, kneeling, bench and hand support checks passed (${SAMPLES_PER_TRANSITION * TRANSITIONS.length} samples/exercise)`);
}

validateAllExercisesContacts(rig, surface);
