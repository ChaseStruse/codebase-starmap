import type { GhRepo, GhTree, GhUser } from '../src/github/types';

export const user: GhUser = {
  login: 'octo',
  name: 'Octo Cat',
  avatar_url: 'https://avatars.githubusercontent.com/u/1',
  html_url: 'https://github.com/octo',
  public_repos: 3,
  created_at: '2015-01-01T00:00:00Z',
};

export function repo(name: string, extra: Partial<GhRepo> = {}): GhRepo {
  return {
    name,
    full_name: `octo/${name}`,
    owner: { login: 'octo' },
    html_url: `https://github.com/octo/${name}`,
    description: null,
    language: 'TypeScript',
    size: 1200,
    stargazers_count: 3,
    forks_count: 0,
    created_at: '2020-01-01T00:00:00Z',
    pushed_at: '2026-11-01T00:00:00Z',
    default_branch: 'main',
    fork: false,
    archived: false,
    ...extra,
  };
}

export function tree(paths: [string, number][], truncated = false): GhTree {
  const dirs = new Set<string>();
  for (const [path] of paths) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return {
    sha: 'abc',
    truncated,
    tree: [
      ...[...dirs].map((path) => ({ path, type: 'tree' as const, sha: `t-${path}` })),
      ...paths.map(([path, size]) => ({ path, type: 'blob' as const, sha: `b-${path}`, size })),
      { path: 'vendor-sub', type: 'commit' as const, sha: 'sub' },
    ],
  };
}
