import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEntry, extractLinks, gitBlobSha, isIndexable, normalizePath, parseFrontmatter } from "../src/notes.ts";

test("parses inline arrays with quoted wikilinks, block arrays, booleans", () => {
  const { data, body } = parseFrontmatter(
    `---\ntype: thought\ncertainty: leaning\ntags: [area/mind, topic/stress]\norigin: ["[[2026-10-12-01]]", "[[2026-10-12-02]]"]\ncore: true\npart-of:\n  - "[[How I handle uncertainty]]"\n---\nBody here\n`,
  );
  assert.equal(data.type, "thought");
  assert.deepEqual(data.tags, ["area/mind", "topic/stress"]);
  assert.deepEqual(data.origin, ["[[2026-10-12-01]]", "[[2026-10-12-02]]"]);
  assert.equal(data.core, true);
  assert.deepEqual(data["part-of"], ["[[How I handle uncertainty]]"]);
  assert.equal(body, "Body here\n");
});

test("notes without frontmatter still parse", () => {
  const { data, body } = parseFrontmatter("Just text [[A]]");
  assert.deepEqual(data, {});
  assert.equal(body, "Just text [[A]]");
});

test("extracts links with aliases, headings and paths, deduped", () => {
  const links = extractLinks("See [[Maria]], [[Maria|my friend]], [[Move to Lisbon#Why]], [[Entities/People/Ana]] and [[maria]].");
  assert.deepEqual(links, ["Maria", "Move to Lisbon", "Ana"]);
});

test("summary skips headings and never includes History", () => {
  const e = buildEntry(
    "Thoughts/Open loops.md",
    `---\ntype: thought\n---\nMost of my stress comes from [[Open loops]].\n\n## History\n- 2026-01-01: old version that should not appear\n`,
    "abc",
  );
  assert.equal(e.summary, "Most of my stress comes from Open loops.");
  assert.equal(e.title, "Open loops");
  assert.deepEqual(e.links, ["Open loops"]);
});

test("entry picks up task fields", () => {
  const e = buildEntry("Operations/Tasks/Renew passport.md", `---\ntype: Task\nstatus: Active\ndue: 2026-10-20\ntags: [area/home]\n---\nRenew it.`, "x");
  assert.equal(e.type, "task");
  assert.equal(e.status, "active");
  assert.equal(e.due, "2026-10-20");
});

test("which files are indexed", () => {
  assert.equal(isIndexable("Thoughts/A.md"), true);
  assert.equal(isIndexable("README.md"), false);
  assert.equal(isIndexable("System/Tag index.md"), false);
  assert.equal(isIndexable(".agent/Notes.md"), false);
  assert.equal(isIndexable("Daily/2026-10-12.md"), true);
  assert.equal(isIndexable("Thoughts/image.png"), false);
});

test("path safety", () => {
  assert.equal(normalizePath("/Thoughts//A.md"), "Thoughts/A.md");
  assert.throws(() => normalizePath("../etc/passwd"));
  assert.throws(() => normalizePath(".git/config"));
  assert.throws(() => normalizePath("Thoughts/Bad:Name.md"));
});

test("git blob sha matches git", async () => {
  // `printf 'hello\n' | git hash-object --stdin`
  assert.equal(await gitBlobSha("hello\n"), "ce013625030ba8dba906f756967f9e9ca394464a");
});
