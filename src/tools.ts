import type { IndexEntry } from "./types.ts";
import { Vault, type Change } from "./vault.ts";
import { backlinks, dueItems, resolveTitle, search, suggestTitles } from "./query.ts";
import { isArchived } from "./notes.ts";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

export const TOOLS = [
  {
    name: "start_session",
    description:
      "Call once at the start of every conversation. Returns the vault's current-state notes (core notes), today's daily note, and tasks/reminders/events that are overdue or due in the next 14 days. Pass the user's local date if you know it.",
    inputSchema: {
      type: "object",
      properties: {
        today: { type: "string", description: "The user's local date, YYYY-MM-DD. Defaults to today in UTC." },
      },
    },
  },
  {
    name: "read_notes",
    description:
      "Read several notes in one call. Each item is a note title (preferred, e.g. \"Move to Lisbon\") or a vault path (e.g. \"System/Tag index.md\"). Max 15 per call.",
    inputSchema: {
      type: "object",
      properties: { notes: { type: "array", items: { type: "string" }, description: "Titles or paths." } },
      required: ["notes"],
    },
  },
  {
    name: "search",
    description:
      "Search the vault index by words (title, tags, summary, links), and/or filter by type, tag or status. Archived notes are skipped unless include_archive is true. Returns titles, metadata and one-line summaries; use read_notes for full text.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to look for. Optional if filtering." },
        type: { type: "string", description: "Note type, e.g. value, principle, thought, concern, goal, decision, task, person." },
        tag: { type: "string", description: "Tag, e.g. area/health. A parent tag matches its children." },
        status: { type: "string", description: "e.g. active, open, done, resolved." },
        include_archive: { type: "boolean" },
        limit: { type: "number", description: "Default 15, max 40." },
      },
    },
  },
  {
    name: "backlinks",
    description: "List every note that links to the given note title. Use it to see everything connected to a person, place, value or decision.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, include_archive: { type: "boolean" } },
      required: ["title"],
    },
  },
  {
    name: "save_changes",
    description:
      "Create, update, move and delete notes in ONE git commit (max 40 changes). Do all of a capture's writes in a single call. Each change is {op:'write', path, content} (full new file text), {op:'move', from, to, content?} (omit content to keep the text) or {op:'delete', path}. Notes need YAML frontmatter with at least `type`. Titles (file names) must be unique vault-wide. The search index is updated automatically; never write System/index.json. Returns warnings (e.g. links to notes that don't exist yet) so you can fix them.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Short commit message." },
        changes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["write", "move", "delete"] },
              path: { type: "string", description: "For write and delete." },
              content: { type: "string", description: "Full file text, for write (and optionally move)." },
              from: { type: "string", description: "For move." },
              to: { type: "string", description: "For move." },
            },
            required: ["op"],
          },
        },
      },
      required: ["message", "changes"],
    },
  },
] as const;

function meta(e: IndexEntry): string {
  const parts = [e.type, e.status, e.certainty].filter(Boolean).join(", ");
  const tags = e.tags.length ? " " + e.tags.map((t) => `#${t}`).join(" ") : "";
  return `${parts ? ` [${parts}]` : ""}${tags}`;
}

function line(e: IndexEntry): string {
  return `• ${e.title}${meta(e)} — ${e.path}${e.summary ? `\n    ${e.summary}` : ""}`;
}

function syncNote(pending: number): string {
  return pending
    ? `\n(Index still syncing: ${pending} notes not indexed yet, so results may be incomplete. Calling any tool again continues the sync.)`
    : "";
}

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function callTool(vault: Vault, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    switch (name) {
      case "start_session":
        return await startSession(vault, args);
      case "read_notes":
        return await readNotes(vault, args);
      case "search":
        return await runSearch(vault, args);
      case "backlinks":
        return await runBacklinks(vault, args);
      case "save_changes":
        return await runSave(vault, args);
      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

async function startSession(vault: Vault, args: Record<string, unknown>): Promise<ToolResult> {
  const given = typeof args.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.today) ? args.today : undefined;
  const today = given ?? utcToday();
  const state = await vault.load();

  const core = Object.values(state.index.entries)
    .filter((e) => e.core && !isArchived(e.path))
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, 12);
  const dailyPath = `Daily/${today}.md`;
  const texts = await vault.readFiles(state, [...core.map((c) => c.path), dailyPath]);

  // Persist index drift (e.g. manual edits made in Obsidian) once per session.
  let synced = false;
  try {
    synced = await vault.syncIndex(state, "Sync vault index");
  } catch {
    /* non-fatal */
  }

  const out: string[] = [];
  out.push(`# Session start — ${today}${given ? "" : " (UTC; pass `today` for the user's local date)"}`);
  out.push(`Vault ${vault.repoName}: ${Object.keys(state.index.entries).length} notes indexed.${synced ? " Index synced." : ""}${syncNote(state.stale.length)}`);

  const due = dueItems(state.index, today);
  out.push("\n## Due and overdue (next 14 days)");
  if (!due.length) out.push("Nothing.");
  for (const d of due) {
    out.push(`- ${d.entry.type}: ${d.entry.title} — ${d.overdue ? "OVERDUE " : ""}${d.when} — ${d.entry.path}`);
  }

  out.push("\n## Core notes");
  if (!core.length) out.push("None found. Core notes carry `core: true` in their frontmatter.");
  for (const c of core) {
    out.push(`\n### ${c.path}\n${texts.get(c.path) ?? "(could not be read)"}`);
  }

  out.push(`\n## Today's daily note (${dailyPath})`);
  out.push(texts.get(dailyPath) ?? "None yet today.");
  return ok(out.join("\n"));
}

async function readNotes(vault: Vault, args: Record<string, unknown>): Promise<ToolResult> {
  const wanted = Array.isArray(args.notes) ? args.notes.filter((n): n is string => typeof n === "string") : [];
  if (!wanted.length) return fail("Give at least one title or path in `notes`.");
  if (wanted.length > 15) return fail("Max 15 notes per call.");
  const state = await vault.load();

  const resolved: { ask: string; path?: string }[] = wanted.map((ask) => {
    const looksLikePath = ask.includes("/") || ask.toLowerCase().endsWith(".md");
    if (looksLikePath) {
      const p = ask.replace(/^\/+/, "");
      const withExt = p.toLowerCase().endsWith(".md") ? p : `${p}.md`;
      return { ask, path: state.files.has(withExt) ? withExt : undefined };
    }
    return { ask, path: resolveTitle(state.index, ask)?.path };
  });
  const texts = await vault.readFiles(state, resolved.flatMap((r) => (r.path ? [r.path] : [])));

  const out: string[] = [];
  const missing: string[] = [];
  for (const r of resolved) {
    if (!r.path) {
      const sug = suggestTitles(state.index, r.ask);
      missing.push(`"${r.ask}"${sug.length ? ` (did you mean ${sug.map((s) => `"${s}"`).join(", ")}?)` : ""}`);
      continue;
    }
    out.push(`## ${r.path}\n${texts.get(r.path) ?? "(could not be read)"}`);
  }
  if (missing.length) out.push(`\nNot found: ${missing.join("; ")}`);
  if (state.stale.length) out.push(syncNote(state.stale.length));
  return ok(out.join("\n\n"));
}

async function runSearch(vault: Vault, args: Record<string, unknown>): Promise<ToolResult> {
  const state = await vault.load();
  const results = search(state.index, {
    query: typeof args.query === "string" ? args.query : undefined,
    type: typeof args.type === "string" ? args.type : undefined,
    tag: typeof args.tag === "string" ? args.tag : undefined,
    status: typeof args.status === "string" ? args.status : undefined,
    include_archive: args.include_archive === true,
    limit: typeof args.limit === "number" ? args.limit : undefined,
  });
  if (!results.length) return ok(`No matches.${syncNote(state.stale.length)}`);
  return ok(`${results.length} result(s):\n${results.map(line).join("\n")}${syncNote(state.stale.length)}`);
}

async function runBacklinks(vault: Vault, args: Record<string, unknown>): Promise<ToolResult> {
  const title = typeof args.title === "string" ? args.title : "";
  if (!title.trim()) return fail("`title` is required.");
  const state = await vault.load();
  const results = backlinks(state.index, title, args.include_archive === true);
  const exists = resolveTitle(state.index, title);
  const head = exists ? "" : `Note: no note titled "${title}" exists yet.\n`;
  if (!results.length) return ok(`${head}No notes link to "${title}".${syncNote(state.stale.length)}`);
  return ok(`${head}${results.length} note(s) link to "${title}":\n${results.map(line).join("\n")}${syncNote(state.stale.length)}`);
}

async function runSave(vault: Vault, args: Record<string, unknown>): Promise<ToolResult> {
  const message = typeof args.message === "string" ? args.message : "";
  const raw = Array.isArray(args.changes) ? (args.changes as Record<string, unknown>[]) : [];
  const changes: Change[] = raw.map((c, i) => {
    if (c.op === "write" && typeof c.path === "string" && typeof c.content === "string") {
      return { op: "write", path: c.path, content: c.content };
    }
    if (c.op === "delete" && typeof c.path === "string") return { op: "delete", path: c.path };
    if (c.op === "move" && typeof c.from === "string" && typeof c.to === "string") {
      return { op: "move", from: c.from, to: c.to, ...(typeof c.content === "string" ? { content: c.content } : {}) };
    }
    throw new Error(`changes[${i}] is malformed. Use {op:'write',path,content} | {op:'move',from,to,content?} | {op:'delete',path}.`);
  });
  const r = await vault.save(changes, message);
  const out = [`Saved in one commit: ${r.url}`];
  if (r.written.length) out.push(`Written (${r.written.length}): ${r.written.join("; ")}`);
  if (r.moved.length) out.push(`Moved: ${r.moved.join("; ")}`);
  if (r.deleted.length) out.push(`Deleted: ${r.deleted.join("; ")}`);
  if (r.unchanged.length) out.push(`Unchanged: ${r.unchanged.join("; ")}`);
  if (r.warnings.length) out.push(`\nWarnings:\n${r.warnings.map((w) => `- ${w}`).join("\n")}`);
  return ok(out.join("\n"));
}
