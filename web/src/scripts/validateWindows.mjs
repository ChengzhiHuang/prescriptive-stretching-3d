import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ALL_STRETCH_3D_LIST } from '../data/stretches/index.ts';
import { HumanRig } from '../engine/HumanRig.ts';
import { vertexRegions } from './skinClearance.mjs';

// Expected body ownership by book exercise, independent of the fascicles' window metadata.
const expected = new Map();
function allow(slugs, boneNames) {
  for (const slug of slugs.split(' ')) expected.set(slug, new Set(boneNames.split(' ')));
}
allow('upper-trapezius levator-scapulae-1 levator-scapulae-2', 'head neck thoracic clavicleR shoulderR');
allow('sternocleidomastoid scalenes', 'head neck thoracic clavicleR');
allow('suboccipitals', 'head neck thoracic');
allow('pectoralis-major-1 pectoralis-minor-standing', 'thoracic clavicleR shoulderR');
allow('pectoralis-major-2 pectoralis-minor-seated', 'thoracic clavicleR clavicleL shoulderR shoulderL');
allow('middle-trapezius-rhomboids-standing middle-trapezius-rhomboids-seated infraspinatus-1 infraspinatus-2 teres-major supraspinatus-1 supraspinatus-2', 'neck thoracic clavicleR shoulderR');
allow('latissimus-dorsi-standing latissimus-dorsi-seated', 'lumbar pelvis thoracic neck clavicleR shoulderR');
allow('gluteus-maximus gluteus-medius-minimus piriformis-seated piriformis-standing', 'pelvis lumbar hipR');
allow('quadratus-lumborum-lying quadratus-lumborum-seated', 'pelvis lumbar thoracic');
allow('psoas-iliacus', 'pelvis lumbar thoracic hipR');
allow('rectus-femoris-supine rectus-femoris-kneeling tensor-fasciae-latae hamstrings short-adductors gracilis', 'pelvis hipR kneeR');
allow('gastrocnemius soleus', 'hipR kneeR ankleR');
allow('tibialis-anterior', 'kneeR ankleR');
allow('biceps-brachii triceps-brachii', 'shoulderR elbowR');
allow('forearm-flexors forearm-extensors extensor-carpi-radialis', 'shoulderR elbowR wristR');

const bytes = await readFile('src/assets/human.glb');
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const { scene } = await new GLTFLoader().parseAsync(buffer, '');
const [source] = scene.getObjectsByProperty('isSkinnedMesh', true);
scene.updateMatrixWorld(true);
const surface = { geometry: source.geometry.applyMatrix4(source.bindMatrix), jointNames: source.skeleton.bones.map(b => b.name) };
const rig = new HumanRig();
const seated = ALL_STRETCH_3D_LIST.find(s => s.slug === 'quadratus-lumborum-seated');
rig.setTargetMuscles(seated.fascicles); // Deep-link selection can precede GLB loading.
rig.applyPose(seated.poses.setup);
assert(rig.attachSurface(surface));
const mesh = rig.root.getObjectByName('HumanSurface');
const { position, muscleWindow } = mesh.geometry.attributes;
const regions = vertexRegions(mesh);
const upperLimbs = [...regions].filter(([name]) => /^(shoulder|elbow|wrist)/.test(name)).flatMap(([, vertices]) => vertices);
const owners = [];
for (const [name, vertices] of regions) for (const i of vertices) owners[i] = name;
assert(upperLimbs.every(i => !muscleWindow.array[i]));
const firstWindow = muscleWindow.array.slice();
assert.equal(expected.size, 40);
for (const spec of ALL_STRETCH_3D_LIST) {
  const allowed = expected.get(spec.slug);
  assert(allowed, spec.slug);
  for (const bundle of spec.fascicles) {
    rig.setTargetMuscles([bundle]);
    const mask = muscleWindow.array;
    if (bundle.role === 'nerve' || bundle.role === 'synergist') {
      assert(mask.every(v => v === 0), bundle.id + ' must not open a target window');
      continue;
    }
    const left = bundle.insertion.endsWith('L');
    let core = 0;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      assert(allowed.has(owners[i]), spec.slug + ': wrong body part ' + owners[i]);
      assert(left ? position.getX(i) >= -0.001 : position.getX(i) <= 0.001, bundle.id + ': wrong side');
      if (mask[i] >= 128) core++;
    }
    assert(core >= 5, bundle.id + ': insufficient target coverage ' + core);
  }
  rig.setTargetMuscles(spec.fascicles);
  if (spec.slug.includes('quadratus-lumborum')) {
    assert(upperLimbs.every(i => !muscleWindow.array[i]));
    const back = regions.get('lumbar').filter(i => position.getX(i) < -0.035 && position.getZ(i) < -0.045);
    assert(back.some(i => muscleWindow.array[i] >= 200), 'Missing right posterior lumbar window');
  }
  const active = muscleWindow.array.reduce((n, w) => n + Number(w > 0), 0);
  console.log(spec.slug + ': ' + active + ' window vertices, 0 outside target');
}
// Finger manipulation changes live bind-space finger positions. Selection must stay
// identical even after other exercises, grip, and switching between display modes.
rig.applyPose({grip: [1, 1]});
rig.setXrayMode(true);
rig.setXrayMode(false);
rig.setTargetMuscles(seated.fascicles);
assert.deepEqual(muscleWindow.array, firstWindow);
console.log('✓ 40/40 anatomical windows, individual bundle coverage and bilateral arm exclusion');
