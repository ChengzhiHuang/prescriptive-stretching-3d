import { ALL_STRETCH_3D_LIST, STRETCH_3D_SPECS } from '../data/stretches';
import { HumanRig } from '../engine/HumanRig';
import { MuscleSystem } from '../engine/MuscleSystem';
import { PropSystem } from '../engine/PropSystem';
import bookIndex from '../../public/data/book_index.json';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(`Validation failed: ${msg}`);
  }
}

function main(): void {
  const rig = new HumanRig();
  const muscles = new MuscleSystem();
  const props = new PropSystem();

  const validNodes = new Set<string>([
    ...Object.keys(rig.sockets),
    ...Object.keys(rig.joints),
  ]);

  assert(ALL_STRETCH_3D_LIST.length === 40, `Expected 40 Stretch3DSpec entries, got ${ALL_STRETCH_3D_LIST.length}`);
  assert(Object.keys(STRETCH_3D_SPECS).length === 40, `Expected 40 unique slugs, got ${Object.keys(STRETCH_3D_SPECS).length}`);

  for (const bookEntry of bookIndex.stretches) {
    const spec = STRETCH_3D_SPECS[bookEntry.slug];
    assert(Boolean(spec), `Missing Stretch3DSpec for book slug "${bookEntry.slug}"`);
    assert(spec.sourcePage === bookEntry.sourcePageStart, `Source page mismatch for ${spec.slug}: ${spec.sourcePage} vs ${bookEntry.sourcePageStart}`);
    assert(String(spec.printedPage) === bookEntry.printedPage, `Printed page mismatch for ${spec.slug}: ${spec.printedPage} vs ${bookEntry.printedPage}`);
  }

  for (const spec of ALL_STRETCH_3D_LIST) {
    assert(spec.fascicles.length >= 1, `${spec.slug}: must define at least 1 fascicle`);
    assert(spec.phases.length === 4, `${spec.slug}: must define 4 PNF phases`);
    assert(spec.cameras.length >= 3, `${spec.slug}: must define at least 3 camera presets`);

    // Check all socket references
    for (const f of spec.fascicles) {
      for (const s of [f.origin, ...(f.via ?? []), f.insertion]) {
        assert(validNodes.has(s), `${spec.slug} fascicle "${f.id}" references unknown socket "${s}"`);
      }
    }
    for (const c of [...spec.callouts, ...(spec.mistakeCallouts ?? [])]) {
      assert(validNodes.has(c.socket), `${spec.slug} callout references unknown socket "${c.socket}"`);
    }
    assert(validNodes.has(spec.mistakeInfo.overloadSocket), `${spec.slug} mistakeInfo references unknown socket "${spec.mistakeInfo.overloadSocket}"`);
    for (const fa of spec.forceArrows) {
      assert(validNodes.has(fa.socket), `${spec.slug} forceArrow references unknown socket "${fa.socket}"`);
    }
    assert(validNodes.has(spec.angleGauge.vertexSocket), `${spec.slug} angleGauge unknown vertexSocket "${spec.angleGauge.vertexSocket}"`);
    assert(validNodes.has(spec.angleGauge.toSocket), `${spec.slug} angleGauge unknown toSocket "${spec.angleGauge.toSocket}"`);
    for (const p of spec.props) {
      for (const s of p.attachSockets ?? []) {
        assert(validNodes.has(s), `${spec.slug} dynamic prop references unknown socket "${s}"`);
      }
    }

    // Exercise FK & MuscleSystem strain physics across all 5 poses!
    props.setProps(spec.props);
    muscles.loadFascicles(spec.fascicles, rig);

    rig.applyPose(spec.poses.setup);
    props.updateDynamicProps(rig);
    const setupLens = muscles.measureAll(rig);

    rig.applyPose(spec.poses.stretch);
    const stretchLens = muscles.measureAll(rig);

    rig.applyPose(spec.poses.deepen);
    const deepenLens = muscles.measureAll(rig);
    muscles.calibrateLengths(rig, setupLens, deepenLens);

    const primaryFascicles = spec.fascicles.filter((f) => f.role !== 'nerve' && f.role !== 'synergist');
    const avgSetup = primaryFascicles.reduce((acc, f) => acc + setupLens[f.id], 0) / primaryFascicles.length;
    const avgStretch = primaryFascicles.reduce((acc, f) => acc + stretchLens[f.id], 0) / primaryFascicles.length;
    const avgDeepen = primaryFascicles.reduce((acc, f) => acc + deepenLens[f.id], 0) / primaryFascicles.length;

    assert(
      avgDeepen > avgSetup + 0.002,
      `${spec.slug}: deepen fascicle length (${avgDeepen.toFixed(4)}m) must exceed setup (${avgSetup.toFixed(4)}m)`
    );
    assert(
      avgDeepen >= avgStretch - 0.0005,
      `${spec.slug}: deepen length (${avgDeepen.toFixed(4)}m) should be >= stretch (${avgStretch.toFixed(4)}m)`
    );

    // Verify mistake pose updates cleanly without NaN
    rig.applyPose(spec.poses.mistake);
    const res = muscles.update(rig, 'stretch', true, 1.0);
    assert(!Number.isNaN(res.strainRatio) && !Number.isNaN(res.elongationPct), `${spec.slug}: NaN telemetry`);
  }

  console.log(`✓ Validated all ${ALL_STRETCH_3D_LIST.length}/40 Stretch3DSpec models: 100% sockets, FK poses, props, and biomechanical elongation verified!`);
}

main();
