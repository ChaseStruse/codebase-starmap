import type { GhRepo, GhTree, GhTreeEntry } from '../github/types';
import type { Vec3 } from './constellation';
import { colorFor, isCodeLanguage, languageForPath } from './languages';
import { clamp, hashString, seeded } from './random';

/** A file, drawn as a moon around its directory's planet. */
export interface MoonBody {
  path: string;
  size: number;
  language: string | null;
  color: string;
  /** Offset from the planet centre. */
  offset: Vec3;
  radius: number;
}

/** A top-level directory, drawn as a planet orbiting the repo's star. */
export interface PlanetBody {
  id: string;
  name: string;
  bytes: number;
  fileCount: number;
  language: string | null;
  color: string;
  radius: number;
  orbitRadius: number;
  /** Starting angle on the orbit, radians. */
  angle: number;
  /** Orbit plane tilt, radians. */
  tilt: number;
  /** Angular speed, radians per second. */
  speed: number;
  /** Largest sub-directories, for the details panel. */
  subdirs: { name: string; fileCount: number }[];
  /** Every file under the planet (moons may be capped; this is not). */
  files: GhTreeEntry[];
  moons: MoonBody[];
}

export interface SystemModel {
  repo: GhRepo;
  starRadius: number;
  starColor: string;
  planets: PlanetBody[];
  /** Files at the repository root: an asteroid belt close to the star. */
  belt: MoonBody[];
  beltRadius: number;
  totalFiles: number;
  /** Files not drawn because of the per-planet moon cap. */
  hiddenMoons: number;
  /** GitHub cut the tree short (very large repos). */
  truncated: boolean;
  /** Directories merged into the "other" planet. */
  mergedDirectories: number;
}

export const MAX_PLANETS = 40;
export const MAX_MOONS_PER_PLANET = 500;
const OTHER = '…other';

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export const planetRadius = (bytes: number) => 0.7 + Math.log10(bytes + 1) * 0.32;
export const moonRadius = (bytes: number) => clamp(0.09 + Math.log10(bytes + 1) * 0.05, 0.09, 0.42);

/** Points on concentric shells around a planet, golden-spiral spaced. */
function moonOffsets(count: number, planet: number, key: string): Vec3[] {
  const random = seeded(key);
  const perShell = 64;
  const offsets: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    const shell = Math.floor(i / perShell);
    const inShell = Math.min(perShell, count - shell * perShell);
    const k = i % perShell;
    const y = 1 - (2 * (k + 0.5)) / inShell;
    const ring = Math.sqrt(1 - y * y);
    const theta = k * GOLDEN_ANGLE + shell * 0.9 + random() * 0.2;
    const r = planet * 1.9 + shell * 0.55 + random() * 0.25;
    offsets.push({ x: Math.cos(theta) * ring * r, y: y * r * 0.75, z: Math.sin(theta) * ring * r });
  }
  return offsets;
}

function moonsFor(files: GhTreeEntry[], planet: number, key: string): MoonBody[] {
  const drawn = [...files]
    .sort((a, b) => (b.size ?? 0) - (a.size ?? 0) || a.path.localeCompare(b.path))
    .slice(0, MAX_MOONS_PER_PLANET);
  const offsets = moonOffsets(drawn.length, planet, key);
  return drawn.map((file, i) => {
    const language = languageForPath(file.path);
    return {
      path: file.path,
      size: file.size ?? 0,
      language,
      color: colorFor(language),
      offset: offsets[i]!,
      radius: moonRadius(file.size ?? 0),
    };
  });
}

function dominantLanguage(files: GhTreeEntry[]): string | null {
  const bytes = new Map<string, number>();
  for (const file of files) {
    const language = languageForPath(file.path);
    if (!isCodeLanguage(language)) continue;
    bytes.set(language!, (bytes.get(language!) ?? 0) + (file.size ?? 0) + 1);
  }
  let best: string | null = null;
  let max = 0;
  for (const [language, total] of bytes)
    if (total > max || (total === max && best !== null && language < best)) {
      best = language;
      max = total;
    }
  return best;
}

/** Turn a recursive git tree into a planetary system. Pure and deterministic. */
export function buildSystem(repo: GhRepo, tree: GhTree): SystemModel {
  const blobs = tree.tree.filter((entry) => entry.type === 'blob');
  const rootFiles: GhTreeEntry[] = [];
  const groups = new Map<string, GhTreeEntry[]>();
  for (const blob of blobs) {
    const slash = blob.path.indexOf('/');
    if (slash < 0) {
      rootFiles.push(blob);
      continue;
    }
    const top = blob.path.slice(0, slash);
    const list = groups.get(top) ?? [];
    list.push(blob);
    groups.set(top, list);
  }

  let directories = [...groups.entries()]
    .map(([name, files]) => ({ name, files, bytes: files.reduce((sum, f) => sum + (f.size ?? 0), 0) }))
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  let mergedDirectories = 0;
  if (directories.length > MAX_PLANETS) {
    const kept = directories.slice(0, MAX_PLANETS - 1);
    const rest = directories.slice(MAX_PLANETS - 1);
    mergedDirectories = rest.length;
    const files = rest.flatMap((d) => d.files);
    directories = [...kept, { name: OTHER, files, bytes: files.reduce((s, f) => s + (f.size ?? 0), 0) }];
  }

  const starRadius = 2.6 + Math.log10(repo.size + 10) * 0.55;
  const beltRadius = starRadius * 2.2;
  let orbit = beltRadius + 4;
  let hiddenMoons = 0;

  const planets = directories.map(({ name, files, bytes }): PlanetBody => {
    const radius = planetRadius(bytes);
    const moons = moonsFor(files, radius, `${repo.full_name}/${name}`);
    hiddenMoons += files.length - moons.length;
    const shells = Math.ceil(moons.length / 64);
    const extent = radius * 1.9 + shells * 0.55 + 0.6;
    orbit += extent;
    const orbitRadius = orbit;
    orbit += extent + 1.2;
    const random = seeded(`${repo.full_name}:${name}`);
    const subdirs = new Map<string, number>();
    for (const file of files) {
      const parts = file.path.split('/');
      if (parts.length > 2) subdirs.set(parts[1]!, (subdirs.get(parts[1]!) ?? 0) + 1);
    }
    const language = dominantLanguage(files);
    return {
      id: name,
      name,
      bytes,
      fileCount: files.length,
      language,
      color: colorFor(language),
      radius,
      orbitRadius,
      angle: (hashString(name) / 4294967296) * Math.PI * 2,
      tilt: (random() - 0.5) * 0.18,
      speed: 2.2 / Math.pow(orbitRadius, 1.5),
      subdirs: [...subdirs.entries()]
        .map(([n, fileCount]) => ({ name: n, fileCount }))
        .sort((a, b) => b.fileCount - a.fileCount || a.name.localeCompare(b.name))
        .slice(0, 8),
      files,
      moons,
    };
  });

  const belt = rootFiles.map((file, i): MoonBody => {
    const random = seeded(`${repo.full_name}:/${file.path}`);
    const angle = i * GOLDEN_ANGLE;
    const r = beltRadius + (random() - 0.5) * starRadius * 0.6;
    const language = languageForPath(file.path);
    return {
      path: file.path,
      size: file.size ?? 0,
      language,
      color: colorFor(language),
      offset: { x: Math.cos(angle) * r, y: (random() - 0.5) * 0.6, z: Math.sin(angle) * r },
      radius: moonRadius(file.size ?? 0),
    };
  });

  return {
    repo,
    starRadius,
    starColor: colorFor(repo.language),
    planets,
    belt,
    beltRadius,
    totalFiles: blobs.length,
    hiddenMoons,
    truncated: tree.truncated,
    mergedDirectories,
  };
}
