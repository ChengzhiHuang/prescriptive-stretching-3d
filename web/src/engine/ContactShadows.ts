import * as THREE from 'three';
import type { HumanRig } from './HumanRig';

const contacts = [
  { socket: 'pelvis_center', width: 0.58, length: 0.49, reach: 1.65, opacity: 0.31 },
  { socket: 'medial_cuneiformR', width: 0.19, length: 0.30, reach: 0.22, opacity: 0.54 },
  { socket: 'medial_cuneiformL', width: 0.19, length: 0.30, reach: 0.22, opacity: 0.54 },
  { socket: 'knee_jointR', width: 0.25, length: 0.25, reach: 0.22, opacity: 0.38 },
  { socket: 'knee_jointL', width: 0.25, length: 0.25, reach: 0.22, opacity: 0.38 },
  { socket: 'handR', width: 0.19, length: 0.19, reach: 0.18, opacity: 0.34 },
  { socket: 'handL', width: 0.19, length: 0.19, reach: 0.18, opacity: 0.34 },
];

/** Floor contact cues driven by the same sockets as the exercise. */
export class ContactShadows {
  public readonly group = new THREE.Group();
  private readonly position = new THREE.Vector3();
  private readonly shadows: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>[];

  constructor() {
    const geometry = new THREE.PlaneGeometry(1, 1);
    this.shadows = contacts.map(() => {
      const material = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: { strength: { value: 0 } },
        vertexShader: `
          varying vec2 vUv;
          varying vec2 vFloor;
          void main() {
            vUv = uv;
            vec4 worldPosition = modelMatrix * vec4(position, 1.0);
            vFloor = worldPosition.xz;
            gl_Position = projectionMatrix * viewMatrix * worldPosition;
          }
        `,
        fragmentShader: `
          uniform float strength;
          varying vec2 vUv;
          varying vec2 vFloor;
          void main() {
            float distanceFromCenter = length(vUv * 2.0 - 1.0);
            float falloff = 1.0 - smoothstep(0.12, 1.0, distanceFromCenter);
            float floorEdge = 1.0 - smoothstep(1.63, 1.74, length(vFloor));
            gl_FragColor = vec4(0.0, 0.0, 0.0, strength * falloff * falloff * floorEdge);
          }
        `,
      });
      const shadow = new THREE.Mesh(geometry, material);
      shadow.rotation.x = -Math.PI / 2;
      shadow.visible = false;
      shadow.renderOrder = -1;
      this.group.add(shadow);
      return shadow;
    });
  }

  public update(rig: HumanRig): void {
    for (const [index, contact] of contacts.entries()) {
      const position = rig.getSocketWorldPos(contact.socket, this.position);
      const shadow = this.shadows[index];
      const lift = THREE.MathUtils.clamp(position.y / contact.reach, 0, 1);
      shadow.visible = lift < 1;
      if (!shadow.visible) continue;
      const spread = 1 + lift * 0.55;
      shadow.position.set(position.x, 0.002, position.z);
      shadow.scale.set(contact.width * spread, contact.length * spread, 1);
      shadow.material.uniforms.strength.value = contact.opacity * (1 - lift);
    }
  }
}
