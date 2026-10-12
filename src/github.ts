export class GitHubError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface TreeItem {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
}

export interface TreeWrite {
  path: string;
  mode: "100644";
  type: "blob";
  /** Either inline content, an existing blob sha, or null to delete. */
  content?: string;
  sha?: string | null;
}

export class GitHub {
  constructor(
    private token: string,
    private repo: string,
    private apiBase = "https://api.github.com",
    private fetchFn: typeof fetch = (...a) => fetch(...a),
  ) {}

  get repoName(): string {
    return this.repo;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.apiBase}/repos/${this.repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "second-brain-connector",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        const j = (await res.json()) as { message?: string };
        if (j.message) msg = j.message;
      } catch {
        /* ignore */
      }
      throw new GitHubError(res.status, `GitHub ${method} ${path} failed (${res.status}): ${msg}`);
    }
    return (await res.json()) as T;
  }

  async defaultBranch(): Promise<string> {
    const r = await this.req<{ default_branch: string }>("GET", "");
    return r.default_branch;
  }

  /** Returns the commit sha at the head of a branch, or null when the repo is empty. */
  async head(branch: string): Promise<string | null> {
    try {
      const r = await this.req<{ object: { sha: string } }>("GET", `/git/ref/heads/${encodeURIComponent(branch)}`);
      return r.object.sha;
    } catch (e) {
      if (e instanceof GitHubError && (e.status === 404 || e.status === 409)) return null;
      throw e;
    }
  }

  async tree(commitSha: string): Promise<{ treeSha: string; items: TreeItem[]; truncated: boolean }> {
    const r = await this.req<{ sha: string; tree: TreeItem[]; truncated: boolean }>(
      "GET",
      `/git/trees/${commitSha}?recursive=1`,
    );
    return { treeSha: r.sha, items: r.tree, truncated: r.truncated };
  }

  async blob(sha: string): Promise<string> {
    const r = await this.req<{ content: string; encoding: string }>("GET", `/git/blobs/${sha}`);
    if (r.encoding !== "base64") return r.content;
    const bin = atob(r.content.replace(/\n/g, ""));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  async createTree(baseTree: string | null, entries: TreeWrite[]): Promise<string> {
    const r = await this.req<{ sha: string }>("POST", "/git/trees", {
      ...(baseTree ? { base_tree: baseTree } : {}),
      tree: entries,
    });
    return r.sha;
  }

  async createCommit(message: string, tree: string, parents: string[]): Promise<string> {
    const r = await this.req<{ sha: string }>("POST", "/git/commits", { message, tree, parents });
    return r.sha;
  }

  async updateRef(branch: string, sha: string): Promise<void> {
    await this.req("PATCH", `/git/refs/heads/${encodeURIComponent(branch)}`, { sha, force: false });
  }

  async createRef(branch: string, sha: string): Promise<void> {
    await this.req("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha });
  }
}
