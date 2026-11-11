import { describe, expect, it } from 'vitest';
import { buildConstellation, recency } from '../src/galaxy/constellation';
import { languageForPath } from '../src/galaxy/languages';
import { MAX_PLANETS, MAX_MOONS_PER_PLANET, buildSystem } from '../src/galaxy/system';
import { repo, tree, user } from './fixtures';

const NOW = Date.parse('2026-11-10T00:00:00Z');

describe('buildConstellation', () => {
  const repos = [
    repo('old', { created_at: '2016-01-01T00:00:00Z', pushed_at: '2018-01-01T00:00:00Z' }),
    repo('new', { created_at: '2026-01-01T00:00:00Z', language: 'Rust' }),
    repo('mid', { created_at: '2021-01-01T00:00:00Z', fork: true }),
    repo('mid2', { created_at: '2022-01-01T00:00:00Z' }),
  ];

  it('is deterministic and independent of input order', () => {
    const a = buildConstellation(user, repos, NOW);
    const b = buildConstellation(user, [...repos].reverse(), NOW);
    expect(a.stars.map((s) => s.position)).toEqual(b.stars.map((s) => s.position));
  });

  it('puts the oldest repo at the centre of its constellation', () => {
    const c = buildConstellation(user, repos, NOW);
    const ts = c.clusters.find((cl) => cl.language === 'TypeScript')!;
    expect(c.stars[ts.stars[0]!]!.repo.name).toBe('old');
    expect(c.stars[ts.stars[0]!]!.position).toEqual(ts.center);
  });

  it('groups one constellation per language, largest first', () => {
    const c = buildConstellation(user, [...repos, repo('docs', { language: null })], NOW);
    expect(c.clusters.map((cl) => [cl.name, cl.stars.length])).toEqual([
      ['TypeScript', 3],
      ['Rust', 1],
      ['Uncharted', 1],
    ]);
    expect(c.stars.every((s) => c.clusters[s.cluster]!.stars.includes(c.stars.indexOf(s)))).toBe(true);
  });

  it('spreads constellations through 3D space without overlapping', () => {
    const many = ['TypeScript', 'Python', 'Rust', 'Go', 'C#', 'Java', 'Lua', 'Swift', 'C++', 'HTML'].flatMap((language, l) =>
      Array.from({ length: 12 }, (_, i) =>
        repo(`${language}-${i}`, { language, created_at: `20${10 + l}-01-${String(i + 1).padStart(2, '0')}T00:00:00Z` }),
      ),
    );
    const { clusters, stars } = buildConstellation(user, many, NOW);
    for (let a = 0; a < clusters.length; a++)
      for (let b = a + 1; b < clusters.length; b++) {
        const p = clusters[a]!.center;
        const q = clusters[b]!.center;
        expect(Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z)).toBeGreaterThan(clusters[a]!.radius + clusters[b]!.radius);
      }
    const ys = stars.map((s) => s.position.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(100);
  });

  it('keeps existing stars in place when a new repo appears', () => {
    const before = buildConstellation(user, repos, NOW);
    const after = buildConstellation(user, [...repos, repo('newest', { created_at: '2026-10-01T00:00:00Z' })], NOW);
    for (const star of before.stars)
      expect(after.stars.find((s) => s.id === star.id)!.position).toEqual(star.position);
  });

  it('dims stale repos and forks', () => {
    const { stars } = buildConstellation(user, repos, NOW);
    const byName = Object.fromEntries(stars.map((s) => [s.repo.name, s]));
    expect(byName.old!.brightness).toBeLessThan(byName.new!.brightness);
    expect(byName.mid!.brightness).toBeLessThan(byName.mid2!.brightness);
  });

  it('links stars within their constellation and counts languages', () => {
    const c = buildConstellation(user, repos, NOW);
    expect(c.links).toHaveLength(2); // TypeScript: old, mid, mid2; Rust alone
    expect(c.links.every((l) => c.stars[l.from]!.cluster === c.stars[l.to]!.cluster)).toBe(true);
    expect(c.languages[0]).toEqual(['TypeScript', 3]);
  });

  it('clamps recency', () => {
    expect(recency(NOW, '2000-01-01T00:00:00Z')).toBe(0.18);
    expect(recency(NOW, '2030-01-01T00:00:00Z')).toBe(1);
  });
});

describe('buildSystem', () => {
  const r = repo('app');
  const t = tree([
    ['README.md', 2000],
    ['package.json', 800],
    ['src/main.ts', 4000],
    ['src/scene/stage.ts', 9000],
    ['src/scene/view.ts', 3000],
    ['tests/a.test.ts', 1000],
    ['docs/guide.md', 500],
  ]);

  it('makes planets of top-level directories and a belt of root files', () => {
    const s = buildSystem(r, t);
    expect(s.planets.map((p) => p.id)).toEqual(['src', 'tests', 'docs']);
    expect(s.belt.map((m) => m.path).sort()).toEqual(['README.md', 'package.json']);
    expect(s.totalFiles).toBe(7);
  });

  it('measures planets and finds their language and sub-folders', () => {
    const src = buildSystem(r, t).planets[0]!;
    expect(src.bytes).toBe(16000);
    expect(src.fileCount).toBe(3);
    expect(src.language).toBe('TypeScript');
    expect(src.subdirs).toEqual([{ name: 'scene', fileCount: 2 }]);
    expect(buildSystem(r, t).planets[2]!.language).toBeNull(); // docs: prose only
  });

  it('gives each planet its own orbit, moving outward', () => {
    const orbits = buildSystem(r, t).planets.map((p) => p.orbitRadius);
    expect([...orbits].sort((a, b) => a - b)).toEqual(orbits);
    expect(new Set(orbits).size).toBe(orbits.length);
  });

  it('is deterministic', () => {
    expect(buildSystem(r, t)).toEqual(buildSystem(r, t));
  });

  it('merges overflow directories and caps moons', () => {
    const many: [string, number][] = Array.from({ length: MAX_PLANETS + 5 }, (_, i) => [`d${i}/f.ts`, 100 + i]);
    const big: [string, number][] = Array.from({ length: MAX_MOONS_PER_PLANET + 20 }, (_, i) => [`huge/f${i}.ts`, 1e6]);
    const s = buildSystem(r, tree([...many, ...big], true));
    expect(s.planets).toHaveLength(MAX_PLANETS);
    expect(s.planets.at(-1)!.name).toBe('…other');
    expect(s.mergedDirectories).toBe(7); // 46 folders, 39 kept + …other
    expect(s.hiddenMoons).toBe(20);
    expect(s.truncated).toBe(true);
  });
});

describe('languageForPath', () => {
  it('maps extensions and special names', () => {
    expect(languageForPath('src/a.tsx')).toBe('TypeScript');
    expect(languageForPath('Dockerfile')).toBe('Dockerfile');
    expect(languageForPath('.gitignore')).toBeNull();
    expect(languageForPath('Makefile')).toBeNull();
  });
});
