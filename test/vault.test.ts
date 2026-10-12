import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { FakeGitHub } from "./fake-github.ts";
import { GitHub } from "../src/github.ts";
import { Vault, clearVaultCache } from "../src/vault.ts";
import { callTool } from "../src/tools.ts";

const note = (type: string, body: string, extra = "") => `---\ntype: ${type}\n${extra}---\n${body}\n`;

function seedFiles(): Record<string, string> {
  return {
    "Values/Values priority.md": note("value", "1. [[Honesty]]\n2. [[Health]]", "core: true\n"),
    "Values/Honesty.md": note("value", "I value telling the truth.", "certainty: settled\ntags: [area/mind]\n"),
    "Goals/Active goals.md": note("goal", "- [[Run a half marathon]]", "core: true\n"),
    "Goals/Run a half marathon.md": note("goal", "Train for October.", "status: active\ntags: [area/health]\n"),
    "Operations/Tasks/Renew passport.md": note("task", "Book the appointment.", "status: active\ndue: 2026-10-10\n"),
    "Operations/Events/Dentist.md": note("event", "Cleaning.", "status: scheduled\ndate: 2026-10-20\n"),
    "Operations/Tasks/Old thing.md": note("task", "Done long ago.", "status: done\ndue: 2026-01-01\n"),
    "Daily/2026-10-12.md": note("daily", "Today I ran 5k, see [[Run a half marathon]]."),
    "Entities/People/Maria.md": note("person", "My friend. We talked about [[Honesty]]."),
    "System/Tag index.md": "# Tag index\n",
    "README.md": "# vault\n",
  };
}

let gh: FakeGitHub;
let vault: Vault;
const setup = (files = seedFiles()) => {
  clearVaultCache();
  gh = new FakeGitHub(files);
  vault = new Vault(new GitHub("t", "me/vault", "https://api.github.com", gh.fetch as typeof fetch));
};
beforeEach(() => setup());

const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join("\n");

test("start_session returns core notes, daily note and due items, and syncs the index", async () => {
  const r = await callTool(vault, "start_session", { today: "2026-10-12" });
  const t = text(r);
  assert.ok(!r.isError, t);
  assert.match(t, /Values\/Values priority\.md/);
  assert.match(t, /Goals\/Active goals\.md/);
  assert.match(t, /Today I ran 5k/);
  assert.match(t, /OVERDUE 2026-10-10 — Operations\/Tasks\/Renew passport\.md/);
  assert.match(t, /event: Dentist — 2026-10-20/);
  assert.doesNotMatch(t, /Old thing/); // done tasks are not due
  assert.match(t, /Index synced/);
  assert.ok(gh.files()["System/index.json"], "index.json was committed");
  assert.equal(gh.commitCount(), 2); // seed + index sync
});

test("search filters by type, tag and words and skips archive", async () => {
  await callTool(vault, "start_session", {});
  let t = text(await callTool(vault, "search", { query: "marathon" }));
  assert.match(t, /Run a half marathon/);
  t = text(await callTool(vault, "search", { type: "task" }));
  assert.match(t, /Renew passport/);
  t = text(await callTool(vault, "search", { tag: "area" }));
  assert.match(t, /Honesty/);
  assert.match(t, /Run a half marathon/);
});

test("backlinks use the index, no extra calls to GitHub when warm", async () => {
  await callTool(vault, "start_session", {});
  const before = gh.calls;
  const t = text(await callTool(vault, "backlinks", { title: "Honesty" }));
  assert.match(t, /Maria/);
  assert.match(t, /Values priority/);
  assert.ok(gh.calls - before <= 1, `expected only the head check, used ${gh.calls - before} calls`);
});

test("read_notes resolves titles and paths and suggests near matches", async () => {
  const t = text(await callTool(vault, "read_notes", { notes: ["Honesty", "System/Tag index.md", "Honest"] }));
  assert.match(t, /## Values\/Honesty\.md/);
  assert.match(t, /I value telling the truth/);
  assert.match(t, /## System\/Tag index\.md/);
  assert.match(t, /Not found: "Honest" \(did you mean "Honesty"\?\)/);
});

test("save_changes makes exactly one commit, updates index, reports warnings", async () => {
  await callTool(vault, "start_session", {});
  const commitsBefore = gh.commitCount();
  const r = await callTool(vault, "save_changes", {
    message: "Capture 2026-10-12-01",
    changes: [
      { op: "write", path: "Raw inputs/2026-10-12-01.md", content: note("raw-input", "> I want to live near nature.") },
      { op: "write", path: "Principles/I need daily access to nature.md", content: note("principle", "I need nature. Ties to [[Move to Lisbon]] and [[Honesty]].", "certainty: tentative\n") },
      { op: "write", path: "Thoughts/untyped.md", content: "no frontmatter here" },
    ],
  });
  const t = text(r);
  assert.ok(!r.isError, t);
  assert.equal(gh.commitCount(), commitsBefore + 1);
  assert.match(t, /Links with no note yet: \[\[Move to Lisbon\]\]/);
  assert.match(t, /Thoughts\/untyped\.md: no "type" property/);
  assert.ok(gh.files()["Principles/I need daily access to nature.md"]);
  const found = text(await callTool(vault, "search", { query: "nature" }));
  assert.match(found, /I need daily access to nature/);
  const idx = JSON.parse(gh.files()["System/index.json"]);
  assert.ok(idx.entries["Principles/I need daily access to nature.md"]);
});

test("identical rewrite is a no-op and makes no commit", async () => {
  await callTool(vault, "start_session", {});
  const before = gh.commitCount();
  const r = await callTool(vault, "save_changes", {
    message: "noop",
    changes: [{ op: "write", path: "Values/Honesty.md", content: seedFiles()["Values/Honesty.md"] }],
  });
  assert.match(text(r), /Unchanged/);
  assert.equal(gh.commitCount(), before);
});

test("duplicate titles are rejected and nothing is saved", async () => {
  await callTool(vault, "start_session", {});
  const before = gh.commitCount();
  const r = await callTool(vault, "save_changes", {
    message: "dup",
    changes: [{ op: "write", path: "Thoughts/Honesty.md", content: note("thought", "dup") }],
  });
  assert.equal(r.isError, true);
  assert.match(text(r), /would exist twice/);
  assert.equal(gh.commitCount(), before);
});

test("archiving a note moves it, keeps the title, and hides it from search", async () => {
  await callTool(vault, "start_session", {});
  const r = await callTool(vault, "save_changes", {
    message: "Archive done task",
    changes: [
      { op: "move", from: "Operations/Tasks/Old thing.md", to: "Archive/Operations/Tasks/Old thing.md", content: note("task", "Done long ago.", "status: archived\n") },
    ],
  });
  assert.ok(!r.isError, text(r));
  assert.ok(gh.files()["Archive/Operations/Tasks/Old thing.md"]);
  assert.equal(gh.files()["Operations/Tasks/Old thing.md"], undefined);
  assert.match(text(await callTool(vault, "search", { query: "Old thing" })), /No matches/);
  assert.match(text(await callTool(vault, "search", { query: "Old thing", include_archive: true })), /Archive\/Operations\/Tasks\/Old thing\.md/);
});

test("move without content keeps the text and updates the index", async () => {
  await callTool(vault, "start_session", {});
  const r = await callTool(vault, "save_changes", {
    message: "rename",
    changes: [{ op: "move", from: "Entities/People/Maria.md", to: "Entities/People/Maria (university).md" }],
  });
  assert.ok(!r.isError, text(r));
  assert.equal(gh.files()["Entities/People/Maria (university).md"], seedFiles()["Entities/People/Maria.md"]);
  assert.match(text(await callTool(vault, "search", { query: "university" })), /Maria \(university\)/);
});

test("manual edits made outside the connector are picked up", async () => {
  await callTool(vault, "start_session", {});
  gh.manualCommitSync({
    "Thoughts/Written in Obsidian.md": note("thought", "I typed this by hand about [[Honesty]]."),
    "Values/Honesty.md": note("value", "Honesty, edited by hand to mention kindness."),
  });
  const t = text(await callTool(vault, "search", { query: "kindness" }));
  assert.match(t, /Honesty/);
  assert.match(text(await callTool(vault, "search", { query: "by hand" })), /Written in Obsidian/);
  gh.manualCommitSync({ "Thoughts/Written in Obsidian.md": null });
  assert.match(text(await callTool(vault, "search", { query: "Written in Obsidian" })), /No matches/);
});

test("a concurrent push during save is retried transparently", async () => {
  await callTool(vault, "start_session", {});
  gh.failNextRefUpdate = true;
  const r = await callTool(vault, "save_changes", {
    message: "race",
    changes: [{ op: "write", path: "Thoughts/Race.md", content: note("thought", "survived a race") }],
  });
  assert.ok(!r.isError, text(r));
  const files = gh.files();
  assert.ok(files["Thoughts/Race.md"]);
  assert.ok(files["Thoughts/Concurrent edit.md"], "the other writer's file is preserved");
});

test("a big vault is indexed gradually and stays under 50 subrequests per call", async () => {
  const files = seedFiles();
  for (let i = 0; i < 90; i++) files[`Thoughts/Thought ${i}.md`] = note("thought", `Idea number ${i} about topic${i % 7}`, `tags: [topic/t${i % 7}]\n`);
  setup(files);
  let maxCalls = 0;
  let last = "";
  for (let i = 0; i < 6; i++) {
    const before = gh.calls;
    last = text(await callTool(vault, "start_session", { today: "2026-10-12" }));
    maxCalls = Math.max(maxCalls, gh.calls - before);
    if (!/Index still syncing/.test(last)) break;
  }
  assert.doesNotMatch(last, /Index still syncing/);
  assert.ok(maxCalls <= 50, `used ${maxCalls} calls in one tool call`);
  const t = text(await callTool(vault, "search", { query: "topic3", limit: 40 }));
  assert.match(t, /Thought 3\b/);
  // a save on a fully synced big vault is cheap
  const before = gh.calls;
  await callTool(vault, "save_changes", { message: "x", changes: [{ op: "write", path: "Thoughts/New.md", content: note("thought", "new") }] });
  assert.ok(gh.calls - before <= 6, `save used ${gh.calls - before} calls`);
});

test("path traversal and index writes are refused", async () => {
  await callTool(vault, "start_session", {});
  for (const path of ["../x.md", ".git/config", "System/index.json"]) {
    const r = await callTool(vault, "save_changes", { message: "bad", changes: [{ op: "write", path, content: "x" }] });
    assert.equal(r.isError, true, path);
  }
});
