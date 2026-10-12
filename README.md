# Second Brain connector

A small, free-to-run server that lets **Claude** (the free plan, in the phone app and on claude.ai) read and write your **second-brain vault**: an Obsidian vault stored in a private GitHub repo. You chat with Claude; it files your thoughts, keeps your goals and decisions current, and uses the vault as its memory of you.

```
You ─ Claude app ─ this connector (Cloudflare Worker, free) ─ private GitHub repo ─ Obsidian on your computer
```

Nothing here is shared. Each person deploys their own copy, so your vault only ever passes through your own Cloudflare account, your own GitHub repo and Claude.

## Setup (about 15 minutes, no code)

You need free accounts at [GitHub](https://github.com), [Cloudflare](https://dash.cloudflare.com/sign-up) and [Claude](https://claude.ai).

### 1. Create your private vault repo

Open the **second-brain-vault** template repo on GitHub, click **Use this template → Create a new repository**, name it (for example `my-vault`) and choose **Private**.

### 2. Create a GitHub token for the connector

GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.

- **Repository access:** *Only select repositories* → your vault repo.
- **Permissions → Repository permissions → Contents:** *Read and write*.
- Set an expiry you'll remember (the connector stops working when it expires).

Copy the token. You'll paste it once in the next step.

### 3. Deploy the connector

Click the button (replace `YOUR-GITHUB-USERNAME` with the account that hosts this repo before publishing it):

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YOUR-GITHUB-USERNAME/second-brain-connector)

Cloudflare copies this repo to your GitHub account, creates the storage it needs, and asks for three values:

| Value | What to enter |
| --- | --- |
| `GITHUB_TOKEN` | The token from step 2 |
| `GITHUB_REPO` | Your vault repo as `owner/name`, for example `jane/my-vault` |
| `OWNER_PASSPHRASE` | A passphrase of **12+ characters** that only you know. You'll type it once when Claude connects |

When it finishes you get an address like `https://second-brain-connector.your-name.workers.dev`. Your connector URL is that address plus `/mcp`.

### 4. Connect Claude

On claude.ai: **Customize → Connectors → Add custom connector**. Name it *Vault*, paste your connector URL (ending in `/mcp`), click **Connect**, and enter your passphrase on the page that opens.

Claude's free plan allows one custom connector, and this uses it. Connectors you add on the web also appear in the phone app.

### 5. Create the Claude Project

**Projects → New project**, call it *My vault*. In the project's instructions, paste the whole contents of `System/Agent instructions.md` from your vault. Do all your vault conversations inside this project, with the Vault connector switched on.

### 6. Open the vault in Obsidian (computer)

Clone your vault repo to your computer, open the folder as a vault in Obsidian, and install the **Obsidian Git** community plugin. Set it to pull and push automatically (every few minutes) so what Claude writes appears in Obsidian and your manual edits flow back.

### 7. First conversation

Say something like: *"Let's get started. Interview me a few questions at a time to fill in my current situation, my values, my main goals and the people who matter most, and save what I tell you."*

## What Claude can do through it

| Tool | Purpose |
| --- | --- |
| `start_session` | Reads the seven core notes, today's daily note, and tasks, reminders and events that are due |
| `read_notes` | Reads several notes by title in one call |
| `search` | Finds notes by words, type, tag or status |
| `backlinks` | Lists every note that links to a note |
| `save_changes` | Creates, edits, moves and deletes many notes in one git commit |

Every change is a git commit in your repo, so anything can be undone from GitHub or your computer.

## Limits to know about

- **Claude's free plan has usage caps.** A capture is a handful of tool calls, so a very busy day can hit the cap. Upgrading Claude changes nothing else in this setup.
- **Cloudflare's free plan allows 10 ms of CPU per request and 50 outbound calls per request.** The connector is built for that: it keeps a compact search index (`System/index.json`) in your repo, saves in one commit, and brings the index up to date gradually. It stays comfortable up to roughly 1,000 notes. Beyond that, move finished notes into `Archive/` (archived notes are still searchable on request) or switch the Worker to Cloudflare's paid plan.
- **Search matches words in titles, tags, links and a one-line summary of each note.** For the full text, Claude reads the note.
- **The 100,000 requests/day** Cloudflare allows is far more than you will use.

## Security

- The connector's address is public, but it answers only requests carrying an access token. Tokens are issued only after you type your passphrase on the connector's own page (five wrong tries locks that address out for 15 minutes). A passphrase shorter than 12 characters is refused.
- The GitHub token can reach only your vault repo. Keep that repo **private**.
- The connector stores only OAuth login records in Cloudflare KV. Note contents are never stored or logged there.
- To cut access off: delete the Worker in Cloudflare, or revoke the GitHub token.

## Troubleshooting

- **Claude says it can't see the vault tools.** Open a chat inside your Project and check the Vault connector is switched on for that chat. If it still doesn't appear, remove the connector and add it again. Custom connectors are newer and occasionally fail to surface their tools in a particular app version; try claude.ai in a browser to tell an app problem from a setup problem.
- **"Setup needed" on the sign-in page.** `OWNER_PASSPHRASE` is missing or shorter than 12 characters. Fix it in Cloudflare: Workers & Pages → your Worker → Settings → Variables and Secrets.
- **Tools return a GitHub error (401/403/404).** The token expired, lacks *Contents: Read and write*, or `GITHUB_REPO` is misspelled.
- **"has no commits".** The repo is empty. Create it from the vault template.
- **"Index still syncing".** Normal for a big vault the first time. Call a tool again and it continues.
- **A save warns about a title that would exist twice.** Note titles must be unique across the vault; ask Claude to pick a different title.

## Developing

```bash
npm install
npm test          # unit and integration tests (in-memory fake GitHub)
npm run typecheck
cp .dev.vars.example .dev.vars   # fill in real values, then:
npm run dev
```

`test/e2e/` contains a script that walks the full OAuth and MCP flow (registration, PKCE, passphrase page, token, tool calls) against `wrangler dev` with a fake GitHub server.

The connector implements MCP over Streamable HTTP in its stateless JSON form and the `initialize` handshake used by current Claude clients. Requests for the newer `server/discover` method are answered with a "method not found" error, which tells new clients to fall back to `initialize`.
