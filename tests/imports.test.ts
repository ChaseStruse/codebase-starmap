import { describe, expect, it } from 'vitest';
import { lanesFrom, parseImports, resolveToTopDir, scannableFiles } from '../src/galaxy/imports';

const ctx = { topDirs: new Set(['src', 'lib', 'shared', 'my_pkg', 'core-utils', 'internal']), fullName: 'octo/app' };

describe('parseImports', () => {
  it('finds JS/TS imports, re-exports, dynamic imports and requires', () => {
    const source = `
      import a from '../lib/a';
      import { b, c } from "./b";
      import * as d from 'react';
      import './side-effect';
      export { e } from '../shared/e';
      const f = await import('../lib/f');
      const g = require('../lib/g');
    `;
    expect(parseImports('src/x.ts', source)).toEqual([
      '../lib/a', './b', 'react', './side-effect', '../shared/e', '../lib/f', '../lib/g',
    ]);
  });

  it('finds Python, Rust and Go imports', () => {
    expect(parseImports('a/x.py', 'from ..shared import y\nimport my_pkg.sub\n')).toEqual(['..shared', 'my_pkg.sub']);
    expect(parseImports('a/x.rs', 'use core_utils::thing;\npub use crate::a;\n')).toEqual(['core_utils::thing', 'crate::a']);
    expect(parseImports('a/x.go', 'import (\n  "fmt"\n  "github.com/octo/app/internal/db"\n)\n')).toEqual([
      'fmt',
      'github.com/octo/app/internal/db',
    ]);
  });

  it('ignores languages it does not scan', () => {
    expect(parseImports('a/x.md', "import x from 'y'")).toEqual([]);
  });
});

describe('resolveToTopDir', () => {
  it('resolves relative JS paths and the @/ alias', () => {
    expect(resolveToTopDir('src/ui/x.ts', '../../lib/a', ctx)).toBe('lib');
    expect(resolveToTopDir('src/x.ts', './y', ctx)).toBe('src');
    expect(resolveToTopDir('src/x.ts', '@/y', ctx)).toBe('src');
    expect(resolveToTopDir('src/x.ts', 'react', ctx)).toBeNull();
    expect(resolveToTopDir('x.ts', '../../escape', ctx)).toBeNull();
  });

  it('resolves Python relative and absolute packages', () => {
    expect(resolveToTopDir('src/app/x.py', '...shared', ctx)).toBe('shared');
    expect(resolveToTopDir('src/x.py', '...shared', ctx)).toBeNull();
    expect(resolveToTopDir('src/x.py', '..shared', ctx)).toBe('shared');
    expect(resolveToTopDir('src/x.py', 'my_pkg.sub', ctx)).toBe('my_pkg');
  });

  it('resolves Rust crates by directory name and Go module paths', () => {
    expect(resolveToTopDir('src/x.rs', 'core_utils::thing', ctx)).toBe('core-utils');
    expect(resolveToTopDir('src/x.rs', 'crate::a', ctx)).toBeNull();
    expect(resolveToTopDir('cmd/x.go', 'github.com/Octo/App/internal/db', ctx)).toBe('internal');
    expect(resolveToTopDir('cmd/x.go', 'fmt', ctx)).toBeNull();
  });
});

describe('lanesFrom', () => {
  it('counts imports into other planets, skipping self-imports', () => {
    const lanes = lanesFrom(
      'src',
      [
        { path: 'src/a.ts', source: "import x from '../lib/x'; import y from '../lib/y'; import z from './z';" },
        { path: 'src/b.ts', source: "import s from '../shared/s';" },
      ],
      ctx,
    );
    expect(lanes).toEqual([
      { from: 'src', to: 'lib', count: 2 },
      { from: 'src', to: 'shared', count: 1 },
    ]);
  });
});

describe('scannableFiles', () => {
  it('keeps small source files, smallest first, within the limit', () => {
    const files = [
      { path: 'src/big.ts', size: 500_000 },
      { path: 'src/b.ts', size: 300 },
      { path: 'src/a.py', size: 100 },
      { path: 'src/types.d.ts', size: 50 },
      { path: 'src/readme.md', size: 10 },
    ];
    expect(scannableFiles(files, 5).map((f) => f.path)).toEqual(['src/a.py', 'src/b.ts']);
    expect(scannableFiles(files, 1)).toHaveLength(1);
  });
});
