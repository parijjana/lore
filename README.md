# Lore

A cross-project technical knowledge archive, exposed as an MCP stdio server and powered by
local **LanceDB semantic search**. Agents archive and query technical lessons across
workspaces, giving them a persistent memory of what was already learned the hard way.

Host-agnostic: it speaks plain MCP over stdio and works with any MCP client (Claude Code,
Gemini CLI, Codex).

## Features

- **Semantic Search:** Uses local CPU embeddings (`all-MiniLM-L6-v2`) to find lessons by *meaning* and *intent*, not just keywords.
- **Cross-Project Memory:** Share insights between unrelated projects automatically.
- **Hierarchical Knowledge:** Supports `raw` observations and `synthesized` Best Practices with full provenance tracking.
- **Attribution:** Every entry records the machine that captured it and who is responsible for it, so a raw finding keeps its observer and a synthesized entry names its synthesizer.
- **Proactive Wisdom:** Agents automatically check the archive for relevant patterns before proposing solutions.
- **Recursive Audit:** Agents automatically trace the ancestry of synthesized rules (up to 3 levels deep) to ensure no contradictions.
- **Admin Isolation:** Destructive tools (`update_lore`, `delete_lore`) are hidden by default and only available in a dedicated "Maintenance Mode."

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or higher
- An MCP client

## Installation

```bash
git clone https://github.com/parijjana/lore.git
cd lore
npm install
npm test          # self-contained; uses a throwaway archive
```

Register with Claude Code:

```bash
claude mcp add lore -s user -- node /absolute/path/to/lore/index.js
```

`install.sh` / `install.ps1` are **Gemini-CLI-specific** — they refuse to run without
`~/.gemini/settings.json` and register the server under the key `lessons`. Use them only
with Gemini CLI; every other host should register the command directly, as above.

> **Running Lore on more than one machine?** See
> **[MULTI_SYSTEM_RUNBOOK.md](./MULTI_SYSTEM_RUNBOOK.md)** — setup per machine, the daily
> loop, how concurrent archives from different machines reconcile, and recovery.

## Where the archive lives

| Path | What it is |
| :--- | :--- |
| `~/.lore/lore_archive.jsonl` | **The durable copy.** Append-only, human-readable, diffable. |
| `~/.lore/lore.lance/` | Disposable vector index. `npm run reindex` rebuilds it from the JSONL. |

Override the location with `LORE_ARCHIVE_PATH` (the `.lance` directory follows it).

Keep `~/.lore/` in its own **private** repository, separate from this one — it holds the
actual archive, which is a different asset from the tool that reads it. Track the JSONL;
ignore the index. Recovery from total loss:

```bash
git clone <your-private-data-repo> ~/.lore
cd /path/to/lore && npm install && npm run reindex
```

Verified: a clone containing no `lore.lance/` reindexes to an archive that returns identical
results. Losing the JSONL loses the archive; losing the index costs a reindex. See the
[multi-system runbook](./MULTI_SYSTEM_RUNBOOK.md) for the full setup.

## Syncing between machines

`archive_lore` appends to the JSONL but does not commit, so the backup drifts as soon as an
agent archives anything. `npm run sync` closes that and the merge question underneath it:

```bash
npm run sync            # normalize, commit, pull, reindex if changed, push
npm run sync -- --no-push
```

It does, in order: deduplicate by id and sort (making the byte order canonical, so the next
merge has less to conflict over) → commit → `git pull --no-rebase` → normalize again → rebuild
the vector index **only if the JSONL actually changed** → push.

The reconciliation rules:

- `.gitattributes` marks the archive `merge=union`. Two machines archiving different findings
  is not a conflict, it is two findings, so a conflicting hunk keeps both sides.
- Union merges can leave the same id twice, which happens when an entry was rewritten in
  place rather than appended (`harvest.js` does this). Sync deduplicates by id afterwards,
  **keeping the newest timestamp** — a heuristic, since clocks across two machines are not
  perfectly ordered.
- A line that will not parse **aborts the run** with the line number, writing nothing and
  exiting non-zero. Silently dropping a line you cannot parse is data loss dressed as a
  cleanup.
- Reindex is triggered by a content hash in `.lore-index-hash` (untracked), not mtime, which
  a checkout perturbs freely.

Verified against a real two-machine divergence: both machines' findings survive, and a
same-id edit on both sides collapses to the newer one without a conflict prompt.

## Importing the file-based lessons corpora

Lore is the intended **single source of truth** for engineering lessons. It is not there yet:
the `lessons_learnt/` files stay canonical until Telarch is live and working on both
machines, because until then nothing supervises Lore or guarantees it is running where a
lesson gets written. Until that day the two coexist and this importer is the bridge — so it
is built to be re-run, not run once.

```bash
npm run harvest && npm run reindex
```

Sources are **discovered, not configured** — absolute paths differ between machines, so a
config file would need per-machine editing and would drift. The convention is:

```
<projects-root>/*/lessons_learnt/*.md
<projects-root>/*/lessons_learned/*.md     # both spellings are in use
```

`<projects-root>` defaults to `~/code/projects`; override with `LORE_PROJECTS_ROOT`. The
project directory name becomes the entry's `project` (`project_docs` maps to
`cross-project`).

What makes it safe to re-run, repeatedly, from any agent on either machine:

| Property | Why it is needed |
| :--- | :--- |
| Ids namespaced by source (`sha1("<project>/<slug>")`) | `database_batching.md` is exactly the kind of filename two projects will both have. Keying on the filename alone lets one project silently overwrite another's lesson. |
| Ids **not** host-prefixed | Both machines import the same corpus and must agree on one id per lesson, or every lesson lands once per machine. |
| Stable across runs | Re-importing updates in place instead of duplicating. |
| Never deletes by default | A lesson with no source file on this machine is reported and **kept**. "Deleted upstream" and "this machine doesn't have that project" are indistinguishable locally, and guessing wrong destroys another machine's work and syncs the deletion. Use `--prune` when you know the deletions are real, `--dry-run` to preview. |
| `origin: "file"` vs `origin: "agent"` | The importer only ever touches rows it owns. Findings archived by an agent are never modified or removed. |
| Removals reported, archive in git | A bad run is visible and revertible. |

**Do not edit a file-derived entry inside Lore** (via `update_lore`) while the files are
canonical — the next `harvest` will overwrite it. Edit the Markdown and re-import.

## Attribution

Every entry carries two provenance fields:

| Field | Meaning | Set by |
| :--- | :--- | :--- |
| `host` | The machine that recorded the entry. | **Automatic.** Callers cannot set it — that is the point: it stays trustworthy when two machines merge into one archive. Override the detected name with `LORE_HOST`. |
| `author` | Who is responsible for the content. On a `raw` finding, the observer; on a `synthesized` entry, **the synthesizer**. | The `author` argument to `archive_lore`. Defaults to `LORE_AUTHOR`, else `git config --global user.name`, else the OS username. |

Ids minted by `archive_lore` are prefixed with a short hash of the machine name
(`bef6f4-1badf8c9-...`), so two machines can never mint the same id and an id says where it
came from even when read in isolation.

**Ids derived from content are deliberately not prefixed.** `harvest.js` derives its ids from
the source filename precisely so both machines importing the same lessons file agree on one
id — that is what keeps a shared corpus from landing once per machine. Prefixing those would
turn one lesson into N copies, which is the opposite of what the prefix is for.

The author/host split is what makes the raw → synthesized promotion auditable: the raw findings keep the
attribution of whoever observed them, while the synthesized entry names whoever distilled it.
An agent that consolidates should pass its own name:

```json
{ "type": "synthesized", "author": "claude-opus-5", "source_ids": ["...", "..."] }
```

`query_lore` accepts `author` and `host` filters, and `get_lore_health` breaks the archive
down by both — which is how you notice that one machine has stopped contributing, or that a
merge silently dropped one side.

## Admin Mode (Maintenance)

To update or delete lessons, you must enable Admin Mode by setting an environment variable:

Set `KNOWLEDGE_ADMIN_MODE=true` in the server's environment; `update_lore` and
`delete_lore` then appear in the tool list. They are hidden entirely when it is unset.

## Technical Details

- **Database:** LanceDB (Serverless, local file-based).
- **Embeddings:** Local CPU-based (Transformers.js).
- **Backup:** A human-readable `lore_archive.jsonl` is maintained alongside the binary
  vector store, and is the source of truth for `reindex.js`.
- **Manifest:** `mcp-server.yaml` (schema v1) describes the server for a supervising hub.
  Note the 30s health timeout: cold start loads the embedding model before serving.

## License

ISC License - See [LICENSE](./LICENSE) for details.
