import * as THREE from 'three';
import type { Lane } from '../galaxy/imports';
import type { MoonBody, PlanetBody, SystemModel } from '../galaxy/system';
import type { Pickable, View } from './stage';
import { hasRings, planetKind } from '../galaxy/kinds';
import { hashString } from '../galaxy/random';
import { gasGiantMaterial, ringBandsTexture, ringGeometry, rockGeometry } from './models';
import { glowTexture } from './textures';

export interface PlanetPickable extends Pickable {
  kind: 'planet';
  planet: PlanetBody;
}
export interface StarPickable extends Pickable {
  kind: 'star';
}
export type SystemPickable = PlanetPickable | StarPickable;

const starVertex = /* glsl */ `
  varying vec3 vPos;
  varying vec3 vNormal;
  void main() {
    vPos = position;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Animated value noise for a boiling surface; uFlare brightens it with commit activity.
const starFragment = /* glsl */ `
  uniform float uTime;
  uniform float uFlare;
  uniform vec3 uColor;
  varying vec3 vPos;
  varying vec3 vNormal;
  float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  float noise(vec3 p) {
    vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  void main() {
    vec3 p = normalize(vPos) * 3.0;
    float n = noise(p + uTime * 0.25) * 0.5 + noise(p * 2.3 - uTime * 0.4) * 0.3 + noise(p * 5.1 + uTime) * 0.2;
    float rim = pow(1.0 - abs(dot(vNormal, vec3(0.0, 0.0, 1.0))), 2.0);
    vec3 hot = mix(uColor, vec3(1.0, 0.97, 0.9), 0.55);
    vec3 col = mix(uColor * 0.8, hot, n) * (1.2 + uFlare * 1.6) + rim * uColor * 0.8;
    gl_FragColor = vec4(col, 1.0);
  }
`;

function moonMesh(moons: MoonBody[], disposables: { dispose(): void }[]) {
  // Lumpy little rocks instead of perfect spheres.
  const geometry = rockGeometry(11, 1, 0.45);
  const material = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.05, flatShading: true });
  disposables.push(geometry, material);
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, moons.length));
  mesh.count = moons.length;
  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();
  moons.forEach((moon, i) => {
    matrix.makeScale(moon.radius, moon.radius, moon.radius).setPosition(moon.offset.x, moon.offset.y, moon.offset.z);
    mesh.setMatrixAt(i, matrix);
    mesh.setColorAt(i, color.set(moon.color));
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

interface PlanetNode {
  planet: PlanetBody;
  arm: THREE.Object3D;
  body: THREE.Object3D;
  moons: THREE.Object3D;
  /** The planet model itself, which turns on its axis. */
  shape: THREE.Object3D;
  spin: number;
}

/**
 * A planet drawn as its kind: a rotating space station for CI folders, an
 * ice world for tests, a banded gas giant (maybe ringed) for big folders,
 * and a rocky world for everything else.
 */
function planetModel(planet: PlanetBody, disposables: { dispose(): void }[], gasMaterials: THREE.ShaderMaterial[]) {
  const seed = hashString(planet.id);
  const group = new THREE.Group();
  const color = new THREE.Color(planet.color);
  switch (planetKind(planet)) {
    case 'station': {
      const hull = new THREE.MeshStandardMaterial({ color: '#c9d3d1', metalness: 0.3, roughness: 0.45, emissive: '#3a4a47', emissiveIntensity: 0.6 });
      const lights = new THREE.MeshBasicMaterial({ color: '#5dffc0', toneMapped: false });
      const torus = new THREE.TorusGeometry(1, 0.2, 14, 48).rotateX(Math.PI / 2);
      const glow = new THREE.TorusGeometry(1, 0.05, 6, 48).rotateX(Math.PI / 2).translate(0, 0.17, 0);
      const hub = new THREE.CylinderGeometry(0.3, 0.3, 0.7, 16);
      const spoke = new THREE.CylinderGeometry(0.05, 0.05, 2, 6).rotateZ(Math.PI / 2);
      const dish = new THREE.ConeGeometry(0.28, 0.25, 16, 1, true).translate(0, 0.55, 0);
      disposables.push(hull, lights, torus, glow, hub, spoke, dish);
      group.add(new THREE.Mesh(torus, hull), new THREE.Mesh(glow, lights), new THREE.Mesh(hub, hull), new THREE.Mesh(dish, hull));
      group.add(new THREE.Mesh(spoke, hull), new THREE.Mesh(spoke, hull).rotateY(Math.PI / 2));
      break;
    }
    case 'ice': {
      const material = new THREE.MeshStandardMaterial({
        color: color.clone().lerp(new THREE.Color('#e8f6ff'), 0.6),
        roughness: 0.12,
        metalness: 0.15,
        flatShading: true,
        emissive: '#9fd8ff',
        emissiveIntensity: 0.12,
      });
      const geometry = rockGeometry(seed, 1, 0.18);
      disposables.push(material, geometry);
      group.add(new THREE.Mesh(geometry, material));
      // A few crystal spikes poking out.
      const spike = new THREE.OctahedronGeometry(0.28, 0).scale(0.6, 1.6, 0.6);
      disposables.push(spike);
      for (let i = 0; i < 6; i++) {
        const mesh = new THREE.Mesh(spike, material);
        const dir = new THREE.Vector3(Math.sin(i * 2.4 + seed), Math.cos(i * 1.7), Math.cos(i * 2.4 + seed)).normalize();
        mesh.position.copy(dir).multiplyScalar(0.95);
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        group.add(mesh);
      }
      break;
    }
    case 'gas': {
      const material = gasGiantMaterial(planet.color, seed);
      const geometry = new THREE.SphereGeometry(1, 48, 32);
      gasMaterials.push(material);
      disposables.push(material, geometry);
      group.add(new THREE.Mesh(geometry, material));
      if (hasRings(planet)) {
        const bands = ringBandsTexture();
        const rings = new THREE.Mesh(
          ringGeometry(1.4, 2.3),
          new THREE.MeshBasicMaterial({
            color: color.clone().lerp(new THREE.Color('#ffffff'), 0.35),
            alphaMap: bands,
            transparent: true,
            opacity: 0.7,
            side: THREE.DoubleSide,
            depthWrite: false,
          }),
        );
        rings.rotation.x = 0.35;
        disposables.push(bands, rings.geometry, rings.material as THREE.Material);
        group.add(rings);
      }
      break;
    }
    default: {
      const material = new THREE.MeshStandardMaterial({
        color: planet.color,
        roughness: 0.85,
        metalness: 0.05,
        flatShading: true,
        emissive: planet.color,
        emissiveIntensity: 0.08,
      });
      const geometry = rockGeometry(seed, 3, 0.14);
      disposables.push(material, geometry);
      group.add(new THREE.Mesh(geometry, material));
    }
  }
  group.scale.setScalar(planet.radius);
  group.rotation.z = ((seed % 100) / 100 - 0.5) * 0.6;
  return group;
}

/** One repository as a star with directory planets, file moons and import lanes. */
export class SystemView implements View {
  readonly root = new THREE.Group();
  private readonly disposables: { dispose(): void }[] = [];
  private readonly nodes = new Map<string, PlanetNode>();
  private readonly gasMaterials: THREE.ShaderMaterial[] = [];
  private readonly bodies: SystemPickable[] = [];
  private readonly starUniforms = {
    uTime: { value: 0 },
    uFlare: { value: 0 },
    uColor: { value: new THREE.Color() },
  };
  private readonly corona: THREE.Sprite;
  private readonly belt: THREE.Object3D;
  private flareTarget = 0;
  private lanes: { lane: Lane; line: THREE.Line }[] = [];
  private readonly laneMaterial = new THREE.LineBasicMaterial({
    color: '#5dffc0',
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  constructor(readonly model: SystemModel) {
    this.disposables.push(this.laneMaterial);
    const starGeometry = new THREE.SphereGeometry(model.starRadius, 64, 40);
    this.starUniforms.uColor.value.set(model.starColor);
    const starMaterial = new THREE.ShaderMaterial({
      uniforms: this.starUniforms,
      vertexShader: starVertex,
      fragmentShader: starFragment,
      toneMapped: false,
    });
    this.disposables.push(starGeometry, starMaterial);
    this.root.add(new THREE.Mesh(starGeometry, starMaterial));

    const coronaMaterial = new THREE.SpriteMaterial({
      map: glowTexture(),
      color: model.starColor,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0.6,
    });
    this.disposables.push(coronaMaterial);
    this.corona = new THREE.Sprite(coronaMaterial);
    this.corona.scale.setScalar(model.starRadius * 5);
    this.root.add(this.corona);

    const light = new THREE.PointLight('#fff6e8', 3.2, 0, 0);
    this.root.add(light, new THREE.AmbientLight('#335548', 0.9));

    this.belt = moonMesh(model.belt, this.disposables);
    this.root.add(this.belt);

    const orbitMaterial = new THREE.LineBasicMaterial({ color: '#20d99a', transparent: true, opacity: 0.12 });
    this.disposables.push(orbitMaterial);

    for (const planet of model.planets) {
      const plane = new THREE.Object3D();
      plane.rotation.x = planet.tilt;
      const ring = new THREE.BufferGeometry().setFromPoints(
        Array.from({ length: 129 }, (_, i) => {
          const a = (i / 128) * Math.PI * 2;
          return new THREE.Vector3(Math.cos(a) * planet.orbitRadius, 0, Math.sin(a) * planet.orbitRadius);
        }),
      );
      this.disposables.push(ring);
      plane.add(new THREE.Line(ring, orbitMaterial));

      const arm = new THREE.Object3D();
      arm.rotation.y = planet.angle;
      const body = new THREE.Object3D();
      body.position.x = planet.orbitRadius;
      const shape = planetModel(planet, this.disposables, this.gasMaterials);
      const moons = moonMesh(planet.moons, this.disposables);
      body.add(shape, moons);
      arm.add(body);
      plane.add(arm);
      this.root.add(plane);
      const spin = planetKind(planet) === 'station' ? 0.6 : 0.15 + (hashString(planet.id) % 10) / 40;
      this.nodes.set(planet.id, { planet, arm, body, moons, shape, spin });
      this.bodies.push({
        kind: 'planet',
        id: planet.id,
        label: planet.name,
        radius: planet.radius,
        planet,
        worldPosition: (target) => body.getWorldPosition(target),
      });
    }
    this.bodies.push({
      kind: 'star',
      id: '__star__',
      label: model.repo.name,
      radius: model.starRadius,
      worldPosition: (target) => target.set(0, 0, 0),
    });
  }

  /** 0–1 activity for the selected week; the star eases toward it. */
  setFlare(intensity: number) {
    this.flareTarget = Math.max(0, Math.min(1, intensity));
  }

  setLanes(lanes: Lane[]) {
    for (const { line } of this.lanes) {
      this.root.remove(line);
      line.geometry.dispose();
    }
    const max = Math.max(1, ...lanes.map((l) => l.count));
    this.lanes = lanes
      .filter((lane) => this.nodes.has(lane.from) && this.nodes.has(lane.to))
      .map((lane) => {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(25 * 3), 3));
        const material = this.laneMaterial.clone();
        material.opacity = 0.25 + 0.65 * (lane.count / max);
        this.disposables.push(material);
        const line = new THREE.Line(geometry, material);
        line.frustumCulled = false;
        this.root.add(line);
        return { lane, line };
      });
  }

  pickables() {
    return this.bodies;
  }

  labeled() {
    return this.bodies;
  }

  update(dt: number, elapsed: number) {
    this.starUniforms.uTime.value = elapsed;
    const flare = this.starUniforms.uFlare;
    flare.value += (this.flareTarget - flare.value) * Math.min(1, dt * 4 || 1);
    this.corona.scale.setScalar(this.model.starRadius * (4.5 + flare.value * 5 + Math.sin(elapsed * 2.1) * 0.15));
    this.corona.material.opacity = 0.45 + flare.value * 0.5;
    this.belt.rotation.y += dt * 0.05;
    for (const material of this.gasMaterials) material.uniforms.uTime!.value = elapsed;
    for (const { planet, arm, moons, shape, spin } of this.nodes.values()) {
      arm.rotation.y += dt * planet.speed;
      moons.rotation.y += dt * 0.08;
      shape.rotation.y += dt * spin;
    }
    this.updateLanes();
  }

  dispose() {
    for (const { line } of this.lanes) line.geometry.dispose();
    for (const item of this.disposables) item.dispose();
  }

  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly c = new THREE.Vector3();
  private readonly p = new THREE.Vector3();

  private updateLanes() {
    for (const { lane, line } of this.lanes) {
      this.nodes.get(lane.from)!.body.getWorldPosition(this.a);
      this.nodes.get(lane.to)!.body.getWorldPosition(this.b);
      // Arc the lane up out of the orbital plane so it reads as a route, not an orbit.
      this.c.addVectors(this.a, this.b).multiplyScalar(0.5);
      this.c.y += this.a.distanceTo(this.b) * 0.25 + 2;
      const attribute = line.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i <= 24; i++) {
        const t = i / 24;
        const u = 1 - t;
        this.p
          .copy(this.a)
          .multiplyScalar(u * u)
          .addScaledVector(this.c, 2 * u * t)
          .addScaledVector(this.b, t * t);
        attribute.setXYZ(i, this.p.x, this.p.y, this.p.z);
      }
      attribute.needsUpdate = true;
    }
  }
}
