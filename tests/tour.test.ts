import { describe, expect, it } from 'vitest';
import { buildConstellation } from '../src/galaxy/constellation';
import { starFact, tourSteps } from '../src/tour';
import { repo, user } from './fixtures';

const NOW = Date.parse('2026-11-10T00:00:00Z');
const c = buildConstellation(
  user,
  [
    repo('seed', { created_at: '2018-01-01T00:00:00Z', pushed_at: '2019-01-01T00:00:00Z' }),
    repo('famous', { created_at: '2019-01-01T00:00:00Z', stargazers_count: 900, pushed_at: '2020-01-01T00:00:00Z' }),
    repo('busy', { created_at: '2020-01-01T00:00:00Z', stargazers_count: 0, pushed_at: '2026-11-09T00:00:00Z' }),
    repo('fresh', { created_at: '2026-10-01T00:00:00Z', stargazers_count: 0, pushed_at: '2026-10-02T00:00:00Z' }),
    repo('lonely', { language: 'Rust' }),
  ],
  NOW,
);

describe('tourSteps', () => {
  it('visits each constellation, then its stars oldest first', () => {
    expect(tourSteps(c).map((s) => (s.kind === 'cluster' ? `[${s.cluster.name}]` : s.star.repo.name))).toEqual([
      '[TypeScript]', 'seed', 'famous', 'busy', 'fresh', '[Rust]', 'lonely',
    ]);
  });
});

describe('starFact', () => {
  const facts = Object.fromEntries(
    tourSteps(c).flatMap((s) => (s.kind === 'star' ? [[s.star.repo.name, starFact(c, s)]] : [])),
  );
  it('finds something to say', () => {
    expect(facts.seed).toMatch(/first TypeScript repo/);
    expect(facts.famous).toMatch(/most-starred/);
    expect(facts.busy).toMatch(/most recently active/);
    expect(facts.fresh).toMatch(/newest arrival/);
    expect(facts.lonely).toMatch(/only Rust repo/);
  });
});
