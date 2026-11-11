import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { seeded } from '../galaxy/random';

/** Something the visitor can hover and click. */
export interface Pickable {
  id: string;
  label: string;
  radius: number;
  /** A constellation name rather than a body: larger label, never picked. */
  heading?: boolean;
  worldPosition(target: THREE.Vector3): THREE.Vector3;
}

/** One scene the stage can show: the constellation or a star system. */
export interface View {
  readonly root: THREE.Object3D;
  pickables(): readonly Pickable[];
  /** Bodies that keep a label on screen. */
  labeled(): readonly Pickable[];
  update(dt: number, elapsed: number): void;
  dispose(): void;
}

export const reducedMotion = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

interface Tween {
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  t: number;
  duration: number;
  resolve: () => void;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Owns the renderer, camera, controls, bloom and the frame loop. Views are
 * swapped in and out; the stage handles picking and HTML labels for them.
 */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private readonly scene = new THREE.Scene();
  private readonly composer: EffectComposer;
  private readonly timer = new THREE.Timer();
  private view: View | null = null;
  private tween: Tween | null = null;
  private labels = new Map<string, HTMLElement>();
  private highlighted = new Set<string>();
  private readonly v = new THREE.Vector3();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly labelLayer: HTMLElement,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.scene.background = new THREE.Color('#020906');
    this.scene.add(this.starfield());

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 6000);
    this.camera.position.set(0, 120, 220);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 1500;

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.85, 0.55, 0.62));
    this.composer.addPass(new OutputPass());

    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  setView(view: View, cameraPosition: THREE.Vector3, target: THREE.Vector3) {
    if (this.view) {
      this.scene.remove(this.view.root);
      this.view.dispose();
    }
    this.view = view;
    this.scene.add(view.root);
    this.tween = null;
    this.camera.position.copy(cameraPosition);
    this.controls.target.copy(target);
    this.controls.update();
    this.clearLabels();
  }

  /** Animate the camera; resolves when it arrives. */
  flyTo(position: THREE.Vector3, target: THREE.Vector3, duration = 1.4): Promise<void> {
    this.tween?.resolve();
    if (reducedMotion()) duration = 0.01;
    return new Promise((resolve) => {
      this.tween = {
        fromPos: this.camera.position.clone(),
        toPos: position.clone(),
        fromTarget: this.controls.target.clone(),
        toTarget: target.clone(),
        t: 0,
        duration,
        resolve,
      };
    });
  }

  /** The body under a screen point: nearest projected centre within its on-screen radius (min 16px). */
  pickAt(clientX: number, clientY: number): Pickable | null {
    if (!this.view) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best: Pickable | null = null;
    let bestScore = 1;
    for (const body of this.view.pickables()) {
      const screen = this.project(body);
      if (!screen) continue;
      const reach = Math.max(16, screen.radius * 1.2);
      // 0 = dead centre, 1 = edge of reach. Overlaps go to the nearer centre.
      const score = Math.hypot(screen.x - x, screen.y - y) / reach;
      if (score < bestScore) {
        best = body;
        bestScore = score;
      }
    }
    return best;
  }

  /** Bodies that get an emphasized label (hover, selection). */
  highlight(ids: Iterable<string>) {
    this.highlighted = new Set(ids);
  }

  /** World position of a body, for flying to it. */
  positionOf(body: Pickable) {
    return body.worldPosition(new THREE.Vector3());
  }

  private project(body: Pickable) {
    body.worldPosition(this.v);
    const depth = this.v.distanceTo(this.camera.position);
    this.v.project(this.camera);
    if (this.v.z > 1 || this.v.z < -1) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = ((this.v.x + 1) / 2) * rect.width;
    const y = ((1 - this.v.y) / 2) * rect.height;
    const fovScale = rect.height / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    return { x, y, depth, radius: (body.radius / Math.max(depth, 0.001)) * fovScale };
  }

  private frame() {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    const elapsed = this.timer.getElapsed();
    if (this.tween) {
      const tw = this.tween;
      tw.t = Math.min(1, tw.t + dt / tw.duration);
      const k = ease(tw.t);
      this.camera.position.lerpVectors(tw.fromPos, tw.toPos, k);
      this.controls.target.lerpVectors(tw.fromTarget, tw.toTarget, k);
      if (tw.t >= 1) {
        this.tween = null;
        tw.resolve();
      }
    }
    this.controls.update();
    this.view?.update(reducedMotion() ? 0 : dt, elapsed);
    this.composer.render();
    this.updateLabels();
  }

  private updateLabels() {
    if (!this.view) return;
    const wanted = new Map<string, Pickable>();
    for (const body of this.view.labeled()) wanted.set(body.id, body);
    for (const body of this.view.pickables()) if (this.highlighted.has(body.id)) wanted.set(body.id, body);
    for (const [id, element] of this.labels)
      if (!wanted.has(id)) {
        element.remove();
        this.labels.delete(id);
      }
    const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
    const rank = (body: Pickable) => (this.highlighted.has(body.id) ? 2 : body.heading ? 1 : 0);
    const ordered = [...wanted.values()].sort((a, b) => rank(b) - rank(a));
    for (const body of ordered) {
      const id = body.id;
      let element = this.labels.get(id);
      if (!element) {
        element = document.createElement('div');
        element.className = body.heading ? 'label label--heading' : 'label';
        element.textContent = body.label;
        this.labelLayer.append(element);
        this.labels.set(id, element);
      }
      const screen = this.project(body);
      if (!screen) {
        element.hidden = true;
        continue;
      }
      const top = body.heading ? screen.y - 10 : screen.y + Math.max(8, screen.radius) + 4;
      const half = (body.label.length * (body.heading ? 9.5 : 7.2)) / 2 + 4;
      const box = { x0: screen.x - half, x1: screen.x + half, y0: top, y1: top + (body.heading ? 20 : 14) };
      const hot = this.highlighted.has(id);
      if (!hot && placed.some((p) => box.x0 < p.x1 && box.x1 > p.x0 && box.y0 < p.y1 && box.y1 > p.y0)) {
        element.hidden = true;
        continue;
      }
      placed.push(box);
      element.hidden = false;
      element.classList.toggle('label--hot', hot);
      element.style.transform = `translate(${screen.x.toFixed(1)}px, ${top.toFixed(1)}px) translateX(-50%)`;
    }
  }

  private clearLabels() {
    for (const element of this.labels.values()) element.remove();
    this.labels.clear();
  }

  private resize() {
    const width = this.canvas.clientWidth || innerWidth;
    const height = this.canvas.clientHeight || innerHeight;
    this.renderer.setSize(width, height, false);
    this.composer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /** Distant background stars. Seeded, so the sky never changes. */
  private starfield() {
    const random = seeded('starmap-sky');
    const count = 4000;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const color = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const u = random() * 2 - 1;
      const theta = random() * Math.PI * 2;
      const r = 1800 + random() * 1800;
      const s = Math.sqrt(1 - u * u);
      positions.set([Math.cos(theta) * s * r, u * r, Math.sin(theta) * s * r], i * 3);
      color.setHSL(0.45 + random() * 0.2, 0.3, 0.55 + random() * 0.35);
      colors.set([color.r, color.g, color.b], i * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return new THREE.Points(
      geometry,
      new THREE.PointsMaterial({ size: 2.2, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.75 }),
    );
  }
}
