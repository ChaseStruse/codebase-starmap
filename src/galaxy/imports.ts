/**
 * Lightweight import scanning for trade lanes. Regexes, not parsers: good
 * enough to show which directories lean on which, cheap enough to run in the
 * browser on demand. tree-sitter (WASM) is the upgrade path.
 */
import { languageForPath } from './languages';

const JS_PATTERNS = [
  /\bimport\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bexport\s+[\w*{}\s,]+\s+from\s+['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function matchAll(source: string, patterns: RegExp[]): string[] {
  const found: string[] = [];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) found.push(match[1]!);
  return found;
}

/** Import specifiers in one file, as written. */
export function parseImports(path: string, source: string): string[] {
  switch (languageForPath(path)) {
    case 'TypeScript':
    case 'JavaScript':
    case 'Vue':
    case 'Svelte':
      return matchAll(source, JS_PATTERNS);
    case 'Python':
      return matchAll(source, [/^\s*from\s+([.\w]+)\s+import\b/gm, /^\s*import\s+([\w.]+)/gm]);
    case 'Rust':
      return matchAll(source, [/^\s*(?:pub\s+)?use\s+([\w:]+)/gm, /^\s*extern\s+crate\s+(\w+)/gm]);
    case 'Go': {
      const found: string[] = [];
      for (const block of source.matchAll(/\bimport\s*\(([\s\S]*?)\)/g))
        for (const line of block[1]!.matchAll(/"([^"]+)"/g)) found.push(line[1]!);
      for (const single of source.matchAll(/\bimport\s+(?:\w+\s+)?"([^"]+)"/g)) found.push(single[1]!);
      return found;
    }
    default:
      return [];
  }
}

function normalize(parts: string[]): string[] | null {
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return out;
}

export interface ResolveContext {
  /** Top-level directory names in the repo (planets). */
  topDirs: ReadonlySet<string>;
  /** "owner/repo", lowercased, for Go module paths. */
  fullName: string;
}

/**
 * Which top-level directory an import points at, or null for external
 * packages and same-directory imports we cannot place.
 */
export function resolveToTopDir(fromPath: string, spec: string, ctx: ResolveContext): string | null {
  const language = languageForPath(fromPath);
  const fromDir = fromPath.split('/').slice(0, -1);
  const top = (parts: string[] | null) => (parts && parts.length && ctx.topDirs.has(parts[0]!) ? parts[0]! : null);

  if (language === 'Python') {
    const dots = spec.match(/^\.+/)?.[0].length ?? 0;
    const rest = spec.slice(dots).split('.').filter(Boolean);
    if (dots) return top(normalize([...fromDir, ...Array(dots - 1).fill('..'), ...rest]));
    return top(rest);
  }
  if (language === 'Rust') {
    const [first] = spec.split('::');
    if (!first || ['crate', 'self', 'super', 'std', 'core', 'alloc'].includes(first)) return null;
    for (const dir of ctx.topDirs) if (dir.replace(/-/g, '_') === first) return dir;
    return null;
  }
  if (language === 'Go') {
    const marker = `github.com/${ctx.fullName}/`;
    const lower = spec.toLowerCase();
    if (!lower.startsWith(marker)) return null;
    return top(spec.slice(marker.length).split('/'));
  }
  // JavaScript family
  if (spec.startsWith('.')) return top(normalize([...fromDir, ...spec.split('/')]));
  if (spec.startsWith('/')) return top(spec.split('/'));
  if (spec.startsWith('@/') || spec.startsWith('~/')) return top(['src', ...spec.slice(2).split('/')]);
  return top(spec.split('/'));
}

export interface Lane {
  from: string;
  to: string;
  count: number;
}

/** Aggregate scanned files into lanes leaving one planet. */
export function lanesFrom(
  planet: string,
  files: { path: string; source: string }[],
  ctx: ResolveContext,
): Lane[] {
  const counts = new Map<string, number>();
  for (const file of files)
    for (const spec of parseImports(file.path, file.source)) {
      const target = resolveToTopDir(file.path, spec, ctx);
      if (target && target !== planet) counts.set(target, (counts.get(target) ?? 0) + 1);
    }
  return [...counts.entries()]
    .map(([to, count]) => ({ from: planet, to, count }))
    .sort((a, b) => b.count - a.count || a.to.localeCompare(b.to));
}

/** Code files worth scanning under a planet, smallest first so more fit in the budget. */
export function scannableFiles<T extends { path: string; size?: number }>(files: T[], limit = 40): T[] {
  return files
    .filter((file) => {
      const language = languageForPath(file.path);
      return (
        ['TypeScript', 'JavaScript', 'Vue', 'Svelte', 'Python', 'Rust', 'Go'].includes(language ?? '') &&
        (file.size ?? 0) < 200_000 &&
        !/\.(min|d)\.[jt]s$/.test(file.path)
      );
    })
    .sort((a, b) => (a.size ?? 0) - (b.size ?? 0) || a.path.localeCompare(b.path))
    .slice(0, limit);
}
