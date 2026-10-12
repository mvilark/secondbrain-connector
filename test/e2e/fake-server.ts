// Runs the in-memory fake GitHub as a real HTTP server so a locally running Worker can talk to it.
import http from "node:http";
import { FakeGitHub } from "../fake-github.ts";

const note = (type: string, body: string, extra = "") => `---\ntype: ${type}\n${extra}---\n${body}\n`;
const gh = new FakeGitHub({
  "Values/Values priority.md": note("value", "1. [[Honesty]]", "core: true\n"),
  "Values/Honesty.md": note("value", "I value telling the truth."),
  "Daily/2026-10-12.md": note("daily", "Started the vault."),
  "README.md": "# vault\n",
});

http
  .createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks).toString() : undefined;
    if (req.url === "/__debug/files") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ files: Object.keys(gh.files()), commits: gh.commitCount() }));
      return;
    }
    const r = await gh.fetch(`http://x${req.url}`, { method: req.method, body });
    res.statusCode = r.status;
    res.setHeader("content-type", "application/json");
    res.end(await r.text());
  })
  .listen(8799, "127.0.0.1", () => console.log("fake github on 8799"));
