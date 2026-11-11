import type { GhRepo, GhUser } from '../github/types';
import { colorFor } from './languages';
import { clamp, seeded } from './random';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A repository drawn as a star in the user's constellation. */
export interface StarBody {
  id: string;
  repo: GhRepo;
  position: Vec3;
  /** Visual radius, from repository size. */
  radius: number;
  color: string;
  /** 0.18–1: how recently it was pushed (forks and archived repos dimmer). */
  brightness: number;
  /** 0–1: from stargazers. */
  glow: number;
}

/** A faint line between two stars of the same language, in creation order. */
export interface StarLink {
  from: number;
  to: number;
  color: string;
}

export interface Constellation {
  user: GhUser;
  stars: StarBody[];
  links: StarLink[];
  /** Language → number of repos, most common first. */
  languages: [string, number][];
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const DAY = 86_400_000;

export function recency(now: number, iso: string): number {
  const days = Math.max(0, (now - Date.parse(iso)) / DAY);
  return clamp(Math.exp(-days / 240), 0.18, 1);
}

export function starRadius(sizeKb: number): number {
  return 0.9 + Math.log10(Math.max(0, sizeKb) + 10) * 0.75;
}

/**
 * Lay repos out as a spiral galaxy: the oldest repo sits at the core and each
 * newer one lands further out, so the constellation grows outward over time
 * and existing stars never move when a new repo appears.
 */
export function buildConstellation(user: GhUser, repos: GhRepo[], now = Date.now()): Constellation {
  const ordered = [...repos].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.full_name.localeCompare(b.full_name),
  );
  const stars = ordered.map((repo, i): StarBody => {
    const random = seeded(repo.full_name.toLowerCase());
    const distance = 16 + 13 * Math.sqrt(i) + random() * 5;
    const angle = i * GOLDEN_ANGLE + (random() - 0.5) * 0.35;
    const thickness = 4 + Math.min(10, distance * 0.08);
    let brightness = recency(now, repo.pushed_at);
    if (repo.fork) brightness *= 0.55;
    if (repo.archived) brightness *= 0.6;
    return {
      id: repo.full_name,
      repo,
      position: {
        x: Math.cos(angle) * distance,
        y: (random() - 0.5) * thickness,
        z: Math.sin(angle) * distance,
      },
      radius: starRadius(repo.size),
      color: colorFor(repo.language),
      brightness: clamp(brightness, 0.1, 1),
      glow: clamp(Math.log10(repo.stargazers_count + 1) / 3, 0, 1),
    };
  });

  const byLanguage = new Map<string, number[]>();
  stars.forEach((star, index) => {
    const language = star.repo.language;
    if (!language) return;
    const list = byLanguage.get(language) ?? [];
    list.push(index);
    byLanguage.set(language, list);
  });
  // Each star links to its nearest older star of the same language. That makes
  // a tree of short hops (local clusters) instead of lines across the galaxy.
  const links: StarLink[] = [];
  const gap = (a: number, b: number) => {
    const p = stars[a]!.position;
    const q = stars[b]!.position;
    return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
  };
  for (const [language, indices] of byLanguage)
    for (let i = 1; i < indices.length; i++) {
      let nearest = indices[0]!;
      for (let j = 1; j < i; j++) if (gap(indices[i]!, indices[j]!) < gap(indices[i]!, nearest)) nearest = indices[j]!;
      links.push({ from: nearest, to: indices[i]!, color: colorFor(language) });
    }

  const languages = [...byLanguage.entries()]
    .map(([language, list]): [string, number] => [language, list.length])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  return { user, stars, links, languages };
}
