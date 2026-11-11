import * as THREE from 'three';
import type { StarBody } from '../galaxy/constellation';
import { starKind, type StarKind } from '../galaxy/kinds';
import { hashString, mulberry32 } from '../galaxy/random';
import { beamGeometry, ringBandsTexture, ringGeometry, rockGeometry, starSurfaceMaterial } from './models';

interface Slots {
  kind: StarKind;
  suns: number[];
  active?: number;
  rock?: number;
  crystal?: number;
  ring?: number;
  beam?: number;
  tilt: THREE.Quaternion;
  phase: number;
}

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);

/**
 * Every repo star in the constellation, drawn as its kind: steady stars,
 * boiling active stars, pulsars with beams, ringed giants, binary pairs,
 * tumbling asteroids and crystal remnants. Each part type is one
 * InstancedMesh, so hundreds of repos stay a handful of draw calls.
 */
export class StarModels {
  readonly group = new THREE.Group();
  readonly kinds: StarKind[];
  private readonly slots: Slots[];
  private readonly dim: boolean[];
  private readonly calm: THREE.InstancedMesh;
  private readonly boiling: THREE.InstancedMesh;
  private readonly rocks: THREE.InstancedMesh;
  private readonly crystals: THREE.InstancedMesh;
  private readonly rings: THREE.InstancedMesh;
  private readonly beams: THREE.InstancedMesh;
  private readonly calmMaterial = starSurfaceMaterial(0.25);
  private readonly boilMaterial = starSurfaceMaterial(1);
  private readonly disposables: { dispose(): void }[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly q2 = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly c = new THREE.Color();
  private readonly e = new THREE.Euler();
  private readonly o = new THREE.Vector3();

  constructor(
    private readonly stars: StarBody[],
    now = Date.now(),
  ) {
    this.kinds = stars.map((star) => starKind(star, now));
    this.dim = stars.map(() => false);
    const counts = { calm: 0, active: 0, rock: 0, crystal: 0, ring: 0, beam: 0 };
    this.slots = stars.map((star, i): Slots => {
      const kind = this.kinds[i]!;
      const random = mulberry32(hashString(star.id));
      const tilt = new THREE.Quaternion().setFromEuler(
        new THREE.Euler((random() - 0.5) * 1.2, random() * Math.PI * 2, (random() - 0.5) * 1.2),
      );
      const slot: Slots = { kind, suns: [], tilt, phase: random() * Math.PI * 2 };
      if (kind === 'active') slot.active = counts.active++;
      else if (kind === 'asteroid') slot.rock = counts.rock++;
      else if (kind === 'remnant') slot.crystal = counts.crystal++;
      else if (kind === 'binary') slot.suns.push(counts.calm++, counts.calm++);
      else slot.suns.push(counts.calm++);
      if (kind === 'giant') slot.ring = counts.ring++;
      if (kind === 'pulsar') slot.beam = counts.beam++;
      return slot;
    });

    const sphere = new THREE.SphereGeometry(1, 32, 20);
    const rock = rockGeometry(7, 1, 0.42);
    const crystal = new THREE.OctahedronGeometry(1, 0).scale(0.8, 1.35, 0.8);
    const ring = ringGeometry(1.45, 2.5);
    const beam = beamGeometry();
    const bands = ringBandsTexture();
    const rockMaterial = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.9, metalness: 0.05 });
    const crystalMaterial = new THREE.MeshStandardMaterial({
      flatShading: true,
      roughness: 0.15,
      metalness: 0.4,
      emissive: '#9fb4c8',
      emissiveIntensity: 0.25,
    });
    const ringMaterial = new THREE.MeshBasicMaterial({
      alphaMap: bands,
      transparent: true,
      opacity: 0.75,
      side: THREE.DoubleSide,
      depthWrite: false,
      toneMapped: false,
    });
    const beamMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    this.disposables.push(
      sphere, rock, crystal, ring, beam, bands,
      this.calmMaterial, this.boilMaterial, rockMaterial, crystalMaterial, ringMaterial, beamMaterial,
    );

    const make = (geometry: THREE.BufferGeometry, material: THREE.Material, count: number) => {
      const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, count));
      mesh.count = count;
      mesh.frustumCulled = false;
      // Create the colour attribute up front so shaders compile with it.
      mesh.setColorAt(0, new THREE.Color(1, 1, 1));
      this.group.add(mesh);
      return mesh;
    };
    this.calm = make(sphere, this.calmMaterial, counts.calm);
    this.boiling = make(sphere, this.boilMaterial, counts.active);
    this.rocks = make(rock, rockMaterial, counts.rock);
    this.crystals = make(crystal, crystalMaterial, counts.crystal);
    this.rings = make(ring, ringMaterial, counts.ring);
    this.beams = make(beam, beamMaterial, counts.beam);

    // Rocks and crystals are lit; the stars light themselves.
    const sun = new THREE.DirectionalLight('#fff4e0', 2.2);
    sun.position.set(1, 2, 1.5);
    this.group.add(sun, new THREE.AmbientLight('#8fb3a6', 0.9));

    stars.forEach((_, i) => this.paint(i));
    this.update(0);
  }

  /** Dim a star (filtered out, or not in the toured constellation). */
  setDim(index: number, dim: boolean) {
    if (this.dim[index] === dim) return;
    this.dim[index] = dim;
    this.paint(index);
  }

  update(elapsed: number) {
    this.calmMaterial.uniforms.uTime!.value = elapsed;
    this.boilMaterial.uniforms.uTime!.value = elapsed;
    this.stars.forEach((star, i) => this.place(star, this.slots[i]!, this.dim[i]!, elapsed));
    for (const mesh of [this.calm, this.boiling, this.rocks, this.crystals, this.rings, this.beams])
      mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    for (const item of this.disposables) item.dispose();
  }

  private set(mesh: THREE.InstancedMesh, id: number, quaternion: THREE.Quaternion, sx: number, sy = sx, sz = sx) {
    this.m.compose(this.p, quaternion, this.s.set(sx, sy, sz));
    mesh.setMatrixAt(id, this.m);
  }

  private place(star: StarBody, slot: Slots, dim: boolean, t: number) {
    const r = star.radius * (dim ? 0.5 : 1);
    const { x, y, z } = star.position;
    this.p.set(x, y, z);
    const spin = this.q.setFromAxisAngle(Y, t * 0.12 + slot.phase);
    switch (slot.kind) {
      case 'active':
        this.set(this.boiling, slot.active!, spin, r);
        break;
      case 'asteroid':
        this.q.setFromEuler(this.e.set(t * 0.5 + slot.phase, t * 0.35, t * 0.2));
        this.set(this.rocks, slot.rock!, this.q, r * 0.95);
        break;
      case 'remnant':
        this.q.copy(slot.tilt).premultiply(this.q2.setFromAxisAngle(Y, t * 0.35));
        this.set(this.crystals, slot.crystal!, this.q, r * 0.9);
        break;
      case 'binary': {
        const angle = t * 0.9 + slot.phase;
        const offset = this.o.set(Math.cos(angle), 0, Math.sin(angle)).multiplyScalar(r * 0.85).applyQuaternion(slot.tilt);
        this.p.set(x + offset.x, y + offset.y, z + offset.z);
        this.set(this.calm, slot.suns[0]!, spin, r * 0.55);
        this.p.set(x - offset.x, y - offset.y, z - offset.z);
        this.set(this.calm, slot.suns[1]!, spin, r * 0.42);
        break;
      }
      case 'pulsar':
        this.set(this.calm, slot.suns[0]!, spin, r * 0.75);
        // Beams tilted off the spin axis precess around it: a lighthouse sweep.
        this.q.setFromAxisAngle(Y, t * 1.8 + slot.phase).multiply(this.q2.setFromAxisAngle(X, 0.6));
        if (dim) this.set(this.beams, slot.beam!, this.q, 0);
        else this.set(this.beams, slot.beam!, this.q, r * 0.55, r, r * 0.55);
        break;
      case 'giant':
        this.set(this.calm, slot.suns[0]!, spin, r);
        this.set(this.rings, slot.ring!, slot.tilt, dim ? 0 : r);
        break;
      default:
        this.set(this.calm, slot.suns[0]!, spin, r);
    }
  }

  private paint(index: number) {
    const star = this.stars[index]!;
    const slot = this.slots[index]!;
    const dim = this.dim[index]!;
    // Push bright stars above 1.0 so the bloom pass picks them up.
    const glow = this.c.set(star.color).multiplyScalar(dim ? 0.18 : 0.45 + star.brightness * 1.9);
    for (const id of slot.suns) this.calm.setColorAt(id, glow);
    if (slot.active !== undefined) this.boiling.setColorAt(slot.active, glow);
    const solid = new THREE.Color(star.color).lerp(new THREE.Color('#9a9a9a'), 0.35).multiplyScalar(dim ? 0.25 : 1);
    if (slot.rock !== undefined) this.rocks.setColorAt(slot.rock, solid);
    if (slot.crystal !== undefined) this.crystals.setColorAt(slot.crystal, solid.clone().lerp(new THREE.Color('#dfe9f2'), 0.4));
    const light = new THREE.Color(star.color).multiplyScalar(1.3);
    if (slot.ring !== undefined) this.rings.setColorAt(slot.ring, light);
    if (slot.beam !== undefined) this.beams.setColorAt(slot.beam, light.clone().lerp(new THREE.Color('#ffffff'), 0.4));
    for (const mesh of [this.calm, this.boiling, this.rocks, this.crystals, this.rings, this.beams])
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
}
