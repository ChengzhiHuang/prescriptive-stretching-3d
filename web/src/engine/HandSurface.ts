import { BufferGeometry, Matrix4, Vector3 } from 'three';

/** Bend the distal finger surface in wrist bind space. Keep the palm and wrist
 * seam fixed. Only actions using a grip allocate these vertex samples. */
export class HandSurface {
  private amount = 0;
  private readonly samples: {
    index: number; open: Vector3; closed: Vector3; openNormal: Vector3; closedNormal: Vector3;
  }[] = [];
  private readonly scratch = new Vector3();

  constructor(private geometry: BufferGeometry, joint: number, inverseBind: Matrix4, inward: number) {
    const { position, normal, skinIndex, skinWeight } = geometry.attributes;
    const bind = inverseBind.clone().invert();
    for (let i = 0; i < position.count; i++) {
      if (skinIndex.getX(i) !== joint || skinWeight.getX(i) < 0.75) continue;
      const open = new Vector3().fromBufferAttribute(position, i);
      const local = open.clone().applyMatrix4(inverseBind);
      const length = -local.y - 0.05;
      if (length <= 0) continue;
      const radius = 0.022;
      const angle = length / radius;
      const sine = Math.sin(angle), cosine = Math.cos(angle);
      const depth = local.x * inward;
      const closed = new Vector3(
        inward * (radius * (1 - cosine) + depth * cosine),
        -0.05 - (radius - depth) * sine, local.z,
      ).applyMatrix4(bind);
      const openNormal = new Vector3().fromBufferAttribute(normal, i);
      const n = openNormal.clone().transformDirection(inverseBind);
      const closedNormal = new Vector3(n.x * cosine - inward * n.y * sine,
        inward * n.x * sine + n.y * cosine, n.z).transformDirection(bind);
      this.samples.push({ index: i, open, closed, openNormal, closedNormal });
    }
  }

  setAmount(amount: number): void {
    if (amount === this.amount) return;
    this.amount = amount;
    const { position, normal } = this.geometry.attributes;
    for (const v of this.samples) {
      const p = this.scratch.lerpVectors(v.open, v.closed, amount);
      position.setXYZ(v.index, p.x, p.y, p.z);
      p.lerpVectors(v.openNormal, v.closedNormal, amount).normalize();
      normal.setXYZ(v.index, p.x, p.y, p.z);
    }
    position.needsUpdate = normal.needsUpdate = true;
  }
}
