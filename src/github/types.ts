/** The subset of GitHub REST API v3 responses that Starmap uses. */

export interface GhUser {
  login: string;
  name: string | null;
  avatar_url: string;
  html_url: string;
  public_repos: number;
  created_at: string;
  bio?: string | null;
}

export interface GhRepo {
  name: string;
  full_name: string;
  owner: { login: string };
  html_url: string;
  description: string | null;
  language: string | null;
  /** Repository size in kilobytes. */
  size: number;
  stargazers_count: number;
  forks_count: number;
  created_at: string;
  pushed_at: string;
  default_branch: string;
  fork: boolean;
  archived: boolean;
}

export interface GhTreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  /** Present on blobs: file size in bytes. */
  size?: number;
}

export interface GhTree {
  sha: string;
  truncated: boolean;
  tree: GhTreeEntry[];
}

/** One week of GET /repos/:o/:r/stats/commit_activity. */
export interface GhWeek {
  /** Unix timestamp (seconds) of the start of the week. */
  week: number;
  total: number;
  days: number[];
}
