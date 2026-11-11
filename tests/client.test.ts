import { describe, expect, it, vi } from 'vitest';
import { MemoryCache } from '../src/github/cache';
import { API, GitHubClient, NotFoundError, RateLimitError } from '../src/github/client';
import { repo, user } from './fixtures';

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(status === 304 || status === 202 ? null : JSON.stringify(body), {
    status,
    headers: { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '59', 'x-ratelimit-reset': '1800000000', ...headers },
  });
}

function setup(responses: Response[], now = { t: 1_000_000 }) {
  const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => responses.shift() ?? respond(500, {}));
  const cache = new MemoryCache();
  const client = new GitHubClient({
    cache,
    fetchFn: fetchFn as unknown as typeof fetch,
    now: () => now.t,
    sleep: async () => {},
  });
  return { client, cache, fetchFn, now };
}

describe('GitHubClient', () => {
  it('serves fresh cache hits without touching the network', async () => {
    const { client, fetchFn } = setup([respond(200, user, { etag: '"v1"' })]);
    await client.user('octo');
    await client.user('octo');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('revalidates stale entries with If-None-Match and accepts 304', async () => {
    const { client, fetchFn, now } = setup([respond(200, user, { etag: '"v1"' }), respond(304, null)]);
    await client.user('octo');
    now.t += 2 * 60 * 60 * 1000;
    expect(await client.user('octo')).toEqual(user);
    const headers = (fetchFn.mock.calls[1] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers['If-None-Match']).toBe('"v1"');
  });

  it('tracks the rate limit and notifies listeners', async () => {
    const { client } = setup([respond(200, user, { 'x-ratelimit-remaining': '41' })]);
    const seen: number[] = [];
    client.onRateChange((rate) => seen.push(rate.remaining));
    await client.user('octo');
    expect(seen).toEqual([41]);
    expect(client.rate?.resetAt).toBe(1_800_000_000_000);
  });

  it('throws RateLimitError when the budget is spent, and stops calling GitHub', async () => {
    const { client, fetchFn } = setup([respond(403, { message: 'rate limited' }, { 'x-ratelimit-remaining': '0' })]);
    await expect(client.user('octo')).rejects.toBeInstanceOf(RateLimitError);
    await expect(client.user('someone')).rejects.toBeInstanceOf(RateLimitError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('falls back to stale cache when rate limited', async () => {
    const { client, now } = setup([
      respond(200, user, { etag: '"v1"' }),
      respond(403, {}, { 'x-ratelimit-remaining': '0' }),
    ]);
    await client.user('octo');
    now.t += 2 * 60 * 60 * 1000;
    expect(await client.user('octo')).toEqual(user);
  });

  it('maps 404 to NotFoundError', async () => {
    const { client } = setup([respond(404, { message: 'Not Found' })]);
    await expect(client.user('nobody')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('retries commit activity while GitHub answers 202', async () => {
    const weeks = [{ week: 1, total: 4, days: [0, 1, 1, 0, 2, 0, 0] }];
    const { client, fetchFn } = setup([respond(202, null), respond(202, null), respond(200, weeks)]);
    expect(await client.activity(repo('a'))).toEqual(weeks);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('resolves null when activity never becomes ready', async () => {
    const { client } = setup([respond(202, null), respond(202, null), respond(202, null), respond(202, null)]);
    expect(await client.activity(repo('a'))).toBeNull();
  });

  it('paginates repos up to three pages', async () => {
    const page = (n: number) => Array.from({ length: n }, (_, i) => repo(`r${n}-${i}`));
    const { client, fetchFn } = setup([respond(200, page(100)), respond(200, page(100)), respond(200, page(100))]);
    const repos = await client.repos({ ...user, public_repos: 450 });
    expect(repos).toHaveLength(300);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(fetchFn.mock.calls[2]![0]).toBe(`${API}/users/octo/repos?per_page=100&sort=pushed&page=3`);
  });

  it('sends the token as a bearer header', async () => {
    const { client, fetchFn } = setup([respond(200, user)]);
    client.setToken('  github_pat_x  ');
    await client.user('octo');
    const headers = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer github_pat_x');
  });

  it('encodes branch and path segments for raw files', async () => {
    const { client, fetchFn } = setup([new Response('export {}')]);
    await client.raw(repo('a', { default_branch: 'feat/x' }), 'src/a b.ts');
    expect(fetchFn.mock.calls[0]![0]).toBe('https://raw.githubusercontent.com/octo/a/feat%2Fx/src/a%20b.ts');
  });
});
