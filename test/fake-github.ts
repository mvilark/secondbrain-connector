import { createHash } from "node:crypto";
import { gitBlobSha } from "../src/notes.ts";

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

/** A tiny in-memory implementation of the GitHub Git Data API calls the connector uses. */
export class FakeGitHub {
  blobs = new Map<string, string>();
  trees = new Map<string, Record<string, string>>();
  commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  head: string | null = null;
  calls = 0;
  failNextRefUpdate = false;
  readonly repo = "me/vault";

  constructor(files: Record<string, string> = {}) {
    if (Object.keys(files).length) this.manualCommitSync(files, "seed");
  }

  private storeBlob(content: string): string {
    const body = Buffer.from(content, "utf8");
    const sha = createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex");
    this.blobs.set(sha, content);
    return sha;
  }

  private storeTree(map: Record<string, string>): string {
    const sorted = Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));
    const sha = sha1("tree:" + JSON.stringify(sorted));
    this.trees.set(sha, sorted);
    return sha;
  }

  /** Simulates a commit made outside the connector (for example from Obsidian). null deletes a file. */
  manualCommitSync(files: Record<string, string | null>, message = "manual edit"): string {
    const base = this.head ? { ...this.trees.get(this.commits.get(this.head)!.tree)! } : {};
    for (const [p, c] of Object.entries(files)) {
      if (c === null) delete base[p];
      else base[p] = this.storeBlob(c);
    }
    const tree = this.storeTree(base);
    const sha = sha1(`commit:${tree}:${this.head}:${message}:${this.commits.size}`);
    this.commits.set(sha, { tree, parents: this.head ? [this.head] : [], message });
    this.head = sha;
    return sha;
  }

  files(): Record<string, string> {
    if (!this.head) return {};
    const t = this.trees.get(this.commits.get(this.head)!.tree)!;
    return Object.fromEntries(Object.entries(t).map(([p, s]) => [p, this.blobs.get(s)!]));
  }

  commitCount(): number {
    let n = 0;
    for (let c = this.head; c; c = this.commits.get(c)!.parents[0] ?? null) n++;
    return n;
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    this.calls++;
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const prefix = `/repos/${this.repo}`;
    if (!url.pathname.startsWith(prefix)) return Response.json({ message: "Not Found" }, { status: 404 });
    const p = url.pathname.slice(prefix.length);
    const json = (data: unknown, status = 200) => Response.json(data, { status });

    if (method === "GET" && p === "") return json({ default_branch: "main" });
    if (method === "GET" && p === "/git/ref/heads/main") {
      return this.head ? json({ object: { sha: this.head } }) : json({ message: "Not Found" }, 404);
    }
    let m = /^\/git\/trees\/([0-9a-f]+)$/.exec(p);
    if (method === "GET" && m) {
      const commit = this.commits.get(m[1]);
      const treeSha = commit ? commit.tree : m[1];
      const tree = this.trees.get(treeSha);
      if (!tree) return json({ message: "Not Found" }, 404);
      return json({
        sha: treeSha,
        truncated: false,
        tree: Object.entries(tree).map(([path, sha]) => ({ path, mode: "100644", type: "blob", sha })),
      });
    }
    m = /^\/git\/blobs\/([0-9a-f]+)$/.exec(p);
    if (method === "GET" && m) {
      const c = this.blobs.get(m[1]);
      if (c === undefined) return json({ message: "Not Found" }, 404);
      return json({ content: Buffer.from(c, "utf8").toString("base64"), encoding: "base64" });
    }
    if (method === "POST" && p === "/git/trees") {
      const base = body.base_tree ? { ...this.trees.get(body.base_tree)! } : {};
      for (const e of body.tree as { path: string; content?: string; sha?: string | null }[]) {
        if (e.sha === null) {
          if (!(e.path in base)) return json({ message: `path ${e.path} not found` }, 422);
          delete base[e.path];
        } else if (e.content !== undefined) base[e.path] = this.storeBlob(e.content);
        else if (e.sha) {
          if (!this.blobs.has(e.sha)) return json({ message: "bad sha" }, 422);
          base[e.path] = e.sha;
        }
      }
      return json({ sha: this.storeTree(base) }, 201);
    }
    if (method === "POST" && p === "/git/commits") {
      const sha = sha1(`commit:${body.tree}:${body.parents}:${body.message}:${this.commits.size}`);
      this.commits.set(sha, { tree: body.tree, parents: body.parents, message: body.message });
      return json({ sha }, 201);
    }
    if (method === "PATCH" && p === "/git/refs/heads/main") {
      const c = this.commits.get(body.sha);
      if (this.failNextRefUpdate) {
        this.failNextRefUpdate = false;
        // simulate somebody else pushing in between
        this.manualCommitSync({ "Thoughts/Concurrent edit.md": "---\ntype: thought\n---\nsneaky" }, "concurrent");
        return json({ message: "Update is not a fast forward" }, 422);
      }
      if (!c || c.parents[0] !== this.head) return json({ message: "Update is not a fast forward" }, 422);
      this.head = body.sha;
      return json({ object: { sha: body.sha } });
    }
    return json({ message: `unhandled ${method} ${p}` }, 500);
  };
}

export { gitBlobSha };
