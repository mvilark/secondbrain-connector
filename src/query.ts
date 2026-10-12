import type { IndexEntry, VaultIndex } from "./types.ts";
import { isArchived } from "./notes.ts";

export interface SearchOptions {
  query?: string;
  type?: string;
  tag?: string;
  status?: string;
  include_archive?: boolean;
  limit?: number;
}

const STOPWORDS = new Set(["the", "and", "for", "with", "about", "that", "this", "from", "into", "what", "how", "why", "are", "was", "but", "not", "you", "your", "have", "has"]);

function tokens(q: string): string[] {
  const all = q
    .toLowerCase()
    .split(/[\s,;]+/)
    .map((t) => t.replace(/^#/, ""))
    .filter((t) => t.length > 0);
  const meaningful = all.filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return meaningful.length ? meaningful : all;
}

function tagMatches(tags: string[], wanted: string): boolean {
  const w = wanted.toLowerCase().replace(/^#/, "");
  return tags.some((t) => {
    const x = t.toLowerCase();
    return x === w || x.startsWith(w + "/");
  });
}

interface Haystack {
  title: string;
  tags: string;
  summary: string;
  links: string;
}
// Lowercased fields are computed once per entry and reused across requests, which keeps searches cheap.
const haystacks = new WeakMap<IndexEntry, Haystack>();
function haystack(e: IndexEntry): Haystack {
  let h = haystacks.get(e);
  if (!h) {
    h = { title: e.title.toLowerCase(), tags: e.tags.join(" ").toLowerCase(), summary: e.summary.toLowerCase(), links: e.links.join(" ").toLowerCase() };
    haystacks.set(e, h);
  }
  return h;
}

export function search(index: VaultIndex, opts: SearchOptions): IndexEntry[] {
  const toks = opts.query ? tokens(opts.query) : [];
  const limit = Math.min(Math.max(opts.limit ?? 15, 1), 40);
  const scored: { e: IndexEntry; score: number }[] = [];
  for (const e of Object.values(index.entries)) {
    if (!opts.include_archive && isArchived(e.path)) continue;
    if (opts.type && e.type !== opts.type.toLowerCase()) continue;
    if (opts.status && e.status !== opts.status.toLowerCase()) continue;
    if (opts.tag && !tagMatches(e.tags, opts.tag)) continue;
    let score = 0;
    if (toks.length) {
      const { title, tags, summary, links } = haystack(e);
      let matched = 0;
      for (const t of toks) {
        let s = 0;
        if (title === t) s += 8;
        else if (title.includes(t)) s += 4;
        if (tags.includes(t)) s += 3;
        if (summary.includes(t)) s += 2;
        if (links.includes(t)) s += 1;
        if (s > 0) matched++;
        score += s;
      }
      if (matched === 0) continue;
      score += matched === toks.length ? 3 : 0;
    }
    scored.push({ e, score });
  }
  scored.sort(
    (a, b) => b.score - a.score || (b.e.updated ?? "").localeCompare(a.e.updated ?? "") || a.e.title.localeCompare(b.e.title),
  );
  return scored.slice(0, limit).map((s) => s.e);
}

export function backlinks(index: VaultIndex, title: string, includeArchive = false): IndexEntry[] {
  const t = title.trim().toLowerCase();
  return Object.values(index.entries)
    .filter((e) => (includeArchive || !isArchived(e.path)) && e.title.toLowerCase() !== t)
    .filter((e) => e.links.some((l) => l.toLowerCase() === t))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Find notes by exact title (case-insensitive). Live notes win over archived ones. */
export function resolveTitle(index: VaultIndex, title: string): IndexEntry | undefined {
  const t = title.trim().toLowerCase().replace(/\.md$/, "");
  const matches = Object.values(index.entries).filter((e) => e.title.toLowerCase() === t);
  return matches.find((e) => !isArchived(e.path)) ?? matches[0];
}

export function suggestTitles(index: VaultIndex, title: string, max = 3): string[] {
  const toks = tokens(title);
  if (!toks.length) return [];
  return Object.values(index.entries)
    .map((e) => {
      const t = e.title.toLowerCase();
      return { title: e.title, score: toks.filter((x) => t.includes(x)).length };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.title);
}

const OPEN_STATUSES = new Set(["active", "open", "pending", "paused", "waiting", "scheduled", "todo", "in-progress"]);

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface DueItem {
  entry: IndexEntry;
  when: string;
  overdue: boolean;
}

/** Open tasks, reminders and events that are overdue or fall within the next `days` days. */
export function dueItems(index: VaultIndex, today: string, days = 14): DueItem[] {
  const horizon = addDays(today, days);
  const out: DueItem[] = [];
  for (const e of Object.values(index.entries)) {
    if (isArchived(e.path)) continue;
    if (e.type !== "task" && e.type !== "reminder" && e.type !== "event") continue;
    if (e.status && !OPEN_STATUSES.has(e.status)) continue;
    const when = e.due ?? e.date;
    if (!when) continue;
    const overdue = when < today && e.type !== "event";
    if (when < today && e.type === "event") continue; // past events are not "due"
    if (when > horizon) continue;
    out.push({ entry: e, when, overdue });
  }
  return out.sort((a, b) => a.when.localeCompare(b.when) || a.entry.title.localeCompare(b.entry.title));
}
