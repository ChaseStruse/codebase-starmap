import { describe, expect, it } from 'vitest';
import { buildConstellation } from '../src/galaxy/constellation';
import { hasRings, planetKind, starKind } from '../src/galaxy/kinds';
import { repo, user } from './fixtures';

const NOW = Date.parse('2026-11-10T00:00:00Z');
const OLD = '2024-01-01T00:00:00Z';

function kindOf(extra: Parameters<typeof repo>[1]) {
  const star = buildConstellation(user, [repo('x', { pushed_at: OLD, stargazers_count: 0, ...extra })], NOW).stars[0]!;
  return starKind(star, NOW);
}

describe('starKind', () => {
  it('maps repo traits to shapes, first rule wins', () => {
    expect(kindOf({ archived: true, fork: true, stargazers_count: 50 })).toBe('remnant');
    expect(kindOf({ fork: true, stargazers_count: 50 })).toBe('binary');
    expect(kindOf({ stargazers_count: 5, size: 9000 })).toBe('pulsar');
    expect(kindOf({ size: 9000, pushed_at: '2026-11-09T00:00:00Z' })).toBe('giant');
    expect(kindOf({ pushed_at: '2026-11-01T00:00:00Z', size: 10 })).toBe('active');
    expect(kindOf({ size: 10 })).toBe('asteroid');
    expect(kindOf({ size: 1200 })).toBe('star');
  });
});

describe('planetKind', () => {
  it('spots CI, tests, big folders and the rest', () => {
    expect(planetKind({ name: '.github', bytes: 10 })).toBe('station');
    expect(planetKind({ name: 'tests', bytes: 9e6 })).toBe('ice');
    expect(planetKind({ name: '__tests__', bytes: 10 })).toBe('ice');
    expect(planetKind({ name: 'src', bytes: 600_000 })).toBe('gas');
    expect(planetKind({ name: 'docs', bytes: 2000 })).toBe('rocky');
  });

  it('rings only gas giants with several sub-folders', () => {
    const subdirs = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `d${i}`, fileCount: 1 }));
    expect(hasRings({ name: 'src', bytes: 600_000, subdirs: subdirs(3) })).toBe(true);
    expect(hasRings({ name: 'src', bytes: 600_000, subdirs: subdirs(2) })).toBe(false);
    expect(hasRings({ name: 'lib', bytes: 2000, subdirs: subdirs(5) })).toBe(false);
  });
});
