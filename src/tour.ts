import * as THREE from 'three';
import type { Cluster, Constellation, StarBody } from './galaxy/constellation';
import type { ConstellationView } from './scene/constellation-view';
import type { Stage } from './scene/stage';
import { compact, el, extLink, formatBytes, formatNumber, timeAgo } from './ui/dom';

export type StarStep = {
  kind: 'star';
  star: StarBody;
  starIndex: number;
  cluster: Cluster;
  clusterIndex: number;
  /** Position in the tour of this constellation, 0 = top repo. */
  rank: number;
  /** How many of this constellation's stars the tour visits. */
  shown: number;
};
export type TourStep = { kind: 'cluster'; cluster: Cluster; clusterIndex: number } | StarStep;

/** How many repos the tour visits per constellation. */
export const TOUR_PER_CONSTELLATION = 10;

/** Most stars first, then most recently active, then largest. */
export function starScore(star: StarBody): number {
  return star.glow * 3 + star.brightness * 1.5 + Math.log10(star.repo.size + 1) * 0.2;
}

/** Every constellation (largest first), then its top repos, best first. */
export function tourSteps(constellation: Constellation, perConstellation = TOUR_PER_CONSTELLATION): TourStep[] {
  const steps: TourStep[] = [];
  constellation.clusters.forEach((cluster, clusterIndex) => {
    steps.push({ kind: 'cluster', cluster, clusterIndex });
    const top = [...cluster.stars]
      .sort((a, b) => {
        const sa = constellation.stars[a]!;
        const sb = constellation.stars[b]!;
        return starScore(sb) - starScore(sa) || sa.repo.name.localeCompare(sb.repo.name);
      })
      .slice(0, perConstellation);
    top.forEach((starIndex, rank) =>
      steps.push({
        kind: 'star',
        star: constellation.stars[starIndex]!,
        starIndex,
        cluster,
        clusterIndex,
        rank,
        shown: top.length,
      }),
    );
  });
  return steps;
}

/** One-line trivia for a star, relative to its whole constellation. */
export function starFact(constellation: Constellation, step: StarStep): string | null {
  const { cluster, starIndex, star } = step;
  const members = cluster.stars.map((i) => constellation.stars[i]!.repo);
  const name = cluster.language ?? 'language-less';
  if (members.length === 1) return `The only ${name} repo in the sky.`;
  if (starIndex === cluster.stars[0]) return `The first ${name} repo: the seed this constellation grew from.`;
  const mostStars = Math.max(...members.map((r) => r.stargazers_count));
  if (star.repo.stargazers_count > 0 && star.repo.stargazers_count === mostStars)
    return `The most-starred ${name} repo.`;
  const latestPush = members.map((r) => r.pushed_at).sort().at(-1);
  if (star.repo.pushed_at === latestPush) return `The most recently active ${name} repo.`;
  if (starIndex === cluster.stars.at(-1)) return `The newest arrival in this constellation.`;
  const largest = Math.max(...members.map((r) => r.size));
  if (star.repo.size === largest) return `The largest ${name} repo.`;
  return null;
}

/** Auto-advance choices in milliseconds; 0 means manual. */
export const ADVANCE_CHOICES = [0, 5000, 10000, 20000] as const;
const ADVANCE_KEY = 'starmap.tourAdvance';
const DEFAULT_ADVANCE = 10000;

function loadAdvance(): number {
  try {
    const saved = Number(localStorage.getItem(ADVANCE_KEY));
    return (ADVANCE_CHOICES as readonly number[]).includes(saved) && localStorage.getItem(ADVANCE_KEY) !== null
      ? saved
      : DEFAULT_ADVANCE;
  } catch {
    return DEFAULT_ADVANCE;
  }
}

const up = new THREE.Vector3(0, 1, 0);

interface TourHooks {
  enter(star: StarBody): void;
  ended(): void;
}

/** Flies the camera from constellation to constellation, star to star, with an info card. */
export class Tour {
  private readonly steps: TourStep[];
  private index = -1;
  /** Auto-advance delay in ms; 0 = the visitor presses Next. */
  private advance = loadAdvance();
  private timer: number | null = null;
  private flight = 0;
  private readonly home: { position: THREE.Vector3; target: THREE.Vector3 };
  active = false;

  constructor(
    private readonly stage: Stage,
    private readonly view: ConstellationView,
    private readonly constellation: Constellation,
    private readonly card: HTMLElement,
    private readonly hooks: TourHooks,
  ) {
    this.steps = tourSteps(constellation);
    this.home = { position: stage.camera.position.clone(), target: stage.controls.target.clone() };
  }

  start() {
    if (!this.steps.length) return;
    this.active = true;
    this.view.setSpinning(false);
    this.card.hidden = false;
    void this.go(0);
  }

  /** End the tour; optionally fly back to where it started. */
  stop(returnHome = true) {
    if (!this.active) return;
    this.active = false;
    this.clearTimer();
    this.flight++;
    this.card.hidden = true;
    this.view.setSpinning(true);
    this.view.setFocus(null);
    this.view.setMarker(null);
    this.stage.highlight([]);
    if (returnHome) void this.stage.flyTo(this.home.position, this.home.target, 1.6);
    this.hooks.ended();
  }

  next() {
    if (this.index >= this.steps.length - 1) return this.stop();
    void this.go(this.index + 1);
  }

  prev() {
    void this.go(Math.max(0, this.index - 1));
  }

  skipConstellation() {
    const current = this.steps[this.index]!.clusterIndex;
    const next = this.steps.findIndex((s, i) => i > this.index && s.kind === 'cluster' && s.clusterIndex !== current);
    if (next < 0) return this.stop();
    void this.go(next);
  }

  setAdvance(ms: number) {
    this.advance = ms;
    try {
      localStorage.setItem(ADVANCE_KEY, String(ms));
    } catch {
      /* remembered for this visit only */
    }
    this.schedule();
  }

  private async go(index: number) {
    this.clearTimer();
    this.arrived = false;
    this.index = index;
    const flight = ++this.flight;
    const step = this.steps[index]!;
    this.view.setFocus(step.clusterIndex);
    this.render();
    const direction = this.viewDirection(step.cluster);
    if (step.kind === 'cluster') {
      const center = this.view.clusterCenter(step.cluster);
      const distance = step.cluster.radius * 2.4 + 40;
      const target = this.raise(center, distance);
      this.view.setMarker(null);
      this.stage.highlight([`cluster:${step.cluster.id}`]);
      await this.stage.flyTo(target.clone().addScaledVector(direction, distance), target, 2.2);
    } else {
      const body = this.view.star(step.starIndex);
      const at = this.stage.positionOf(body);
      // Stand back far enough to be outside the constellation, so its other
      // stars never sit between the camera and the one being shown.
      const distance = step.cluster.radius * 1.5 + 34 + step.star.radius * 3;
      const target = this.raise(at, distance);
      this.view.setMarker(step.starIndex);
      this.stage.highlight([body.id]);
      await this.stage.flyTo(target.clone().addScaledVector(direction, distance), target, step.rank === 0 ? 1.8 : 1.4);
    }
    if (flight === this.flight && this.active) {
      this.arrived = true;
      this.schedule();
    }
  }

  /**
   * Look at a constellation from the side and a little above, never straight
   * down the line to the centre of the sky, so other constellations stay out of the shot.
   */
  private viewDirection(cluster: Cluster) {
    const outward = this.view.clusterCenter(cluster).normalize();
    return outward.applyAxisAngle(up, 0.95).add(new THREE.Vector3(0, 0.38, 0)).normalize();
  }

  /** Aim a little below the subject so it sits above the info card. */
  private raise(point: THREE.Vector3, distance: number) {
    return point.clone().addScaledVector(up, -distance * 0.14);
  }

  private arrived = false;

  private schedule() {
    this.clearTimer();
    const bar = this.card.querySelector<HTMLElement>('.tour-timer');
    if (bar) bar.style.animation = 'none';
    if (!this.advance || !this.active || !this.arrived) return;
    this.timer = window.setTimeout(() => this.next(), this.advance);
    if (bar) {
      void bar.offsetWidth; // restart the countdown animation
      bar.style.animation = `tour-timer ${this.advance}ms linear forwards`;
    }
  }

  private clearTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private render() {
    const step = this.steps[this.index];
    if (!step) return;
    const clusters = this.constellation.clusters.length;
    const kicker =
      step.kind === 'cluster'
        ? `Constellation ${step.clusterIndex + 1} of ${clusters}`
        : `${step.cluster.name} · top ${step.rank + 1} of ${step.shown}${step.cluster.stars.length > step.shown ? ` (${step.cluster.stars.length} total)` : ''}`;
    const button = (label: string, title: string, action: () => void, extra = '') =>
      el('button', { type: 'button', class: `tour-btn ${extra}`.trim(), title, 'aria-label': title, on: { click: action } }, label);

    const auto = el(
      'select',
      { class: 'tour-auto', 'aria-label': 'Auto-advance', title: 'When to move to the next stop' },
      ...ADVANCE_CHOICES.map((ms) =>
        el('option', { value: ms, selected: ms === this.advance }, ms ? `Auto ${ms / 1000}s` : 'Manual'),
      ),
    );
    auto.addEventListener('change', () => this.setAdvance(Number(auto.value)));

    this.card.replaceChildren(
      el('div', { class: 'tour-progress', style: `--p:${((this.index + 1) / this.steps.length) * 100}%` }),
      el('div', { class: 'tour-timer' }),
      el('p', { class: 'tour-kicker' }, el('span', { class: 'swatch', style: `background:${step.cluster.color}` }), kicker),
      ...(step.kind === 'cluster' ? this.clusterBody(step.cluster) : this.starBody(step)),
      el(
        'div',
        { class: 'tour-controls' },
        button('⏮', 'Previous (←)', () => this.prev()),
        button('Next ⏭', 'Next (→ or Space)', () => this.next(), 'tour-btn--main'),
        auto,
        clusters > 1 ? button('Skip constellation', 'Skip to the next constellation', () => this.skipConstellation(), 'tour-btn--text') : null,
        step.kind === 'star'
          ? button('Fly in →', 'Fly into this star system', () => {
              this.stop(false);
              this.hooks.enter(step.star);
            }, 'tour-btn--text tour-btn--accent')
          : null,
        button('✕', 'End tour (Esc)', () => this.stop(), 'tour-btn--end'),
      ),
    );
  }

  private clusterBody(cluster: Cluster): Node[] {
    const repos = cluster.stars.map((i) => this.constellation.stars[i]!.repo);
    const stars = repos.reduce((sum, r) => sum + r.stargazers_count, 0);
    const first = repos[0]!;
    const latest = repos.map((r) => r.pushed_at).sort().at(-1)!;
    return compact([
      el('h2', {}, cluster.language ? `${cluster.name}` : 'Uncharted'),
      el(
        'p',
        { class: 'tour-text' },
        cluster.language
          ? `${repos.length} ${cluster.name} repo${repos.length === 1 ? '' : 's'}, starting with ${first.name} ${timeAgo(first.created_at)}.`
          : `${repos.length} repo${repos.length === 1 ? '' : 's'} without a main language: docs, configs and experiments.`,
      ),
      el(
        'div',
        { class: 'chips' },
        el('span', { class: 'chip' }, `${repos.length} star${repos.length === 1 ? '' : 's'}`),
        el('span', { class: 'chip' }, `★ ${formatNumber(stars)}`),
        el('span', { class: 'chip' }, `active ${timeAgo(latest)}`),
      ),
    ]);
  }

  private starBody(step: Extract<TourStep, { kind: 'star' }>): Node[] {
    const r = step.star.repo;
    const fact = starFact(this.constellation, step);
    return compact([
      el('h2', {}, r.name),
      el('p', { class: 'tour-text' }, r.description ?? 'No description yet.'),
      fact ? el('p', { class: 'tour-fact' }, `✦ ${fact}`) : null,
      el(
        'div',
        { class: 'chips' },
        el('span', { class: 'chip' }, `★ ${formatNumber(r.stargazers_count)}`),
        el('span', { class: 'chip' }, `⑂ ${formatNumber(r.forks_count)}`),
        el('span', { class: 'chip' }, formatBytes(r.size * 1024)),
        el('span', { class: 'chip' }, `born ${timeAgo(r.created_at)}`),
        el('span', { class: 'chip' }, `pushed ${timeAgo(r.pushed_at)}`),
        r.fork ? el('span', { class: 'chip chip--muted' }, 'fork') : null,
        r.archived ? el('span', { class: 'chip chip--muted' }, 'archived') : null,
      ),
      extLink(r.html_url, 'Open on GitHub ↗'),
    ]);
  }
}
