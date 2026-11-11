import type { GhRepo, GhUser } from '../github/types';
import { colorFor, UNKNOWN_COLOR } from './languages';
import { clamp, hashString, seeded } from './random';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A repository drawn as a star. */
export interface StarBody {
  id: string;
  repo: GhRepo;
  position: Vec3;
  /** Which constellation (index into Constellation.clusters). */
  cluster: number;
  /** Visual radius, from repository size. */
  radius: number;
  color: string;
  /** 0.1–1: how recently it was pushed (forks and archived repos dimmer). */
  brightness: number;
  /** 0–1: from stargazers. */
  glow: number;
}

/** A line between two stars of the same constellation. */
export interface StarLink {
  from: number;
  to: number;
  color: string;
}

/** All repos of one language: a named constellation floating in its own patch of sky. */
export interface Cluster {
  id: string;
  language: string | null;
  name: string;
  color: string;
  center: Vec3;
  /** Distance from the centre to the outermost star. */
  radius: number;
  /** Star indices, oldest repo first. */
  stars: number[];
}

export interface Constellation {
  user: GhUser;
  stars: StarBody[];
  links: StarLink[];
  /** Largest constellation first. */
  clusters: Cluster[];
  /** Language → number of repos, most common first. */
  languages: [string, number][];
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const PHI_INVERSE = (Math.sqrt(5) - 1) / 2;
const DAY = 86_400_000;

/** Fixed slots on a sphere around the user; each language hashes to one. */
export const SLOTS = 40;
/** Distance from the user (the core) to each constellation's centre. */
export const SHELL_RADIUS = 230;
/** Squash the sphere a little so it frames well on a wide screen. */
const VERTICAL_SQUASH = 0.7;
/** Spacing between stars inside a constellation. */
export const STAR_SPACING = 15;
const UNCHARTED = 'Uncharted';

export function recency(now: number, iso: string): number {
  const days = Math.max(0, (now - Date.parse(iso)) / DAY);
  return clamp(Math.exp(-days / 240), 0.18, 1);
}

export function starRadius(sizeKb: number): number {
  return 0.8 + Math.log10(Math.max(0, sizeKb) + 10) * 0.6;
}

/** Evenly spread point `slot` of SLOTS on the shell (Fibonacci sphere), skipping the poles. */
function slotCenter(slot: number): Vec3 {
  const y = 0.92 - (1.84 * (slot + 0.5)) / SLOTS;
  const ring = Math.sqrt(1 - y * y);
  const theta = slot * GOLDEN_ANGLE;
  return {
    x: Math.cos(theta) * ring * SHELL_RADIUS,
    y: y * SHELL_RADIUS * VERTICAL_SQUASH,
    z: Math.sin(theta) * ring * SHELL_RADIUS,
  };
}

/**
 * Offset of the i-th oldest star from its constellation's centre. The
 * sequence never depends on how many stars there are, so a new repo never
 * moves the existing ones. Radius grows with the cube root: even density in 3D.
 */
function starOffset(i: number, key: string): Vec3 {
  if (i === 0) return { x: 0, y: 0, z: 0 };
  const random = seeded(key);
  const y = 1 - 2 * ((i * PHI_INVERSE) % 1);
  const ring = Math.sqrt(1 - y * y);
  const theta = i * GOLDEN_ANGLE;
  const distance = STAR_SPACING * Math.cbrt(i) * (0.92 + random() * 0.16);
  return { x: Math.cos(theta) * ring * distance, y: y * distance, z: Math.sin(theta) * ring * distance };
}

/**
 * Group repos into one constellation per language and scatter the
 * constellations through 3D space around the user. Placement is stable: a
 * language always takes the same slot, and new repos only add outer stars.
 */
export function buildConstellation(user: GhUser, repos: GhRepo[], now = Date.now()): Constellation {
  const ordered = [...repos].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.full_name.localeCompare(b.full_name),
  );

  const groups = new Map<string, GhRepo[]>();
  for (const repo of ordered) {
    const key = repo.language ?? UNCHARTED;
    const list = groups.get(key) ?? [];
    list.push(repo);
    groups.set(key, list);
  }

  // Claim slots in name order so collisions resolve the same way every time.
  const taken = new Set<number>();
  const slotOf = new Map<string, number>();
  for (const key of [...groups.keys()].sort()) {
    let slot = hashString(key) % SLOTS;
    while (taken.has(slot) && taken.size < SLOTS) slot = (slot + 7) % SLOTS;
    taken.add(slot);
    slotOf.set(key, slot);
  }

  const stars: StarBody[] = [];
  const clusters: Cluster[] = [];
  const keys = [...groups.keys()].sort((a, b) => groups.get(b)!.length - groups.get(a)!.length || a.localeCompare(b));
  for (const key of keys) {
    const language = key === UNCHARTED ? null : key;
    const center = slotCenter(slotOf.get(key)!);
    const cluster: Cluster = {
      id: key,
      language,
      name: key,
      color: language ? colorFor(language) : UNKNOWN_COLOR,
      center,
      radius: 0,
      stars: [],
    };
    groups.get(key)!.forEach((repo, i) => {
      const offset = starOffset(i, repo.full_name.toLowerCase());
      let brightness = recency(now, repo.pushed_at);
      if (repo.fork) brightness *= 0.55;
      if (repo.archived) brightness *= 0.6;
      const radius = starRadius(repo.size);
      cluster.radius = Math.max(cluster.radius, Math.hypot(offset.x, offset.y, offset.z) + radius);
      cluster.stars.push(stars.length);
      stars.push({
        id: repo.full_name,
        repo,
        cluster: clusters.length,
        position: { x: center.x + offset.x, y: center.y + offset.y, z: center.z + offset.z },
        radius,
        color: cluster.color,
        brightness: clamp(brightness, 0.1, 1),
        glow: clamp(Math.log10(repo.stargazers_count + 1) / 3, 0, 1),
      });
    });
    clusters.push(cluster);
  }

  // Each star links to its nearest older star in the same constellation:
  // a tree of short hops that reads as a constellation drawing.
  const links: StarLink[] = [];
  const gap = (a: number, b: number) => {
    const p = stars[a]!.position;
    const q = stars[b]!.position;
    return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
  };
  for (const cluster of clusters) {
    const list = cluster.stars;
    for (let i = 1; i < list.length; i++) {
      let nearest = list[0]!;
      for (let j = 1; j < i; j++) if (gap(list[i]!, list[j]!) < gap(list[i]!, nearest)) nearest = list[j]!;
      links.push({ from: nearest, to: list[i]!, color: cluster.color });
    }
  }

  const languages = clusters
    .filter((c) => c.language)
    .map((c): [string, number] => [c.language!, c.stars.length]);

  return { user, stars, links, clusters, languages };
}
