import * as THREE from 'three';
import type { Cluster, Constellation, StarBody } from '../galaxy/constellation';
import type { Pickable, View } from './stage';
import { glowTexture, ringTexture } from './textures';

export interface StarPickable extends Pickable {
  star: StarBody;
  index: number;
}

/** The user's repos as language constellations floating in 3D space. */
export class ConstellationView implements View {
  readonly root = new THREE.Group();
  private readonly spin = new THREE.Group();
  private readonly bodies: StarPickable[];
  private readonly headings: Pickable[];
  private readonly always: Pickable[];
  private readonly disposables: { dispose(): void }[] = [];
  private filter: ((star: StarBody) => boolean) | null = null;
  private readonly mesh: THREE.InstancedMesh;
  private readonly halos: THREE.Sprite[] = [];
  private spinning = true;
  private readonly marker = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: ringTexture(), color: '#5dffc0', transparent: true, depthWrite: false, opacity: 0.9 }),
  );
  private markerRadius = 1;
  private focus: number | null = null;
  private readonly brightest: StarPickable[];

  constructor(readonly constellation: Constellation) {
    this.root.add(this.spin);
    const { stars, clusters } = constellation;
    this.marker.visible = false;
    this.disposables.push(this.marker.material);
    this.spin.add(this.marker);

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
          opacity: this.haloOpacity(star),
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

    for (const cluster of clusters) this.addNebula(cluster);
    this.addLinks();

    this.bodies = stars.map((star, index) => ({
      id: star.id,
      label: star.repo.name,
      radius: star.radius,
      star,
      index,
      worldPosition: (target: THREE.Vector3) =>
        this.spin.localToWorld(target.set(star.position.x, star.position.y, star.position.z)),
    }));
    this.headings = clusters.map((cluster) => ({
      id: `cluster:${cluster.id}`,
      label: cluster.name,
      radius: cluster.radius,
      heading: true,
      worldPosition: (target: THREE.Vector3) =>
        this.spin.localToWorld(target.set(cluster.center.x, cluster.center.y + cluster.radius + 6, cluster.center.z)),
    }));
    this.brightest = clusters.map((cluster) => {
      const best = [...cluster.stars].sort(
        (a, b) => stars[b]!.brightness + stars[b]!.glow - (stars[a]!.brightness + stars[a]!.glow),
      )[0]!;
      return this.bodies[best]!;
    });
    // Constellation names, plus the single brightest star of each.
    this.always = [...this.headings, ...this.brightest];
  }

  /** Ring a star (selection, tour stop), or clear with null. */
  setMarker(index: number | null) {
    const star = index === null ? undefined : this.constellation.stars[index];
    this.marker.visible = !!star;
    if (!star) return;
    this.marker.position.set(star.position.x, star.position.y, star.position.z);
    this.markerRadius = star.radius;
  }

  /** Dim every constellation but one (the tour), or clear with null. */
  setFocus(cluster: number | null) {
    this.focus = cluster;
    this.applyVisibility();
  }

  /** Dim stars that do not match (search / language filter). */
  setFilter(filter: ((star: StarBody) => boolean) | null) {
    this.filter = filter;
    this.applyVisibility();
  }

  private applyVisibility() {
    const color = new THREE.Color();
    this.constellation.stars.forEach((star, i) => {
      const matches = !this.filter || this.filter(star);
      const focused = this.focus === null || star.cluster === this.focus;
      const on = matches && focused;
      this.mesh.setMatrixAt(i, this.matrixFor(star, on ? 1 : 0.5));
      this.mesh.setColorAt(i, color.set(star.color).multiplyScalar(on ? 0.45 + star.brightness * 1.9 : 0.18));
      this.halos[i]!.material.opacity = on ? this.haloOpacity(star) : 0.02;
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.linkMaterial?.setValues({ opacity: this.focus === null ? 0.32 : 0.1 });
    this.focusLinks?.removeFromParent();
    this.focusLinks = null;
    if (this.focus !== null) this.focusLinks = this.linesFor(this.focus, 0.45);
  }

  private linkMaterial: THREE.LineBasicMaterial | null = null;
  private focusLinks: THREE.LineSegments | null = null;

  /** The focused constellation's own lines, drawn brighter on top. */
  private linesFor(cluster: number, opacity: number) {
    const { stars, links } = this.constellation;
    const own = links.filter((l) => stars[l.from]!.cluster === cluster);
    if (!own.length) return null;
    const positions = new Float32Array(own.length * 6);
    own.forEach((link, i) => {
      const a = stars[link.from]!.position;
      const b = stars[link.to]!.position;
      positions.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({
      color: this.constellation.clusters[cluster]!.color,
      transparent: true,
      opacity,
      depthWrite: false,
    });
    this.disposables.push(geometry, material);
    const lines = new THREE.LineSegments(geometry, material);
    this.spin.add(lines);
    return lines;
  }

  /** The tour holds the sky still so the camera can frame things. */
  setSpinning(spinning: boolean) {
    this.spinning = spinning;
  }

  star(index: number): StarPickable {
    return this.bodies[index]!;
  }

  /** World-space centre of a constellation. */
  clusterCenter(cluster: Cluster, target = new THREE.Vector3()) {
    return this.spin.localToWorld(target.set(cluster.center.x, cluster.center.y, cluster.center.z));
  }

  pickables() {
    return this.filter ? this.bodies.filter((b) => this.filter!(b.star)) : this.bodies;
  }

  labeled() {
    if (this.focus !== null) return [this.headings[this.focus]!];
    if (this.filter) return [...this.headings, ...this.pickables().slice(0, 30)];
    return this.always;
  }

  update(dt: number, elapsed: number) {
    if (this.spinning) this.spin.rotation.y += dt * 0.008;
    if (this.marker.visible) this.marker.scale.setScalar(this.markerRadius * (3.4 + Math.sin(elapsed * 3) * 0.35) + 2);
  }

  dispose() {
    for (const item of this.disposables) item.dispose();
  }

  private haloOpacity(star: StarBody) {
    return 0.12 + star.brightness * 0.35 + star.glow * 0.25;
  }

  private matrixFor(star: StarBody, scale: number) {
    return new THREE.Matrix4().compose(
      new THREE.Vector3(star.position.x, star.position.y, star.position.z),
      new THREE.Quaternion(),
      new THREE.Vector3().setScalar(star.radius * scale),
    );
  }

  /** A faint cloud of the constellation's colour, so each one reads as a group. */
  private addNebula(cluster: Cluster) {
    const material = new THREE.SpriteMaterial({
      map: glowTexture(),
      color: cluster.color,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0.07,
    });
    this.disposables.push(material);
    const nebula = new THREE.Sprite(material);
    nebula.position.set(cluster.center.x, cluster.center.y, cluster.center.z);
    nebula.scale.setScalar((cluster.radius + 10) * 3.2);
    this.spin.add(nebula);
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
      opacity: 0.32,
      depthWrite: false,
    });
    this.linkMaterial = material;
    this.disposables.push(geometry, material);
    this.spin.add(new THREE.LineSegments(geometry, material));
  }
}
