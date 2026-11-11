/**
 * What each body looks like. Shapes carry meaning: a fork is a binary pair,
 * a starred repo is a pulsar, a CI folder is a space station.
 */
import type { StarBody } from './constellation';
import type { PlanetBody } from './system';

export type StarKind = 'remnant' | 'binary' | 'pulsar' | 'giant' | 'active' | 'asteroid' | 'star';
export type PlanetKind = 'station' | 'ice' | 'gas' | 'rocky';

const DAY = 86_400_000;
export const PULSAR_STARS = 5;
/** Repo size in KB (the API reports kilobytes). */
export const GIANT_KB = 5000;
export const ASTEROID_KB = 40;
export const ACTIVE_DAYS = 30;

export const STAR_KINDS: Record<StarKind, { label: string; meaning: string }> = {
  remnant: { label: 'Remnant', meaning: 'Archived: a cooled crystal that no longer burns.' },
  binary: { label: 'Binary star', meaning: 'A fork: two stars orbiting each other.' },
  pulsar: { label: 'Pulsar', meaning: `${PULSAR_STARS}+ stargazers: it sweeps beams across the sky.` },
  giant: { label: 'Ringed giant', meaning: 'A big repo (5 MB+), wearing rings.' },
  active: { label: 'Active star', meaning: `Pushed in the last ${ACTIVE_DAYS} days: its surface boils.` },
  asteroid: { label: 'Asteroid', meaning: 'A tiny repo, tumbling through space.' },
  star: { label: 'Star', meaning: 'A steady, quietly glowing repo.' },
};

export const PLANET_KINDS: Record<PlanetKind, { label: string; meaning: string }> = {
  station: { label: 'Space station', meaning: 'CI and repo automation.' },
  ice: { label: 'Ice world', meaning: 'Tests.' },
  gas: { label: 'Gas giant', meaning: 'A big folder (500 KB+). Rings mean several sub-folders.' },
  rocky: { label: 'Rocky planet', meaning: 'A smaller folder.' },
};

export function starKind(star: StarBody, now = Date.now()): StarKind {
  const repo = star.repo;
  if (repo.archived) return 'remnant';
  if (repo.fork) return 'binary';
  if (repo.stargazers_count >= PULSAR_STARS) return 'pulsar';
  if (repo.size >= GIANT_KB) return 'giant';
  if (now - Date.parse(repo.pushed_at) <= ACTIVE_DAYS * DAY) return 'active';
  if (repo.size < ASTEROID_KB) return 'asteroid';
  return 'star';
}

const STATION = /^(\.github|\.circleci|\.gitlab|\.buildkite|\.ci|ci|\.husky|\.devcontainer)$/i;
const ICE = /^(tests?|specs?|__tests__|e2e|testing|cypress|playwright)$/i;
export const GAS_BYTES = 500_000;

export function planetKind(planet: Pick<PlanetBody, 'name' | 'bytes'>): PlanetKind {
  if (STATION.test(planet.name)) return 'station';
  if (ICE.test(planet.name)) return 'ice';
  if (planet.bytes >= GAS_BYTES) return 'gas';
  return 'rocky';
}

/** Gas giants with several sub-folders get rings. */
export const hasRings = (planet: Pick<PlanetBody, 'name' | 'bytes' | 'subdirs'>) =>
  planetKind(planet) === 'gas' && planet.subdirs.length >= 3;
