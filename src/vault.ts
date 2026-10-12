import { GitHub, GitHubError, type TreeWrite } from "./github.ts";
import type { IndexEntry, VaultIndex } from "./types.ts";
import {
  INDEX_PATH,
  buildEntry,
  gitBlobSha,
  isIndexable,
  normalizePath,
  titleFromPath,
} from "./notes.ts";

/** Workers Free allows 50 subrequests per request. Base calls use ~3-6; keep refresh well under the rest. */
const MAX_REFRESH_PER_REQUEST = 28;
const MAX_CHANGES = 40;
const MAX_FILE_BYTES = 200_000;

export interface State {
  head: string;
  treeSha: string;
  files: Map<string, string>;
  index: VaultIndex;
  /** index.json in the repo differs from the in-memory index */
  dirty: boolean;
  /** indexable files whose entries are not refreshed yet */
  stale: string[];
}

export type Change =
  | { op: "write"; path: string; content: string }
  | { op: "delete"; path: string }
  | { op: "move"; from: string; to: string; content?: string };

export interface SaveResult {
  commit: string;
  url: string;
  written: string[];
  deleted: string[];
  moved: string[];
  unchanged: string[];
  warnings: string[];
}

const cache = new Map<string, State>();
const branchCache = new Map<string, string>();

export function clearVaultCache(): void {
  cache.clear();
  branchCache.clear();
}

function serializeIndex(entries: Record<string, IndexEntry>): string {
  const lines = Object.keys(entries)
    .sort()
    .map((p) => `${JSON.stringify(p)}:${JSON.stringify(entries[p])}`);
  return `{"version":1,"entries":{\n${lines.join(",\n")}\n}}\n`;
}

function isConflict(e: unknown): boolean {
  return e instanceof GitHubError && (e.status === 422 || e.status === 409);
}

export class Vault {
  private branch: string | undefined;

  constructor(
    private gh: GitHub,
    branch?: string,
  ) {
    this.branch = branch;
  }

  get repoName(): string {
    return this.gh.repoName;
  }

  private async getBranch(): Promise<string> {
    if (!this.branch) {
      const known = branchCache.get(this.gh.repoName);
      if (known) this.branch = known;
      else {
        this.branch = await this.gh.defaultBranch();
        branchCache.set(this.gh.repoName, this.branch);
      }
    }
    return this.branch;
  }

  private key(branch: string): string {
    return `${this.gh.repoName}@${branch}`;
  }

  /** Loads the current vault state: head, file list and a synced (possibly partially refreshed) index. */
  async load(): Promise<State> {
    const branch = await this.getBranch();
    const head = await this.gh.head(branch);
    if (!head) {
      throw new Error(
        `The repo ${this.gh.repoName} has no commits on "${branch}". Create it from the vault template first.`,
      );
    }
    const key = this.key(branch);
    const cached = cache.get(key);
    if (cached && cached.head === head) {
      if (cached.stale.length) await this.refresh(cached);
      return cached;
    }

    const { treeSha, items, truncated } = await this.gh.tree(head);
    if (truncated) throw new Error("The vault is too large for this connector (GitHub truncated the file list).");
    const files = new Map<string, string>();
    for (const it of items) if (it.type === "blob") files.set(it.path, it.sha);

    let index: VaultIndex | undefined = cached?.index;
    let dirty = cached?.dirty ?? false;
    if (!index) {
      index = { version: 1, entries: {} };
      const indexSha = files.get(INDEX_PATH);
      if (indexSha) {
        try {
          const parsed = JSON.parse(await this.gh.blob(indexSha)) as VaultIndex;
          if (parsed && parsed.version === 1 && parsed.entries) index = parsed;
          else dirty = true;
        } catch {
          dirty = true;
        }
      } else {
        dirty = true;
      }
    }

    const indexable = [...files.keys()].filter(isIndexable);
    const live = new Set(indexable);
    for (const p of Object.keys(index.entries)) {
      if (!live.has(p)) {
        delete index.entries[p];
        dirty = true;
      }
    }
    const stale = indexable.filter((p) => index!.entries[p]?.sha !== files.get(p));
    const state: State = { head, treeSha, files, index, dirty, stale };
    cache.set(key, state);
    if (stale.length) await this.refresh(state);
    return state;
  }

  private async refresh(state: State): Promise<void> {
    const batch = state.stale.slice(0, MAX_REFRESH_PER_REQUEST);
    const results = await Promise.all(
      batch.map(async (path) => {
        const sha = state.files.get(path);
        if (!sha) return { path, ok: true as const, entry: null };
        try {
          const content = await this.gh.blob(sha);
          return { path, ok: true as const, entry: buildEntry(path, content, sha) };
        } catch {
          return { path, ok: false as const, entry: null };
        }
      }),
    );
    const failed = new Set<string>();
    for (const r of results) {
      if (!r.ok) {
        failed.add(r.path);
        continue;
      }
      if (r.entry) state.index.entries[r.path] = r.entry;
      state.dirty = true;
    }
    state.stale = [...state.stale.slice(MAX_REFRESH_PER_REQUEST), ...failed];
  }

  /** Reads the text of files by path (from the current tree). */
  async readFiles(state: State, paths: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    await Promise.all(
      paths.map(async (p) => {
        const sha = state.files.get(p);
        if (!sha) {
          out.set(p, null);
          return;
        }
        try {
          out.set(p, await this.gh.blob(sha));
        } catch {
          out.set(p, null);
        }
      }),
    );
    return out;
  }

  /** Writes the index to the repo if it has drifted (for example after manual edits). */
  async syncIndex(state: State, message = "Sync vault index"): Promise<boolean> {
    if (!state.dirty || state.stale.length > 0) return false;
    const content = serializeIndex(state.index.entries);
    try {
      await this.commit(state, [{ path: INDEX_PATH, mode: "100644", type: "blob", content }], message);
      state.dirty = false;
      return true;
    } catch (e) {
      if (isConflict(e)) {
        cache.delete(this.key(await this.getBranch()));
        return false;
      }
      throw e;
    }
  }

  private async commit(state: State, writes: TreeWrite[], message: string): Promise<string> {
    const branch = await this.getBranch();
    const tree = await this.gh.createTree(state.treeSha, writes);
    const commit = await this.gh.createCommit(message, tree, [state.head]);
    await this.gh.updateRef(branch, commit);
    for (const w of writes) {
      if (w.sha === null) state.files.delete(w.path);
      else if (w.sha) state.files.set(w.path, w.sha);
      else if (w.content !== undefined) state.files.set(w.path, await gitBlobSha(w.content));
    }
    state.head = commit;
    state.treeSha = tree;
    return commit;
  }

  async save(changes: Change[], message: string): Promise<SaveResult> {
    if (!changes.length) throw new Error("No changes given.");
    if (changes.length > MAX_CHANGES) throw new Error(`Too many changes in one call (max ${MAX_CHANGES}). Split it.`);
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) cache.delete(this.key(await this.getBranch()));
      const state = await this.load();
      try {
        return await this.applyOnce(state, changes, message);
      } catch (e) {
        if (!isConflict(e) || attempt === 2) throw e;
        lastError = e;
      }
    }
    throw lastError;
  }

  private async applyOnce(state: State, changes: Change[], message: string): Promise<SaveResult> {
    const writes = new Map<string, TreeWrite>();
    const files = new Map(state.files);
    const entries: Record<string, IndexEntry> = { ...state.index.entries };
    const touched = new Set<string>();
    const result: SaveResult = { commit: "", url: "", written: [], deleted: [], moved: [], unchanged: [], warnings: [] };

    const putContent = async (path: string, content: string): Promise<boolean> => {
      if (path === INDEX_PATH) throw new Error(`${INDEX_PATH} is maintained by the connector; don't write it.`);
      if (new TextEncoder().encode(content).length > MAX_FILE_BYTES) {
        throw new Error(`${path} is larger than ${MAX_FILE_BYTES / 1000} KB. Split the note.`);
      }
      const sha = await gitBlobSha(content);
      if (files.get(path) === sha && !writes.has(path)) return false;
      writes.set(path, { path, mode: "100644", type: "blob", content });
      files.set(path, sha);
      if (isIndexable(path)) {
        entries[path] = buildEntry(path, content, sha);
        touched.add(path);
      }
      return true;
    };
    const removePath = (path: string) => {
      writes.set(path, { path, mode: "100644", type: "blob", sha: null });
      files.delete(path);
      delete entries[path];
    };

    for (const ch of changes) {
      if (ch.op === "write") {
        const path = normalizePath(ch.path);
        if (typeof ch.content !== "string") throw new Error(`write ${path}: content is required`);
        if (await putContent(path, ch.content)) result.written.push(path);
        else result.unchanged.push(path);
      } else if (ch.op === "delete") {
        const path = normalizePath(ch.path);
        if (!files.has(path)) throw new Error(`delete ${path}: no such file`);
        if (path === INDEX_PATH) throw new Error(`${INDEX_PATH} can't be deleted.`);
        removePath(path);
        result.deleted.push(path);
      } else if (ch.op === "move") {
        const from = normalizePath(ch.from);
        const to = normalizePath(ch.to);
        if (!files.has(from)) throw new Error(`move ${from}: no such file`);
        if (files.has(to)) throw new Error(`move ${from} -> ${to}: destination already exists`);
        if (typeof ch.content === "string") {
          await putContent(to, ch.content);
        } else {
          const sha = files.get(from)!;
          writes.set(to, { path: to, mode: "100644", type: "blob", sha });
          files.set(to, sha);
          if (isIndexable(to)) {
            let entry = entries[from];
            if (!entry) {
              entry = buildEntry(to, await this.gh.blob(sha), sha);
            }
            entries[to] = { ...entry, path: to, title: titleFromPath(to) };
            touched.add(to);
          }
        }
        removePath(from);
        result.moved.push(`${from} -> ${to}`);
      }
    }

    // Titles must stay unique vault-wide.
    const byTitle = new Map<string, string[]>();
    for (const e of Object.values(entries)) {
      const k = e.title.toLowerCase();
      byTitle.set(k, [...(byTitle.get(k) ?? []), e.path]);
    }
    for (const p of touched) {
      const same = byTitle.get(entries[p].title.toLowerCase()) ?? [];
      if (same.length > 1) {
        throw new Error(`Title "${entries[p].title}" would exist twice: ${same.join(" and ")}. Titles must be unique; nothing was saved.`);
      }
    }

    // Soft checks, reported back so the agent can fix them in a follow-up save.
    const known = new Set<string>();
    for (const p of files.keys()) if (p.endsWith(".md")) known.add(titleFromPath(p).toLowerCase());
    const unresolved = new Set<string>();
    for (const p of touched) {
      const e = entries[p];
      if (!e.type) result.warnings.push(`${p}: no "type" property.`);
      for (const l of e.links) if (!known.has(l.toLowerCase())) unresolved.add(l);
    }
    if (unresolved.size) {
      const list = [...unresolved].slice(0, 15).map((l) => `[[${l}]]`).join(", ");
      result.warnings.push(`Links with no note yet: ${list}${unresolved.size > 15 ? ", …" : ""}`);
    }

    if (!writes.size) {
      result.commit = state.head;
      result.url = `https://github.com/${this.gh.repoName}/commit/${state.head}`;
      return result;
    }

    const indexJson = serializeIndex(entries);
    writes.set(INDEX_PATH, { path: INDEX_PATH, mode: "100644", type: "blob", content: indexJson });
    files.set(INDEX_PATH, await gitBlobSha(indexJson));

    const commit = await this.commit(state, [...writes.values()], message.trim() || "Update vault");
    state.index = { version: 1, entries };
    state.files = files;
    state.dirty = false;
    result.commit = commit;
    result.url = `https://github.com/${this.gh.repoName}/commit/${commit}`;
    return result;
  }
}
