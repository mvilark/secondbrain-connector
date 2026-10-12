export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
  GITHUB_TOKEN: string;
  GITHUB_REPO: string;
  OWNER_PASSPHRASE: string;
  /** Optional. Defaults to the repo's default branch. */
  GITHUB_BRANCH?: string;
  /** Optional. Only for tests. Defaults to https://api.github.com */
  GITHUB_API_URL?: string;
}

export interface IndexEntry {
  path: string;
  title: string;
  /** git blob sha of the file this entry was built from */
  sha: string;
  type?: string;
  status?: string;
  certainty?: string;
  core?: boolean;
  due?: string;
  date?: string;
  created?: string;
  updated?: string;
  tags: string[];
  links: string[];
  summary: string;
}

export interface VaultIndex {
  version: 1;
  entries: Record<string, IndexEntry>;
}
