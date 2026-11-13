import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { HumanSurface } from './HumanSurface';
import type { BallJointAngles, ClavicleAngles, Euler3, PoseAngles, SpineAngles } from './types';

const DEG = Math.PI / 180;

function createFacelessHead(): THREE.BufferGeometry {
  // A rounded oval with a slightly narrower jaw. Sections give height, half-width,
  // forward and rear radii, and center depth in millimeters from the neck seam.
  const sections = [
    [0, 51, 52, 44, 1],
    [48, 62, 82, 59, -1],
    [100, 72, 84, 77, -3],
    [160, 75, 80, 85, -3],
    [205, 66, 63, 68, -2],
    [240, 42, 38, 42, -2],
    [250, 0, 0, 0, -2],
  ];
  const profile = new THREE.CubicInterpolant(
    Float32Array.from(sections, ([height]) => height),
    new Float32Array(sections.flatMap(([, width, front, back, depth]) => [width ** 2, front ** 2, back ** 2, depth])),
    4,
  );
  const radialSegments = 40;
  const verticalSegments = 32;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let ring = 0; ring < verticalSegments; ring++) {
    const height = 125 * (1 - Math.cos(Math.PI * ring / verticalSegments));
    const [widthSquared, frontSquared, backSquared, depth] = profile.evaluate(height);
    const width = Math.sqrt(Math.max(0, widthSquared));
    for (let side = 0; side < radialSegments; side++) {
      const angle = 2 * Math.PI * side / radialSegments;
      const front = Math.cos(angle);
      const radius = Math.sqrt(Math.max(0, front < 0 ? backSquared : frontSquared));
      positions.push(width * Math.sin(angle) / 1000, (height - 85) / 1000, (12 + depth + radius * front) / 1000);
      if (ring < verticalSegments - 1) {
        const current = ring * radialSegments + side;
        const next = ring * radialSegments + (side + 1) % radialSegments;
        indices.push(current, next, current + radialSegments, next, next + radialSegments, current + radialSegments);
      }
    }
  }
  const base = positions.length / 3;
  const crown = base + 1;
  positions.push(0, -0.085, 0.013, 0, 0.165, 0.01);
  const topRing = base - radialSegments;
  for (let side = 0; side < radialSegments; side++) {
    const next = (side + 1) % radialSegments;
    indices.push(base, next, side, topRing + side, topRing + next, crown);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function lerpNum(a = 0, b = 0, t: number): number {
  return a + (b - a) * t;
}

export function interpolatePoses(a: PoseAngles, b: PoseAngles, t: number): PoseAngles {
  const s = t * t * (3 - 2 * t); // smoothstep easing
  const lp3 = (p1: [number, number, number] = [0, 0.94, 0], p2: [number, number, number] = [0, 0.94, 0]): [number, number, number] => [
    lerpNum(p1[0], p2[0], s),
    lerpNum(p1[1], p2[1], s),
    lerpNum(p1[2], p2[2], s),
  ];
  const lSpine = (x?: SpineAngles, y?: SpineAngles): SpineAngles => ({
    flex: lerpNum(x?.flex, y?.flex, s),
    twistLeft: lerpNum(x?.twistLeft, y?.twistLeft, s),
    leanLeft: lerpNum(x?.leanLeft, y?.leanLeft, s),
  });
  const lHead = (x?: Euler3, y?: Euler3): Euler3 => ({
    flex: lerpNum(x?.flex, y?.flex, s),
    turnLeft: lerpNum(x?.turnLeft, y?.turnLeft, s),
    tiltLeft: lerpNum(x?.tiltLeft, y?.tiltLeft, s),
  });
  const lClav = (x?: ClavicleAngles, y?: ClavicleAngles): ClavicleAngles => ({
    elevate: lerpNum(x?.elevate, y?.elevate, s),
    protract: lerpNum(x?.protract, y?.protract, s),
  });
  const lBall = (x?: BallJointAngles, y?: BallJointAngles): BallJointAngles => ({
    flex: lerpNum(x?.flex, y?.flex, s),
    abduct: lerpNum(x?.abduct, y?.abduct, s),
    extRot: lerpNum(x?.extRot, y?.extRot, s),
  });

  return {
    rootPos: lp3(a.rootPos ?? [0, 0.94, 0], b.rootPos ?? [0, 0.94, 0]),
    rootYaw: lerpNum(a.rootYaw, b.rootYaw, s),
    rootPitch: lerpNum(a.rootPitch, b.rootPitch, s),
    rootRoll: lerpNum(a.rootRoll, b.rootRoll, s),
    pelvis: {
      pitch: lerpNum(a.pelvis?.pitch, b.pelvis?.pitch, s),
      yaw: lerpNum(a.pelvis?.yaw, b.pelvis?.yaw, s),
      roll: lerpNum(a.pelvis?.roll, b.pelvis?.roll, s),
    },
    lumbar: lSpine(a.lumbar, b.lumbar),
    thoracic: lSpine(a.thoracic, b.thoracic),
    neck: lHead(a.neck, b.neck),
    head: lHead(a.head, b.head),
    clavicleR: lClav(a.clavicleR, b.clavicleR),
    clavicleL: lClav(a.clavicleL, b.clavicleL),
    shoulderR: lBall(a.shoulderR, b.shoulderR),
    shoulderL: lBall(a.shoulderL, b.shoulderL),
    elbowR: { flex: lerpNum(a.elbowR?.flex, b.elbowR?.flex, s), pronate: lerpNum(a.elbowR?.pronate, b.elbowR?.pronate, s) },
    elbowL: { flex: lerpNum(a.elbowL?.flex, b.elbowL?.flex, s), pronate: lerpNum(a.elbowL?.pronate, b.elbowL?.pronate, s) },
    wristR: { flex: lerpNum(a.wristR?.flex, b.wristR?.flex, s), deviate: lerpNum(a.wristR?.deviate, b.wristR?.deviate, s) },
    wristL: { flex: lerpNum(a.wristL?.flex, b.wristL?.flex, s), deviate: lerpNum(a.wristL?.deviate, b.wristL?.deviate, s) },
    hipR: lBall(a.hipR, b.hipR),
    hipL: lBall(a.hipL, b.hipL),
    kneeR: { flex: lerpNum(a.kneeR?.flex, b.kneeR?.flex, s) },
    kneeL: { flex: lerpNum(a.kneeL?.flex, b.kneeL?.flex, s) },
    ankleR: { dorsiflex: lerpNum(a.ankleR?.dorsiflex, b.ankleR?.dorsiflex, s), invert: lerpNum(a.ankleR?.invert, b.ankleR?.invert, s) },
    ankleL: { dorsiflex: lerpNum(a.ankleL?.dorsiflex, b.ankleL?.dorsiflex, s), invert: lerpNum(a.ankleL?.invert, b.ankleL?.invert, s) },
  };
}

/**
 * Parametric forward-kinematics human anatomical mannequin with translucent skin shell,
 * internal skeletal landmarks (spine, ribcage, pelvis, scapulae, long bones), and named
 * origin/insertion sockets for all major muscle groups.
 */
export class HumanRig {
  public readonly root = new THREE.Group();
  public readonly joints: Record<string, THREE.Bone> = {};
  public readonly sockets: Record<string, THREE.Object3D> = {};
  private readonly skinMeshes: THREE.Mesh[] = [];
  private readonly skeletonMeshes: THREE.Mesh[] = [];
  private readonly inverseRestMatrices = new Map<THREE.Bone, THREE.Matrix4>();
  private readonly skullCrown = new THREE.Vector3();
  private readonly fallbackCrown = new THREE.Vector3();
  private surface?: { colorPass: THREE.SkinnedMesh; depthPass: THREE.SkinnedMesh; crown: THREE.Vector3 };
  private xray = false;

  private readonly boneMat = new THREE.MeshStandardMaterial({
    color: 0xe6dbca,
    roughness: 0.74,
  });

  private readonly jointCartilageMat = new THREE.MeshStandardMaterial({
    color: 0xc3cbd1,
    roughness: 0.68,
  });

  private readonly skinMat = new THREE.MeshPhysicalMaterial({
    color: 0xd8e2ea,
    roughness: 0.52,
    metalness: 0.0,
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
    side: THREE.FrontSide,
  });

  constructor() {
    this.buildHierarchy();
    this.root.updateMatrixWorld(true);
    for (const joint of Object.values(this.joints)) {
      this.inverseRestMatrices.set(joint, joint.matrixWorld.clone().invert());
    }
    this.root.traverse((object) => {
      if (object instanceof THREE.Mesh && object.material !== this.skinMat) {
        this.skeletonMeshes.push(object);
      }
    });
  }

  public attachSurface({ geometry, jointNames }: HumanSurface): boolean {
    if (this.surface) return false;
    const bones = jointNames.map((name) => this.joints[name]);
    const inverseMatrices = bones.map((bone) => this.inverseRestMatrices.get(bone));
    if (!inverseMatrices.every((matrix) => matrix instanceof THREE.Matrix4)) return false;

    // In the neutral bind pose the highest vertex is on the crown. Store it in head space
    // so the arrow follows head motion independently of the anatomical angle reference.
    const position = geometry.getAttribute('position');
    let crownVertex = 0;
    for (let i = 1; i < position.count; i++) {
      if (position.getY(i) > position.getY(crownVertex)) crownVertex = i;
    }
    const crown = new THREE.Vector3().fromBufferAttribute(position, crownVertex)
      .applyMatrix4(this.inverseRestMatrices.get(this.joints.head)!);

    const material = new THREE.MeshStandardMaterial({
      color: 0xc0c5c9,
      roughness: 0.79,
      transparent: true,
      opacity: 0.69,
      depthWrite: false,
      depthFunc: THREE.EqualDepth,
    });
    const colorPass = new THREE.SkinnedMesh(geometry, material);
    const depthPass = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial({
      transparent: true,
      colorWrite: false,
      depthWrite: true,
      blending: THREE.NoBlending,
    }));
    // The mesh uses rig-space coordinates. Bind at the cached rest pose even if the load
    // completes while the instructor is already holding a stretch.
    const skeleton = new THREE.Skeleton(bones, inverseMatrices);
    const bindMatrix = new THREE.Matrix4();
    const bounds = new THREE.Sphere(this.joints.root.position.clone(), 1.5);
    for (const pass of [depthPass, colorPass]) {
      // EqualDepth needs the same projected position from both shader programs.
      pass.material.onBeforeCompile = (shader) => {
        shader.vertexShader = `invariant gl_Position;\n${shader.vertexShader}`;
      };
      pass.bind(skeleton, bindMatrix);
      pass.boundingSphere = bounds;
      pass.frustumCulled = false;
    }
    // Record the nearest body surface after the opaque muscle and prop colors have
    // been drawn, then tint that color once even when limbs overlap on screen.
    depthPass.name = 'HumanSurfaceDepth';
    depthPass.renderOrder = 1;
    colorPass.name = 'HumanSurface';
    colorPass.renderOrder = 2;
    this.surface = { colorPass, depthPass, crown };
    this.root.add(depthPass, colorPass);
    this.setXrayMode(this.xray);
    return true;
  }

  public setXrayMode(xray: boolean): void {
    this.xray = xray;
    const crown = xray ? this.skullCrown : (this.surface?.crown ?? this.fallbackCrown);
    this.sockets.head_crown.position.copy(crown);
    this.skinMat.opacity = xray ? 0.1 : 0.34;
    for (const mesh of this.skinMeshes) mesh.visible = !this.surface;
    for (const mesh of this.skeletonMeshes) mesh.visible = xray || !this.surface;
    if (this.surface) {
      this.surface.colorPass.visible = !xray;
      this.surface.depthPass.visible = !xray;
    }
  }

  public disposeSurface(): void {
    if (this.surface) {
      this.surface.colorPass.geometry.dispose();
      (this.surface.colorPass.material as THREE.Material).dispose();
      (this.surface.depthPass.material as THREE.Material).dispose();
      this.surface.colorPass.skeleton.dispose();
      this.root.remove(this.surface.colorPass, this.surface.depthPass);
      this.surface = undefined;
      this.setXrayMode(this.xray);
    }
  }

  private makeJoint(name: string, parent: THREE.Object3D, x: number, y: number, z: number): THREE.Bone {
    const joint = new THREE.Bone();
    joint.name = name;
    joint.position.set(x, y, z);
    parent.add(joint);
    this.joints[name] = joint;
    return joint;
  }

  private addSocket(name: string, parent: THREE.Object3D, x: number, y: number, z: number): THREE.Object3D {
    const s = new THREE.Object3D();
    s.name = name;
    s.position.set(x, y, z);
    parent.add(s);
    this.sockets[name] = s;
    return s;
  }

  private addLimbSegment(
    parent: THREE.Object3D,
    from: [number, number, number],
    to: [number, number, number],
    rTop: number,
    rBot: number,
    boneRadius = 0.022
  ): void {
    const p0 = new THREE.Vector3(...from);
    const p1 = new THREE.Vector3(...to);
    const dir = p1.clone().sub(p0);
    const len = dir.length();
    const mid = p0.clone().addScaledVector(dir, 0.5);
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());

    // Internal bone shaft
    const boneGeo = new THREE.CylinderGeometry(boneRadius * 0.88, boneRadius, len * 0.92, 12);
    const boneMesh = new THREE.Mesh(boneGeo, this.boneMat);
    boneMesh.position.copy(mid);
    boneMesh.quaternion.copy(quat);
    parent.add(boneMesh);

    // Joint epiphyses
    const epGeo = new THREE.SphereGeometry(boneRadius * 1.32, 12, 10);
    const epStart = new THREE.Mesh(epGeo, this.jointCartilageMat);
    epStart.position.copy(p0);
    parent.add(epStart);

    // Translucent soft-tissue envelope
    const skinGeo = new THREE.CylinderGeometry(rBot, rTop, len * 0.95, 18, 1, false);
    // Note: CylinderGeometry +Y is `to`, -Y is `from`, so top radius corresponds to `to`!
    const skinMesh = new THREE.Mesh(skinGeo, this.skinMat);
    skinMesh.position.copy(mid);
    skinMesh.quaternion.copy(quat);
    parent.add(skinMesh);
    this.skinMeshes.push(skinMesh);
  }

  private addRibCage(thoracic: THREE.Bone): void {
    const ribs: THREE.TubeGeometry[] = [];
    const cartilage: THREE.TubeGeometry[] = [];
    for (const side of [-1, 1]) {
      // The lower three false ribs meet the costal margin instead of the sternum.
      const costalMargin = Array.from({ length: 4 }, (_, i) => new THREE.Vector3(
        side * (0.014 + i * 0.014), 0.105 - i * 0.012, 0.133 - i * 0.006,
      ));
      cartilage.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(costalMargin), 10, 0.004, 6));
      for (let i = 0; i < 12; i++) {
        const y = 0.253 - i * 0.020;
        const width = 0.074 + 0.075 * Math.sin(Math.PI * (i + 1) / 16);
        const floating = i >= 10;
        const curve = new THREE.CatmullRomCurve3([
          new THREE.Vector3(side * 0.017, y, -0.012),
          new THREE.Vector3(side * width * 0.54, y - 0.003, -0.054),
          new THREE.Vector3(side * width, y - 0.013, floating ? -0.040 : 0.025),
          ...(floating ? [] : [
            new THREE.Vector3(side * width * 0.74, y - 0.024, 0.100),
            new THREE.Vector3(side * width * 0.48, y - 0.028, 0.121),
          ]),
        ]);
        const radius = floating ? 0.004 : 0.0055;
        ribs.push(new THREE.TubeGeometry(curve, 14, radius, 6));
        if (!floating) {
          const end = curve.getPoint(1);
          const mid = end.clone().add(new THREE.Vector3(-side * 0.025, 0.001, 0.012));
          const cartilageEnd = i < 7 ? new THREE.Vector3(side * 0.014, end.y, 0.133) : costalMargin[i - 6];
          cartilage.push(new THREE.TubeGeometry(
            new THREE.CatmullRomCurve3([end, mid, cartilageEnd]), 7, radius * 0.85, 6,
          ));
        }
      }
    }
    thoracic.add(
      new THREE.Mesh(mergeGeometries(ribs), this.boneMat),
      new THREE.Mesh(mergeGeometries(cartilage), this.jointCartilageMat),
    );
    for (const geometry of [...ribs, ...cartilage]) geometry.dispose();

    const sternumProfile = new THREE.Shape();
    sternumProfile.moveTo(-0.024, 0.244);
    sternumProfile.quadraticCurveTo(0, 0.257, 0.024, 0.244);
    sternumProfile.quadraticCurveTo(0.013, 0.219, 0.013, 0.202);
    sternumProfile.quadraticCurveTo(0.018, 0.140, 0.008, 0.108);
    sternumProfile.quadraticCurveTo(0.007, 0.092, 0, 0.083);
    sternumProfile.quadraticCurveTo(-0.007, 0.092, -0.008, 0.108);
    sternumProfile.quadraticCurveTo(-0.018, 0.140, -0.013, 0.202);
    sternumProfile.quadraticCurveTo(-0.013, 0.219, -0.024, 0.244);
    const sternum = new THREE.Mesh(new THREE.ExtrudeGeometry(sternumProfile, {
      depth: 0.009, bevelSize: 0.003, bevelThickness: 0.002, bevelSegments: 2, curveSegments: 4,
    }), this.boneMat);
    sternum.position.z = 0.122;
    thoracic.add(sternum);
  }

  private addPelvicBones(pelvis: THREE.Bone): void {
    const crest = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.058, 0.042, -0.085),
      new THREE.Vector3(0.113, 0.063, -0.060),
      new THREE.Vector3(0.141, 0.058, -0.013),
      new THREE.Vector3(0.131, 0.048, 0.041),
      new THREE.Vector3(0.119, 0.030, 0.075),
    ]);
    const lowerRim = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.055, -0.021, -0.079),
      new THREE.Vector3(0.080, -0.014, -0.049),
      new THREE.Vector3(0.092, -0.035, -0.006),
      new THREE.Vector3(0.100, -0.028, 0.026),
      new THREE.Vector3(0.095, -0.005, 0.075),
    ]);
    const sections = 16;
    const ringSize = 8;
    const positions: number[] = [];
    const indices: number[] = [];
    const point = new THREE.Vector3();
    for (let section = 0; section <= sections; section++) {
      const u = section / sections;
      const top = crest.getPoint(u);
      const bottom = lowerRim.getPoint(u);
      const thickness = 0.005 + 0.005 * Math.sin(Math.PI * u);
      for (let j = 0; j < ringSize; j++) {
        const angle = j * 2 * Math.PI / ringSize;
        point.copy(top).lerp(bottom, (1 - Math.cos(angle)) * 0.5);
        positions.push(point.x + thickness * Math.sin(angle), point.y, point.z);
        if (section === sections) continue;
        const a = section * ringSize + j;
        const b = a + ringSize;
        const d = section * ringSize + (j + 1) % ringSize;
        indices.push(a, b, d, b, d + ringSize, d);
      }
    }
    for (let j = 1; j < ringSize - 1; j++) {
      const end = sections * ringSize;
      indices.push(0, j, j + 1, end, end + j + 1, end + j);
    }
    const iliacWing = new THREE.BufferGeometry();
    iliacWing.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    iliacWing.setIndex(indices);
    iliacWing.computeVertexNormals();

    const pubicArch = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.099, -0.042, 0.002),
      new THREE.Vector3(0.076, -0.038, 0.048),
      new THREE.Vector3(0.036, -0.048, 0.075),
      new THREE.Vector3(0, -0.053, 0.077),
    ]);
    const ischialArch = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.094, -0.036, -0.009),
      new THREE.Vector3(0.071, -0.069, -0.044),
      new THREE.Vector3(0.054, -0.085, -0.007),
      new THREE.Vector3(0.029, -0.080, 0.048),
      new THREE.Vector3(0.014, -0.054, 0.075),
    ]);
    const arches = [
      new THREE.TubeGeometry(pubicArch, 12, 0.010, 8),
      new THREE.TubeGeometry(ischialArch, 14, 0.013, 8),
    ];
    const lowerPelvis = mergeGeometries(arches);
    arches.forEach((arch) => arch.dispose());
    for (const side of [-1, 1]) {
      const wing = new THREE.Mesh(iliacWing, this.boneMat);
      const arch = new THREE.Mesh(lowerPelvis, this.boneMat);
      wing.scale.x = arch.scale.x = side;
      pelvis.add(wing, arch);
    }

    const sacrumProfile = new THREE.Shape();
    sacrumProfile.moveTo(-0.048, 0.034);
    sacrumProfile.quadraticCurveTo(0, 0.050, 0.048, 0.034);
    sacrumProfile.quadraticCurveTo(0.036, -0.030, 0, -0.067);
    sacrumProfile.quadraticCurveTo(-0.036, -0.030, -0.048, 0.034);
    const sacrum = new THREE.Mesh(new THREE.ExtrudeGeometry(sacrumProfile, {
      depth: 0.016, bevelSize: 0.005, bevelThickness: 0.004, bevelSegments: 2, curveSegments: 6,
    }), this.boneMat);
    sacrum.position.z = -0.083;
    sacrum.rotation.x = 0.18;
    pelvis.add(sacrum);
  }

  private buildHierarchy(): void {
    const rootNode = this.makeJoint('root', this.root, 0, 0.94, 0);
    const pelvis = this.makeJoint('pelvis', rootNode, 0, 0, 0);

    this.addPelvicBones(pelvis);

    const pelvisSkin = new THREE.Mesh(new THREE.SphereGeometry(0.165, 20, 16), this.skinMat);
    pelvisSkin.scale.set(1.08, 0.72, 0.78);
    pelvisSkin.position.set(0, -0.01, -0.01);
    pelvis.add(pelvisSkin);
    this.skinMeshes.push(pelvisSkin);

    // Pelvis sockets
    this.addSocket('pelvis_center', pelvis, 0, 0.01, 0);
    for (const [sfx, sg] of [['R', -1], ['L', 1]] as const) {
      this.addSocket(`sacrum_ant${sfx}`, pelvis, sg * 0.022, -0.005, -0.055);
      this.addSocket(`iliac_crest${sfx}`, pelvis, sg * 0.135, 0.055, -0.01);
      this.addSocket(`asis${sfx}`, pelvis, sg * 0.12, 0.03, 0.075);
      this.addSocket(`aiis${sfx}`, pelvis, sg * 0.095, -0.005, 0.078);
      this.addSocket(`ischial_tuberosity${sfx}`, pelvis, sg * 0.068, -0.068, -0.048);
      this.addSocket(`pubis${sfx}`, pelvis, sg * 0.028, -0.048, 0.075);
    }

    // Lumbar spine (y = 0 -> +0.18)
    const lumbar = this.makeJoint('lumbar', pelvis, 0, 0.05, -0.02);
    for (let i = 0; i < 5; i++) {
      const vy = 0.02 + i * 0.032;
      const vBody = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.03, 0.022, 12), this.boneMat);
      vBody.position.set(0, vy, 0.006 * Math.sin((i / 4) * Math.PI));
      lumbar.add(vBody);
      const spinous = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.016, 0.032), this.boneMat);
      spinous.position.set(0, vy - 0.004, -0.028);
      lumbar.add(spinous);
    }
    const abdomenSkin = new THREE.Mesh(new THREE.CylinderGeometry(0.142, 0.148, 0.18, 20), this.skinMat);
    abdomenSkin.scale.set(1.04, 1, 0.74);
    abdomenSkin.position.set(0, 0.09, 0.022);
    lumbar.add(abdomenSkin);
    this.skinMeshes.push(abdomenSkin);
    this.addSocket('lumbar_disc', lumbar, 0, 0.065, -0.01);
    this.addSocket('navel', lumbar, 0, 0.08, 0.125);
    for (const [sfx, sg] of [['R', -1], ['L', 1]] as const) {
      this.addSocket(`lumbar_transverse${sfx}`, lumbar, sg * 0.042, 0.085, -0.014);
      this.addSocket(`t12_l4_ant${sfx}`, lumbar, sg * 0.028, 0.095, 0.016);
      this.addSocket(`iliac_fossa${sfx}`, pelvis, sg * 0.085, 0.025, 0.032);
      this.addSocket(`sacrum_post${sfx}`, pelvis, sg * 0.034, 0.008, -0.072);
    }

    // Thoracic spine & Ribcage (y = 0 -> +0.28)
    const thoracic = this.makeJoint('thoracic', lumbar, 0, 0.175, 0);
    for (let i = 0; i < 12; i++) {
      const vy = 0.023 + i * 0.020;
      const radius = 0.023 - i * 0.0006;
      const vBody = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.94, radius, 0.014, 10), this.boneMat);
      vBody.position.set(0, vy, -0.012 * Math.sin((i / 11) * Math.PI));
      thoracic.add(vBody);
      const spinous = new THREE.Mesh(new THREE.CapsuleGeometry(0.005, 0.022, 3, 6), this.boneMat);
      spinous.rotation.x = Math.PI * 0.40;
      spinous.position.set(0, vy - 0.006, -0.032);
      thoracic.add(spinous);
    }

    this.addRibCage(thoracic);

    const chestSkin = new THREE.Mesh(new THREE.CylinderGeometry(0.165, 0.142, 0.27, 22), this.skinMat);
    chestSkin.scale.set(1.08, 1, 0.74);
    chestSkin.position.set(0, 0.14, 0.022);
    thoracic.add(chestSkin);
    this.skinMeshes.push(chestSkin);

    this.addSocket('sternum_upper', thoracic, 0, 0.225, 0.126);
    this.addSocket('sternum_mid', thoracic, 0, 0.165, 0.134);
    this.addSocket('sternum_lower', thoracic, 0, 0.105, 0.132);
    this.addSocket('t1_spinous', thoracic, 0, 0.265, -0.036);
    this.addSocket('t4_spinous', thoracic, 0, 0.195, -0.044);
    this.addSocket('t8_spinous', thoracic, 0, 0.11, -0.042);
    this.addSocket('t12_spinous', thoracic, 0, 0.02, -0.032);
    for (const [sfx, sg] of [['R', -1], ['L', 1]] as const) {
      this.addSocket(`rib1${sfx}`, thoracic, sg * 0.056, 0.246, 0.045);
      this.addSocket(`rib2${sfx}`, thoracic, sg * 0.074, 0.218, 0.068);
      this.addSocket(`ribs_3_5${sfx}`, thoracic, sg * 0.088, 0.165, 0.105);
      this.addSocket(`rib12${sfx}`, thoracic, sg * 0.108, 0.028, -0.032);
    }

    // Neck & Head
    const neck = this.makeJoint('neck', thoracic, 0, 0.275, 0.005);
    for (let i = 0; i < 4; i++) {
      const cv = new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.021, 0.018, 10), this.boneMat);
      cv.position.set(0, 0.016 + i * 0.022, 0.004);
      neck.add(cv);
    }
    const neckSkin = new THREE.Mesh(new THREE.CylinderGeometry(0.056, 0.064, 0.095, 16), this.skinMat);
    neckSkin.position.set(0, 0.048, 0.006);
    neck.add(neckSkin);
    this.skinMeshes.push(neckSkin);

    this.addSocket('c7_spinous', neck, 0, 0.005, -0.032);
    this.addSocket('c4_spinous', neck, 0, 0.048, -0.024);
    this.addSocket('c1_arch', neck, 0, 0.084, -0.026);
    for (const [sfx, sg] of [['R', -1], ['L', 1]] as const) {
      this.addSocket(`c_transverse_upper${sfx}`, neck, sg * 0.024, 0.074, -0.004);
      this.addSocket(`c_transverse${sfx}`, neck, sg * 0.026, 0.05, 0.0);
    }

    const head = this.makeJoint('head', neck, 0, 0.095, 0.008);
    const headGeometry = createFacelessHead();
    const headPositions = headGeometry.getAttribute('position');
    this.fallbackCrown.fromBufferAttribute(headPositions, headPositions.count - 1);
    const fallbackHead = new THREE.Mesh(headGeometry, this.skinMat);
    fallbackHead.name = 'FallbackHead';
    this.skinMeshes.push(fallbackHead);
    const cranium = new THREE.Mesh(headGeometry, this.boneMat);
    cranium.name = 'Cranium';
    cranium.scale.set(0.90, 0.78, 0.93);
    cranium.position.set(0, 0.026, -0.005);
    cranium.updateMatrix();
    this.skullCrown.copy(this.fallbackCrown).applyMatrix4(cranium.matrix);
    head.add(cranium, fallbackHead);

    this.addSocket('occiput', head, 0, 0.042, -0.078);
    this.addSocket('vertex', head, 0, 0.205, 0.005);
    this.addSocket('head_crown', head, 0, 0, 0).position.copy(this.fallbackCrown);
    this.addSocket('forehead', head, 0, 0.092, 0.084);
    for (const [sfx, sg] of [['R', -1], ['L', 1]] as const) {
      this.addSocket(`occiput${sfx}`, head, sg * 0.026, 0.044, -0.075);
      this.addSocket(`mastoid${sfx}`, head, sg * 0.068, 0.046, -0.022);
      this.addSocket(`temple${sfx}`, head, sg * 0.072, 0.097, 0.015);
    }

    // Bilateral Shoulder Girdle (Clavicle + Scapula + Arm + Forearm + Hand)
    for (const [sfx, sg] of [['R', -1], ['L', 1]] as const) {
      const clav = this.makeJoint(`clavicle${sfx}`, thoracic, sg * 0.022, 0.242, 0.112);

      // Clavicle bone from sternoclavicular joint out to acromion
      const clavEnd: [number, number, number] = [sg * 0.162, 0.012, -0.085];
      this.addLimbSegment(clav, [0, 0, 0], clavEnd, 0.018, 0.018, 0.011);

      // Triangular Scapula plate on the posterior thoracic wall!
      const scapShape = new THREE.Shape();
      scapShape.moveTo(0, 0); // acromion / glenoid lateral corner
      scapShape.lineTo(-sg * 0.095, 0.018); // superior medial angle
      scapShape.lineTo(-sg * 0.088, -0.125); // inferior angle
      scapShape.closePath();
      const scapGeo = new THREE.ExtrudeGeometry(scapShape, { depth: 0.009, bevelEnabled: true, bevelSize: 0.003, bevelThickness: 0.003 });
      const scapMesh = new THREE.Mesh(scapGeo, this.boneMat);
      scapMesh.position.set(sg * 0.158, 0.002, -0.128);
      scapMesh.rotation.y = sg * -0.18;
      clav.add(scapMesh);

      // Scapular spine ridge (landmark separating supraspinatus and infraspinatus!)
      const spineRidge = new THREE.Mesh(new THREE.BoxGeometry(0.105, 0.012, 0.018), this.boneMat);
      spineRidge.position.set(sg * 0.112, 0.006, -0.132);
      spineRidge.rotation.z = sg * -0.15;
      clav.add(spineRidge);

      this.addSocket(`clavicle_med${sfx}`, clav, sg * 0.025, 0.003, -0.012);
      this.addSocket(`clavicle_lat${sfx}`, clav, sg * 0.125, 0.012, -0.068);
      this.addSocket(`acromion${sfx}`, clav, sg * 0.172, 0.016, -0.092);
      this.addSocket(`coracoid${sfx}`, clav, sg * 0.138, -0.008, -0.055);
      this.addSocket(`scapula_sup_angle${sfx}`, clav, sg * 0.066, 0.022, -0.124);
      this.addSocket(`supraspinous_fossa${sfx}`, clav, sg * 0.095, 0.02, -0.125);
      this.addSocket(`infraspinous_fossa_sup${sfx}`, clav, sg * 0.088, -0.025, -0.132);
      this.addSocket(`infraspinous_fossa_inf${sfx}`, clav, sg * 0.092, -0.082, -0.128);
      this.addSocket(`scapula_medial_border${sfx}`, clav, sg * 0.068, -0.04, -0.128);
      this.addSocket(`scapula_inf_angle${sfx}`, clav, sg * 0.075, -0.115, -0.125);
      this.addSocket(`supraglenoid_tubercle${sfx}`, clav, sg * 0.162, 0.01, -0.086);
      this.addSocket(`infraglenoid_tubercle${sfx}`, clav, sg * 0.158, -0.022, -0.098);

      // Glenohumeral (Shoulder) Joint
      const shoulder = this.makeJoint(`shoulder${sfx}`, clav, sg * 0.168, -0.006, -0.092);
      const upperArmLen = 0.285;
      this.addLimbSegment(shoulder, [0, 0, 0], [0, -upperArmLen, 0], 0.052, 0.042, 0.018);

      this.addSocket(`shoulder_joint${sfx}`, shoulder, 0, 0, 0);
      this.addSocket(`shoulder_post_capsule${sfx}`, clav, sg * 0.172, -0.008, -0.126);
      this.addSocket(`shoulder_ant_capsule${sfx}`, clav, sg * 0.168, -0.006, -0.048);
      this.addSocket(`shoulder_inf_capsule${sfx}`, clav, sg * 0.145, -0.045, -0.105);
      this.addSocket(`humerus_greater_tubercle${sfx}`, shoulder, sg * 0.036, -0.022, -0.018);
      this.addSocket(`humerus_bicipital_ridge${sfx}`, shoulder, sg * 0.026, -0.092, 0.028);
      this.addSocket(`humerus_med_crest${sfx}`, shoulder, -sg * 0.022, -0.105, -0.012);
      this.addSocket(`humerus_post_shaft${sfx}`, shoulder, 0, -0.145, -0.026);
      this.addSocket(`humerus_lat_epicondyle${sfx}`, shoulder, sg * 0.028, -upperArmLen + 0.012, 0);
      this.addSocket(`humerus_med_epicondyle${sfx}`, shoulder, -sg * 0.026, -upperArmLen + 0.012, 0);

      // Elbow & Forearm
      const elbow = this.makeJoint(`elbow${sfx}`, shoulder, 0, -upperArmLen, 0);
      const forearmLen = 0.255;
      this.addLimbSegment(elbow, [0, 0, 0], [0, -forearmLen, 0], 0.041, 0.03, 0.015);
      this.addSocket(`elbow_joint${sfx}`, elbow, 0, 0, 0);
      this.addSocket(`elbow_post_wrap${sfx}`, shoulder, 0, -upperArmLen - 0.008, -0.028);
      this.addSocket(`olecranon${sfx}`, elbow, 0, 0.028, -0.028);
      this.addSocket(`radial_tuberosity${sfx}`, elbow, sg * 0.016, -0.048, 0.022);
      this.addSocket(`forearm_mid${sfx}`, elbow, 0, -forearmLen * 0.55, 0);
      this.addSocket(`wrist_palmar${sfx}`, elbow, 0, -forearmLen + 0.004, 0.026);
      this.addSocket(`wrist_dorsal${sfx}`, elbow, 0, -forearmLen + 0.004, -0.026);

      // Wrist & Hand
      const wrist = this.makeJoint(`wrist${sfx}`, elbow, 0, -forearmLen, 0);
      const palm = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.095, 0.065), this.boneMat);
      palm.position.set(0, -0.048, 0.005);
      wrist.add(palm);
      const palmSkin = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.105, 0.074), this.skinMat);
      palmSkin.position.set(0, -0.05, 0.005);
      wrist.add(palmSkin);
      this.skinMeshes.push(palmSkin);
      this.addSocket(`hand${sfx}`, wrist, 0, -0.065, 0.005);
      this.addSocket(`metacarpal_2_3${sfx}`, wrist, -sg * 0.01, -0.056, -0.018);
      this.addSocket(`palm_fingers${sfx}`, wrist, 0, -0.098, 0.018);
      this.addSocket(`dorsal_fingers${sfx}`, wrist, 0, -0.095, -0.018);
    }

    // Bilateral Lower Limb (Hip + Femur + Knee + Tibia/Fibula + Ankle + Foot)
    for (const [sfx, sg] of [['R', -1], ['L', 1]] as const) {
      const hip = this.makeJoint(`hip${sfx}`, pelvis, sg * 0.096, -0.045, 0.0);
      const thighLen = 0.43;
      this.addLimbSegment(hip, [0, 0, 0], [0, -thighLen, 0], 0.076, 0.056, 0.024);

      // Greater trochanter bony prominence
      const trochanter = new THREE.Mesh(new THREE.SphereGeometry(0.024, 10, 8), this.boneMat);
      trochanter.position.set(sg * 0.032, -0.018, -0.008);
      hip.add(trochanter);

      this.addSocket(`hip_joint${sfx}`, hip, 0, 0, 0);
      this.addSocket(`hip_post_wrap${sfx}`, pelvis, sg * 0.098, -0.062, -0.062);
      this.addSocket(`hip_lat_wrap${sfx}`, pelvis, sg * 0.158, -0.035, 0.012);
      this.addSocket(`greater_trochanter${sfx}`, hip, sg * 0.048, -0.032, -0.016);
      this.addSocket(`lesser_trochanter${sfx}`, hip, -sg * 0.018, -0.052, -0.012);
      this.addSocket(`gluteal_tuberosity${sfx}`, hip, sg * 0.028, -0.105, -0.032);
      this.addSocket(`femur_linea_aspera${sfx}`, hip, -sg * 0.016, -0.19, -0.02);
      this.addSocket(`thigh_lat_itb${sfx}`, hip, sg * 0.052, -0.21, 0.0);
      this.addSocket(`thigh_ant_mid${sfx}`, hip, 0, -0.21, 0.038);
      this.addSocket(`thigh_mid_post${sfx}`, hip, 0, -thighLen * 0.52, -0.038);
      this.addSocket(`femur_condyle_med${sfx}`, hip, -sg * 0.024, -thighLen + 0.025, -0.026);
      this.addSocket(`femur_condyle_lat${sfx}`, hip, sg * 0.024, -thighLen + 0.025, -0.026);

      // Knee & Lower Leg
      const knee = this.makeJoint(`knee${sfx}`, hip, 0, -thighLen, 0);
      const patella = new THREE.Mesh(new THREE.SphereGeometry(0.02, 10, 8), this.boneMat);
      patella.scale.set(1, 1.1, 0.55);
      patella.position.set(0, 0.005, 0.036);
      knee.add(patella);

      const shinLen = 0.415;
      this.addLimbSegment(knee, [0, 0, 0], [0, -shinLen, 0], 0.054, 0.036, 0.019);

      this.addSocket(`knee_joint${sfx}`, knee, 0, 0, 0);
      this.addSocket(`patella_ant${sfx}`, knee, 0, 0.008, 0.04);
      this.addSocket(`knee_post_wrap${sfx}`, knee, 0, -0.01, -0.034);
      this.addSocket(`tibia_med_condyle${sfx}`, knee, -sg * 0.024, -0.038, -0.02);
      this.addSocket(`pes_anserinus${sfx}`, knee, -sg * 0.026, -0.052, 0.012);
      this.addSocket(`gerdy_tubercle${sfx}`, knee, sg * 0.03, -0.036, 0.016);
      this.addSocket(`fibula_head${sfx}`, knee, sg * 0.028, -0.042, -0.016);
      this.addSocket(`tibial_tuberosity${sfx}`, knee, 0, -0.048, 0.03);
      this.addSocket(`tibia_post_upper${sfx}`, knee, 0, -0.105, -0.026);
      this.addSocket(`tibia_lat_shaft${sfx}`, knee, sg * 0.018, -0.125, 0.022);
      this.addSocket(`calf_belly_lower${sfx}`, knee, 0, -shinLen * 0.52, -0.036);
      this.addSocket(`achilles_mid${sfx}`, knee, 0, -shinLen * 0.78, -0.03);
      this.addSocket(`ankle_ant_retinaculum${sfx}`, knee, 0, -shinLen + 0.018, 0.026);

      // Ankle & Foot
      const ankle = this.makeJoint(`ankle${sfx}`, knee, 0, -shinLen, 0);
      const calcaneus = new THREE.Mesh(new THREE.SphereGeometry(0.026, 10, 8), this.boneMat);
      calcaneus.scale.set(0.85, 0.85, 1.25);
      calcaneus.position.set(0, -0.026, -0.032);
      ankle.add(calcaneus);

      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.072, 0.034, 0.195), this.boneMat);
      foot.position.set(0, -0.032, 0.058);
      ankle.add(foot);

      const footSkin = new THREE.Mesh(new THREE.BoxGeometry(0.082, 0.042, 0.21), this.skinMat);
      footSkin.position.set(0, -0.03, 0.056);
      ankle.add(footSkin);
      this.skinMeshes.push(footSkin);

      this.addSocket(`ankle_joint${sfx}`, ankle, 0, 0, 0);
      this.addSocket(`calcaneus${sfx}`, ankle, 0, -0.024, -0.048);
      this.addSocket(`medial_cuneiform${sfx}`, ankle, -sg * 0.026, -0.034, 0.068);
      this.addSocket(`forefoot${sfx}`, ankle, 0, -0.045, 0.115);
    }
  }

  public applyPose(pose: PoseAngles): void {
    const [rx, ry, rz] = pose.rootPos ?? [0, 0.94, 0];
    this.joints.root.position.set(rx, ry, rz);
    this.surface?.colorPass.boundingSphere?.center.copy(this.joints.root.position);
    this.joints.root.rotation.set(
      (pose.rootPitch ?? 0) * DEG,
      (pose.rootYaw ?? 0) * DEG,
      -(pose.rootRoll ?? 0) * DEG,
      'YXZ'
    );

    // Pelvis: +pitch tilts pelvis/trunk forward (+X around X axis)
    this.joints.pelvis.rotation.set(
      (pose.pelvis?.pitch ?? 0) * DEG,
      (pose.pelvis?.yaw ?? 0) * DEG,
      -(pose.pelvis?.roll ?? 0) * DEG,
      'YXZ'
    );

    const applySpine = (g: THREE.Bone, sp?: SpineAngles) => {
      g.rotation.set(
        (sp?.flex ?? 0) * DEG,
        (sp?.twistLeft ?? 0) * DEG,
        -(sp?.leanLeft ?? 0) * DEG,
        'YXZ'
      );
    };
    applySpine(this.joints.lumbar, pose.lumbar);
    applySpine(this.joints.thoracic, pose.thoracic);

    const applyNeckHead = (g: THREE.Bone, e?: Euler3) => {
      g.rotation.set(
        (e?.flex ?? 0) * DEG,
        (e?.turnLeft ?? 0) * DEG,
        -(e?.tiltLeft ?? 0) * DEG,
        'YXZ'
      );
    };
    applyNeckHead(this.joints.neck, pose.neck);
    applyNeckHead(this.joints.head, pose.head);

    for (const [sfx, sg] of [['R', -1], ['L', 1]] as const) {
      const cl = sfx === 'R' ? pose.clavicleR : pose.clavicleL;
      // Right (-X): +elevate rotates -Z; Left (+X): +elevate rotates +Z
      this.joints[`clavicle${sfx}`].rotation.set(
        0,
        -sg * (cl?.protract ?? 0) * DEG,
        sg * (cl?.elevate ?? 0) * DEG,
        'YZX'
      );

      const sh = sfx === 'R' ? pose.shoulderR : pose.shoulderL;
      // Intrinsic ZXY: first abduct in frontal plane (Z), then horizontal/sagittal flex/extend (X), then axial humerus spin (Y)!
      this.joints[`shoulder${sfx}`].rotation.set(
        -(sh?.flex ?? 0) * DEG,
        sg * (sh?.extRot ?? 0) * DEG,
        sg * (sh?.abduct ?? 0) * DEG,
        'ZXY'
      );

      const el = sfx === 'R' ? pose.elbowR : pose.elbowL;
      // Elbow flexes forward (-X brings -Y forearm toward +Z)
      this.joints[`elbow${sfx}`].rotation.set(
        -(el?.flex ?? 0) * DEG,
        -sg * (el?.pronate ?? 0) * DEG,
        0,
        'XZY'
      );

      const wr = sfx === 'R' ? pose.wristR : pose.wristL;
      this.joints[`wrist${sfx}`].rotation.set(
        -(wr?.flex ?? 0) * DEG,
        0,
        sg * (wr?.deviate ?? 0) * DEG,
        'XZY'
      );

      const hp = sfx === 'R' ? pose.hipR : pose.hipL;
      // Intrinsic XZY: first flex forward (-rx lifts -Y femur toward +Z), then abduct/adduct horizontally, then spin femur externally!
      this.joints[`hip${sfx}`].rotation.set(
        -(hp?.flex ?? 0) * DEG,
        sg * (hp?.extRot ?? 0) * DEG,
        sg * (hp?.abduct ?? 0) * DEG,
        'XZY'
      );

      const kn = sfx === 'R' ? pose.kneeR : pose.kneeL;
      // Knee flexes backward (+rx brings -Y shin toward -Z)
      this.joints[`knee${sfx}`].rotation.set((kn?.flex ?? 0) * DEG, 0, 0);

      const ak = sfx === 'R' ? pose.ankleR : pose.ankleL;
      // Dorsiflexion lifts forefoot (+Z) upward (+Y), which is -X rotation!
      this.joints[`ankle${sfx}`].rotation.set(
        -(ak?.dorsiflex ?? 0) * DEG,
        0,
        -sg * (ak?.invert ?? 0) * DEG,
        'XZY'
      );
    }

    this.root.updateMatrixWorld(true);
  }

  public getSocketWorldPos(name: string, out = new THREE.Vector3()): THREE.Vector3 {
    const s = this.sockets[name] ?? this.joints[name];
    if (!s) {
      return out.set(0, 1, 0);
    }
    return s.getWorldPosition(out);
  }
}
