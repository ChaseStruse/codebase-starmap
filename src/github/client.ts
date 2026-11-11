import type { CacheEntry, CacheStore } from './cache';
import type { GhRepo, GhTree, GhUser, GhWeek } from './types';

export const API = 'https://api.github.com';
export const RAW = 'https://raw.githubusercontent.com';

export interface RateLimit {
  limit: number;
  remaining: number;
  /** Epoch milliseconds. */
  resetAt: number;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export class RateLimitError extends GitHubError {
  constructor(readonly resetAt: number) {
    super(
      `GitHub's hourly request limit is used up. It resets at ${new Date(resetAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. Adding a token raises the limit to 5,000 per hour.`,
      403,
    );
    this.name = 'RateLimitError';
  }
}

export class NotFoundError extends GitHubError {
  constructor(what: string) {
    super(`${what} was not found on GitHub.`, 404);
    this.name = 'NotFoundError';
  }
}

export interface ClientOptions {
  cache: CacheStore;
  token?: string | null;
  fetchFn?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How long a cached response is served without asking GitHub at all. */
  maxAgeMs?: number;
}

const HOUR = 60 * 60 * 1000;
/** Each 202 counts against the hourly budget, so retry sparingly. */
const STATS_RETRIES = 2;
const MAX_REPO_PAGES = 3;

/**
 * A small GitHub REST client built around a tight request budget:
 * fresh cache hits cost nothing, stale entries revalidate with ETags, and the
 * rate limit is tracked from every response so the UI can show it.
 */
export class GitHubClient {
  rate: RateLimit | null = null;
  private token: string | null;
  private readonly cache: CacheStore;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAgeMs: number;
  private readonly listeners = new Set<(rate: RateLimit) => void>();

  constructor(options: ClientOptions) {
    this.cache = options.cache;
    this.token = options.token?.trim() || null;
    this.fetchFn = options.fetchFn ?? ((...args) => fetch(...args));
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxAgeMs = options.maxAgeMs ?? HOUR;
  }

  get hasToken() {
    return this.token !== null;
  }

  setToken(token: string | null) {
    this.token = token?.trim() || null;
    // The limit differs per token, so forget what we knew.
    this.rate = null;
  }

  onRateChange(listener: (rate: RateLimit) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  user(login: string) {
    return this.json<GhUser>(`${API}/users/${encodeURIComponent(login)}`, `User @${login}`);
  }

  /** All public repos, up to 300 (three pages), most recently pushed first. */
  async repos(user: GhUser): Promise<GhRepo[]> {
    const pages = Math.max(1, Math.min(MAX_REPO_PAGES, Math.ceil(user.public_repos / 100)));
    const all: GhRepo[] = [];
    for (let page = 1; page <= pages; page++) {
      const url = `${API}/users/${encodeURIComponent(user.login)}/repos?per_page=100&sort=pushed&page=${page}`;
      const batch = await this.json<GhRepo[]>(url, `Repositories of @${user.login}`);
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  }

  tree(repo: GhRepo) {
    const url = `${API}/repos/${repoPath(repo)}/git/trees/${encodeURIComponent(repo.default_branch)}?recursive=1`;
    return this.json<GhTree>(url, `The file tree of ${repo.full_name}`);
  }

  /**
   * 52 weeks of commit counts. GitHub computes these lazily and answers 202
   * while it works, so this retries a few times and resolves null if the
   * numbers are still not ready.
   */
  async activity(repo: GhRepo): Promise<GhWeek[] | null> {
    const url = `${API}/repos/${repoPath(repo)}/stats/commit_activity`;
    const result = await this.request<GhWeek[]>(url, `Commit activity of ${repo.full_name}`, true);
    return Array.isArray(result) ? result : null;
  }

  /** File contents. Served by raw.githubusercontent.com, outside the REST quota. */
  async raw(repo: GhRepo, path: string): Promise<string> {
    const url = `${RAW}/${repoPath(repo)}/${encodeURIComponent(repo.default_branch)}/${path
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;
    const cached = await this.cache.get(url);
    if (cached && typeof cached.body === 'string') return cached.body;
    const response = await this.fetchFn(url);
    if (!response.ok) throw new GitHubError(`Could not read ${path} (${response.status}).`, response.status);
    const text = await response.text();
    await this.cache.set({ url, etag: null, fetchedAt: this.now(), body: text });
    return text;
  }

  private async json<T>(url: string, what: string): Promise<T> {
    const result = await this.request<T>(url, what, false);
    if (result === null) throw new GitHubError(`${what} is not available yet.`, 202);
    return result;
  }

  private async request<T>(url: string, what: string, accept202: boolean): Promise<T | null> {
    const cached = await this.cache.get(url);
    const now = this.now();
    if (cached && now - cached.fetchedAt < this.maxAgeMs) return cached.body as T;

    if (this.rate && this.rate.remaining <= 0 && this.rate.resetAt > now) {
      if (cached) return cached.body as T;
      throw new RateLimitError(this.rate.resetAt);
    }

    for (let attempt = 0; attempt <= STATS_RETRIES; attempt++) {
      const response = await this.fetchFn(url, { headers: this.headers(cached) });
      this.readRate(response.headers);

      if (response.status === 304 && cached) {
        await this.cache.set({ ...cached, fetchedAt: this.now() });
        return cached.body as T;
      }
      if (response.status === 202 && accept202) {
        if (attempt === STATS_RETRIES) return null;
        await this.sleep(3000 * (attempt + 1));
        continue;
      }
      if (response.ok) {
        const body = (await response.json()) as T;
        await this.cache.set({ url, etag: response.headers.get('etag'), fetchedAt: this.now(), body });
        return body;
      }
      if (response.status === 404) throw new NotFoundError(what);
      if (response.status === 401) {
        throw new GitHubError('GitHub rejected the token. Check it or remove it in Settings.', 401);
      }
      if (response.status === 409) throw new GitHubError(`${what} is empty: the repository has no commits.`, 409);
      if (
        (response.status === 403 || response.status === 429) &&
        (this.rate?.remaining === 0 || response.headers.has('retry-after'))
      ) {
        if (cached) return cached.body as T;
        const retryAfter = Number(response.headers.get('retry-after'));
        const resetAt = this.rate?.resetAt ?? this.now() + (Number.isFinite(retryAfter) ? retryAfter * 1000 : HOUR);
        throw new RateLimitError(resetAt);
      }
      throw new GitHubError(`GitHub returned ${response.status} for ${what.toLowerCase()}.`, response.status);
    }
    return null;
  }

  private headers(cached: CacheEntry | undefined): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (cached?.etag) headers['If-None-Match'] = cached.etag;
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  private readRate(headers: Headers) {
    const limit = Number(headers.get('x-ratelimit-limit'));
    const remaining = Number(headers.get('x-ratelimit-remaining'));
    const reset = Number(headers.get('x-ratelimit-reset'));
    if (!headers.has('x-ratelimit-remaining') || !Number.isFinite(remaining)) return;
    this.rate = { limit, remaining, resetAt: reset * 1000 };
    for (const listener of this.listeners) listener(this.rate);
  }
}

function repoPath(repo: GhRepo) {
  return `${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}`;
}
