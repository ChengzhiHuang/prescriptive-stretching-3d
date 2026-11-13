import { Mesh, SkinnedMesh, Texture, type BufferGeometry, type Material } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export interface HumanSurface {
  geometry: BufferGeometry;
  jointNames: string[];
}

function validateSkinning(mesh: SkinnedMesh): string[] {
  const { position, normal, skinIndex, skinWeight } = mesh.geometry.attributes;
  const jointNames = mesh.skeleton.bones.map((bone) => bone.name);
  if (!position?.count || position.itemSize !== 3 || normal?.itemSize !== 3 ||
      skinIndex?.itemSize !== 4 || skinWeight?.itemSize !== 4 ||
      [normal, skinIndex, skinWeight].some((attribute) => attribute.count !== position.count) ||
      jointNames.length === 0 || new Set(jointNames).size !== jointNames.length) {
    throw new Error('The human surface is missing its skinning data');
  }
  for (let vertex = 0; vertex < position.count; vertex++) {
    let weightSum = 0;
    for (let component = 0; component < 4; component++) {
      const index = skinIndex.getComponent(vertex, component);
      const weight = skinWeight.getComponent(vertex, component);
      if (!Number.isInteger(index) || index < 0 || index >= jointNames.length || !(weight >= 0 && weight <= 1)) {
        throw new Error('The human surface contains an invalid skin influence');
      }
      weightSum += weight;
    }
    if (Math.abs(weightSum - 1) > 0.01) throw new Error('The human surface contains an unbound vertex');
  }
  return jointNames;
}

export async function loadHumanSurface(): Promise<HumanSurface> {
  const modelUrl = new URL('../assets/human.glb', import.meta.url);
  const { scene } = await new GLTFLoader().loadAsync(modelUrl.href);
  const meshes: Mesh[] = [];
  scene.traverse((object) => {
    if (object instanceof Mesh) meshes.push(object);
  });

  let surfaceGeometry: BufferGeometry | undefined;
  try {
    const [mesh] = meshes;
    if (meshes.length !== 1 || !(mesh instanceof SkinnedMesh)) {
      throw new Error('Expected a single skinned human surface');
    }
    const { geometry } = mesh;
    const jointNames = validateSkinning(mesh);
    scene.updateMatrixWorld(true);
    geometry.applyMatrix4(mesh.bindMatrix);
    surfaceGeometry = geometry;
    return { geometry, jointNames };
  } finally {
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    for (const mesh of meshes) {
      if (mesh.geometry !== surfaceGeometry) geometries.add(mesh.geometry);
      if (Array.isArray(mesh.material)) mesh.material.forEach((material) => materials.add(material));
      else materials.add(mesh.material);
      if (mesh instanceof SkinnedMesh) mesh.skeleton.dispose();
    }
    geometries.forEach((geometry) => geometry.dispose());
    const textures = new Set<Texture>();
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value instanceof Texture) textures.add(value);
      }
      material.dispose();
    }
    for (const texture of textures) {
      if (typeof ImageBitmap !== 'undefined' && texture.image instanceof ImageBitmap) texture.image.close();
      texture.dispose();
    }
  }
}
