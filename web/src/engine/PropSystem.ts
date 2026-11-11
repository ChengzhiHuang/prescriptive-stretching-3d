import * as THREE from 'three';
import type { HumanRig } from './HumanRig';
import type { PropSpec } from './types';

/**
 * Studio support props (chair, doorframe, bench, step platform, table/desk,
 * wall, corner-wall, horizontal bar, and dynamic helper cords/sticks) used
 * across all 40 Prescriptive Stretching exercises.
 */
export class PropSystem {
  public readonly group = new THREE.Group();
  private dynamicLinks: { sockets: string[]; mesh: THREE.Mesh }[] = [];

  private readonly woodMat = new THREE.MeshStandardMaterial({
    color: 0x3b4958,
    roughness: 0.65,
    metalness: 0.08,
  });

  private readonly metalMat = new THREE.MeshStandardMaterial({
    color: 0x64748b,
    roughness: 0.4,
    metalness: 0.35,
  });

  private readonly wallMat = new THREE.MeshStandardMaterial({
    color: 0x334155,
    roughness: 0.78,
    metalness: 0.05,
    transparent: true,
    opacity: 0.52,
  });

  private readonly strapMat = new THREE.MeshStandardMaterial({
    color: 0x94a3b8,
    roughness: 0.5,
    metalness: 0.15,
  });

  public setProps(specs: PropSpec[]): void {
    this.clear();
    for (const spec of specs) {
      if (spec.attachSockets && spec.attachSockets.length >= 2) {
        const mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.strapMat);
        this.group.add(mesh);
        this.dynamicLinks.push({ sockets: spec.attachSockets, mesh });
        continue;
      }
      const obj = this.buildProp(spec.type);
      obj.position.set(...spec.position);
      obj.rotation.y = ((spec.rotationY ?? 0) * Math.PI) / 180;
      if (spec.scale) {
        obj.scale.set(...spec.scale);
      }
      this.group.add(obj);
    }
  }

  public updateDynamicProps(rig: HumanRig): void {
    for (const link of this.dynamicLinks) {
      const pts = link.sockets.map((s) => rig.getSocketWorldPos(s, new THREE.Vector3()));
      const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.25);
      link.mesh.geometry.dispose();
      link.mesh.geometry = new THREE.TubeGeometry(curve, 18, 0.009, 8, false);
    }
  }

  public clear(): void {
    for (const l of this.dynamicLinks) {
      l.mesh.geometry.dispose();
    }
    this.dynamicLinks = [];
    this.group.clear();
  }

  private buildProp(type: PropSpec['type']): THREE.Group {
    const g = new THREE.Group();
    switch (type) {
      case 'chair': {
        const seat = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.032, 0.42), this.woodMat);
        seat.position.set(0, 0.45, 0);
        g.add(seat);
        const legGeo = new THREE.CylinderGeometry(0.015, 0.013, 0.44, 10);
        for (const [lx, lz] of [[-0.19, -0.18], [0.19, -0.18], [-0.19, 0.18], [0.19, 0.18]]) {
          const leg = new THREE.Mesh(legGeo, this.metalMat);
          leg.position.set(lx, 0.22, lz);
          g.add(leg);
        }
        const backBar = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.06, 0.022), this.woodMat);
        backBar.position.set(0, 0.66, -0.195);
        g.add(backBar);
        for (const lx of [-0.18, 0.18]) {
          const post = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.22, 8), this.metalMat);
          post.position.set(lx, 0.56, -0.195);
          g.add(post);
        }
        break;
      }
      case 'doorframe': {
        const jambR = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.05, 0.14), this.woodMat);
        jambR.position.set(-0.46, 1.025, 0);
        g.add(jambR);

        const wallWingR = new THREE.Mesh(new THREE.BoxGeometry(0.36, 2.05, 0.07), this.wallMat);
        wallWingR.position.set(-0.68, 1.025, 0);
        g.add(wallWingR);

        const jambL = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.05, 0.14), this.woodMat);
        jambL.position.set(0.46, 1.025, 0);
        g.add(jambL);

        const header = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.08, 0.14), this.woodMat);
        header.position.set(0, 2.04, 0);
        g.add(header);
        break;
      }
      case 'bench': {
        const top = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.045, 1.02), this.woodMat);
        top.position.set(0, 0.425, 0);
        g.add(top);
        const legGeo = new THREE.BoxGeometry(0.04, 0.41, 0.04);
        for (const [lx, lz] of [[-0.14, -0.44], [0.14, -0.44], [-0.14, 0.44], [0.14, 0.44]]) {
          const leg = new THREE.Mesh(legGeo, this.metalMat);
          leg.position.set(lx, 0.205, lz);
          g.add(leg);
        }
        break;
      }
      case 'step': {
        const block = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.16, 0.36), this.woodMat);
        block.position.set(0, 0.08, 0.22);
        g.add(block);
        const strip = new THREE.Mesh(
          new THREE.BoxGeometry(0.562, 0.012, 0.04),
          new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.5 })
        );
        strip.position.set(0, 0.162, 0.045);
        g.add(strip);
        break;
      }
      case 'table': {
        // Groin/desk-height table (height = 0.76m, top 0.76 x 0.92m)
        const top = new THREE.Mesh(new THREE.BoxGeometry(0.76, 0.04, 0.92), this.woodMat);
        top.position.set(0, 0.74, 0);
        g.add(top);
        const legGeo = new THREE.CylinderGeometry(0.02, 0.018, 0.72, 10);
        for (const [lx, lz] of [[-0.33, -0.41], [0.33, -0.41], [-0.33, 0.41], [0.33, 0.41]]) {
          const leg = new THREE.Mesh(legGeo, this.metalMat);
          leg.position.set(lx, 0.36, lz);
          g.add(leg);
        }
        break;
      }
      case 'wall': {
        // Translucent vertical wall panel (width 1.3m, height 2.05m, facing -Z/+Z)
        const panel = new THREE.Mesh(new THREE.BoxGeometry(1.3, 2.05, 0.06), this.wallMat);
        panel.position.set(0, 1.025, 0);
        g.add(panel);
        const trim = new THREE.Mesh(new THREE.BoxGeometry(1.31, 0.04, 0.07), this.woodMat);
        trim.position.set(0, 0.02, 0);
        g.add(trim);
        break;
      }
      case 'corner-wall': {
        // 90-degree room corner opening toward -Z (viewer) for Pectoralis Major v2!
        const wLeft = new THREE.Mesh(new THREE.BoxGeometry(0.95, 2.05, 0.06), this.wallMat);
        wLeft.position.set(-0.33, 1.025, 0.33);
        wLeft.rotation.y = Math.PI / 4;
        g.add(wLeft);

        const wRight = new THREE.Mesh(new THREE.BoxGeometry(0.95, 2.05, 0.06), this.wallMat);
        wRight.position.set(0.33, 1.025, 0.33);
        wRight.rotation.y = -Math.PI / 4;
        g.add(wRight);
        break;
      }
      case 'bar': {
        // Horizontal grip bar / rail supported by two vertical posts (default bar height = 1.05m)
        const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.76, 14), this.metalMat);
        bar.rotation.z = Math.PI / 2;
        bar.position.set(0, 1.05, 0);
        g.add(bar);
        for (const lx of [-0.36, 0.36]) {
          const post = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.022, 1.1, 10), this.woodMat);
          post.position.set(lx, 0.55, 0);
          g.add(post);
        }
        break;
      }
    }
    return g;
  }
}
