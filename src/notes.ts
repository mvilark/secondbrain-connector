import type { IndexEntry } from "./types.ts";

export const INDEX_PATH = "System/index.json";

/** Which files appear in the search index. System files and dot-folders can still be read by path. */
export function isIndexable(path: string): boolean {
  if (!path.endsWith(".md")) return false;
  if (!path.includes("/")) return false; // root files such as README.md
  if (path.startsWith("System/")) return false;
  if (path.split("/").some((part) => part.startsWith("."))) return false;
  return true;
}

export function titleFromPath(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.replace(/\.md$/i, "");
}

export function isArchived(path: string): boolean {
  return path.startsWith("Archive/");
}

export async function gitBlobSha(content: string): Promise<string> {
  const body = new TextEncoder().encode(content);
  const header = new TextEncoder().encode(`blob ${body.length}\0`);
  const all = new Uint8Array(header.length + body.length);
  all.set(header, 0);
  all.set(body, header.length);
  const digest = await crypto.subtle.digest("SHA-1", all);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- frontmatter ----------

type Scalar = string | boolean;
type Value = Scalar | Scalar[];

function unquote(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

function scalar(raw: string): Scalar {
  const s = unquote(raw);
  if (raw.trim() === s) {
    if (s === "true") return true;
    if (s === "false") return false;
  }
  return s;
}

function splitInlineArray(inner: string): string[] {
  const items: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === "[") {
      depth++;
      cur += ch;
    } else if (ch === "]") {
      depth--;
      cur += ch;
    } else if (ch === "," && depth === 0) {
      items.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) items.push(cur);
  return items.map((i) => i.trim()).filter(Boolean);
}

export function parseFrontmatter(text: string): { data: Record<string, Value>; body: string } {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { data: {}, body: text };
  const data: Record<string, Value> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const rest = kv[2].trim();
    if (rest === "") {
      const arr: Scalar[] = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
        arr.push(scalar(lines[i + 1].replace(/^\s*-\s+/, "")));
        i++;
      }
      if (arr.length) data[key] = arr;
      continue;
    }
    if (rest.startsWith("[") && rest.endsWith("]") && !rest.startsWith("[[")) {
      data[key] = splitInlineArray(rest.slice(1, -1)).map(scalar);
    } else {
      data[key] = scalar(rest);
    }
  }
  return { data, body: text.slice(m[0].length) };
}

// ---------- links ----------

const LINK_RE = /\[\[([^\]\n|#^]+?)(?:[#^][^\]\n|]*)?(?:\|[^\]\n]*)?\]\]/g;

export function extractLinks(text: string): string[] {
  const seen = new Map<string, string>();
  for (const m of text.matchAll(LINK_RE)) {
    let t = m[1].trim();
    if (t.includes("/")) t = t.slice(t.lastIndexOf("/") + 1);
    t = t.replace(/\.md$/i, "");
    if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
  }
  return [...seen.values()];
}

// ---------- index entries ----------

const SUMMARY_LEN = 220;

function makeSummary(body: string): string {
  // Stop at the History section: old versions must never leak into current summaries.
  const cut = body.search(/^#{1,6}\s+History\s*$/im);
  const current = cut >= 0 ? body.slice(0, cut) : body;
  const text = current
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^#{1,6}\s/.test(l.trim()) && !/^>\s*$/.test(l.trim()))
    .join(" ")
    .replace(/\[\[([^\]|#^]+?)(?:[#^][^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_m, t, alias) => alias || t)
    .replace(/[*_`>#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > SUMMARY_LEN ? text.slice(0, SUMMARY_LEN - 1).trimEnd() + "…" : text;
}

function str(v: Value | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v.length ? String(v[0]) : undefined;
  const s = String(v).trim();
  return s ? s : undefined;
}

function strList(v: Value | undefined): string[] {
  if (v === undefined) return [];
  const arr = Array.isArray(v) ? v : String(v).split(/[,\s]+/);
  return arr.map((x) => String(x).trim().replace(/^#/, "")).filter(Boolean);
}

export function buildEntry(path: string, content: string, sha: string): IndexEntry {
  const { data, body } = parseFrontmatter(content);
  const entry: IndexEntry = {
    path,
    title: titleFromPath(path),
    sha,
    tags: strList(data.tags),
    links: extractLinks(content),
    summary: makeSummary(body),
  };
  const type = str(data.type);
  if (type) entry.type = type.toLowerCase();
  const status = str(data.status);
  if (status) entry.status = status.toLowerCase();
  const certainty = str(data.certainty);
  if (certainty) entry.certainty = certainty.toLowerCase();
  if (data.core === true || String(data.core).toLowerCase() === "true") entry.core = true;
  const due = str(data.due);
  if (due) entry.due = due.slice(0, 10);
  const date = str(data.date);
  if (date) entry.date = date.slice(0, 10);
  const created = str(data.created);
  if (created) entry.created = created.slice(0, 10);
  const updated = str(data.updated);
  if (updated) entry.updated = updated.slice(0, 10);
  return entry;
}

// ---------- path safety ----------

export function normalizePath(raw: string): string {
  const p = raw.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  if (!p) throw new Error("Empty path");
  const parts = p.split("/");
  if (parts.some((s) => s === ".." || s === "." || s === "")) throw new Error(`Invalid path: ${raw}`);
  if (parts[0] === ".git" || parts[0] === ".github") throw new Error(`Path not allowed: ${raw}`);
  if (/[#|^:*?"<>]/.test(parts[parts.length - 1])) {
    throw new Error(`Note names can't contain # | ^ : * ? " < > (${raw})`);
  }
  return p;
}
