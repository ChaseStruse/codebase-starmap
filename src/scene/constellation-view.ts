import * as THREE from 'three';
import type { Constellation, StarBody } from '../galaxy/constellation';
import type { Pickable, View } from './stage';
import { discTexture, glowTexture } from './textures';

interface StarPickable extends Pickable {
  star: StarBody;
  index: number;
}

const LABEL_COUNT = 14;

/** The user's repos as a slowly turning spiral of stars around their avatar. */
export class ConstellationView implements View {
  readonly root = new THREE.Group();
  private readonly spin = new THREE.Group();
  private readonly bodies: StarPickable[];
  private readonly always: StarPickable[];
  private readonly disposables: { dispose(): void }[] = [];
  private filter: ((star: StarBody) => boolean) | null = null;
  private readonly mesh: THREE.InstancedMesh;
  private readonly halos: THREE.Sprite[] = [];

  constructor(readonly constellation: Constellation) {
    this.root.add(this.spin);
    const { stars } = constellation;

    const geometry = new THREE.SphereGeometry(1, 20, 14);
    const material = new THREE.MeshBasicMaterial({ toneMapped: false });
    this.mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, stars.length));
    this.mesh.count = stars.length;
    this.disposables.push(geometry, material);
    this.spin.add(this.mesh);

    const color = new THREE.Color();
    stars.forEach((star, i) => {
      this.mesh.setMatrixAt(i, this.matrixFor(star, 1));
      // Push bright stars above 1.0 so the bloom pass picks them up.
      this.mesh.setColorAt(i, color.set(star.color).multiplyScalar(0.45 + star.brightness * 1.9));
      const halo = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glowTexture(),
          color: star.color,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          opacity: 0.12 + star.brightness * 0.35 + star.glow * 0.25,
        }),
      );
      halo.position.set(star.position.x, star.position.y, star.position.z);
      halo.scale.setScalar(star.radius * (4 + star.glow * 8));
      this.halos.push(halo);
      this.disposables.push(halo.material);
      this.spin.add(halo);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;

    this.addLinks();
    this.addCore();

    this.bodies = stars.map((star, index) => ({
      id: star.id,
      label: star.repo.name,
      radius: star.radius,
      star,
      index,
      worldPosition: (target: THREE.Vector3) =>
        this.spin.localToWorld(target.set(star.position.x, star.position.y, star.position.z)),
    }));
    this.always = [...this.bodies]
      .sort(
        (a, b) =>
          b.star.brightness + b.star.glow - (a.star.brightness + a.star.glow) || a.id.localeCompare(b.id),
      )
      .slice(0, LABEL_COUNT);
  }

  /** Dim stars that do not match (search / language filter). */
  setFilter(filter: ((star: StarBody) => boolean) | null) {
    this.filter = filter;
    this.constellation.stars.forEach((star, i) => {
      const on = !filter || filter(star);
      this.mesh.setMatrixAt(i, this.matrixFor(star, on ? 1 : 0.45));
      const material = this.halos[i]!.material;
      material.opacity = on ? 0.12 + star.brightness * 0.35 + star.glow * 0.25 : 0.03;
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  pickables() {
    return this.filter ? this.bodies.filter((b) => this.filter!(b.star)) : this.bodies;
  }

  labeled() {
    if (this.filter) return this.pickables().slice(0, 40);
    return this.always;
  }

  update(dt: number) {
    this.spin.rotation.y += dt * 0.012;
  }

  dispose() {
    for (const item of this.disposables) item.dispose();
  }

  private matrixFor(star: StarBody, scale: number) {
    return new THREE.Matrix4().compose(
      new THREE.Vector3(star.position.x, star.position.y, star.position.z),
      new THREE.Quaternion(),
      new THREE.Vector3().setScalar(star.radius * scale),
    );
  }

  private addLinks() {
    const { stars, links } = this.constellation;
    if (!links.length) return;
    const positions = new Float32Array(links.length * 6);
    const colors = new Float32Array(links.length * 6);
    const color = new THREE.Color();
    links.forEach((link, i) => {
      const a = stars[link.from]!.position;
      const b = stars[link.to]!.position;
      positions.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6);
      color.set(link.color);
      colors.set([color.r, color.g, color.b, color.r, color.g, color.b], i * 6);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
    });
    this.disposables.push(geometry, material);
    this.spin.add(new THREE.LineSegments(geometry, material));
  }

  /** A glowing core with the user's avatar at the centre of the spiral. */
  private addCore() {
    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture(),
        color: '#20d99a',
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0.55,
      }),
    );
    glow.scale.setScalar(34);
    this.disposables.push(glow.material);
    this.root.add(glow);

    const avatar = new THREE.SpriteMaterial({
      alphaMap: discTexture(),
      transparent: true,
      depthWrite: false,
      color: '#20d99a',
      opacity: 0.9,
    });
    this.disposables.push(avatar);
    const sprite = new THREE.Sprite(avatar);
    sprite.scale.setScalar(9);
    this.root.add(sprite);

    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    loader.load(
      `${this.constellation.user.avatar_url}${this.constellation.user.avatar_url.includes('?') ? '&' : '?'}s=256`,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        avatar.map = texture;
        avatar.color.set('#ffffff');
        avatar.opacity = 1;
        avatar.needsUpdate = true;
        this.disposables.push(texture);
      },
      undefined,
      () => {
        /* Avatar blocked or offline: keep the plain glowing core. */
      },
    );
  }
}
