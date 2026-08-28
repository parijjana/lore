# Multi-system runbook

How to run Lore across several machines — and several agents — sharing one archive.

Lore is a local stdio server with a local vector store, so "sharing an archive" means
syncing a file, not running a service. That is deliberate: there is no server to host, no
port to expose, and each machine keeps working when the others are off or offline.

---

## The two-repository split

| Repository | Contents | Visibility |
| :--- | :--- | :--- |
| **This one** | The server, the importer, the sync tool. | Whatever you like. |
| **Your data repo** | `lore_archive.jsonl` — the archive itself. | **Private.** |

They are separate on purpose. The archive is the accumulated technical knowledge of your
projects: it quotes real code, names real infrastructure, and records real mistakes. That is
not the same asset as the tool that reads it, it does not want the same visibility, and it
should not be entangled with the tool's release history.

This repository does **not** point at any particular data repo. Create your own — an empty
private repo on any host — and point `LORE_ARCHIVE_PATH` at your clone of it. Everything
below refers to it as *the data repo*.

**Track only the JSONL.** The `lore.lance/` directory beside it is a derived vector index:
binary, rewritten wholesale on every reindex, and reconstructible from the JSONL in seconds.
Committing it would bloat history for no recovery value.

---

## Before you start

Four things this document cannot tell you, because they differ per person and per machine.
Get them straight first — each one is a place a setup run stops dead.

1. **The two repository URLs.** This document names neither (see the split above). If you
   are an agent doing this on someone's behalf and were not given them, ask, or look them
   up — e.g. `gh repo list <account>`. Do not guess.
2. **Which shell.** Every command below is POSIX shell. On Windows use **Git Bash**, which
   ships with Git for Windows. In PowerShell the heredocs (`<<'EOF'`) and `~` expansion do
   not work; if you must use PowerShell, write those files with an editor and use absolute
   paths everywhere.
3. **Node 18+ and git must be on PATH.** Check: `node --version && git --version`.
   The data repo is **private**, so this machine also needs credentials that can read *and
   push* to it — `gh auth login`, or an SSH key on the account. A clone that succeeds is not
   proof of push access; `npm run sync` is where it would fail.
4. **Where this machine keeps its projects**, if you intend to import lessons files. The
   importer defaults to `~/code/projects` and machines disagree about this — set
   `LORE_PROJECTS_ROOT` if yours differs. Skip entirely if this is not the first machine.

**The first command touching the model downloads ~90 MB** (`Xenova/all-MiniLM-L6-v2`), so
`npm test` and the first `reindex` need network and are slow. Everything afterwards is local
and offline.

---

## First machine

```bash
# 1. The tool
git clone <this-repo> ~/code/lore
cd ~/code/lore && npm install
npm test                      # self-contained; uses a throwaway archive

# 2. The data repo
git clone <your-private-data-repo> ~/.lore     # or: mkdir ~/.lore && git init

# 3. Tell git how to merge the archive  (in ~/.lore)
cat > ~/.lore/.gitattributes <<'EOF'
lore_archive.jsonl merge=union
lore_archive.jsonl -text
EOF
cat > ~/.lore/.gitignore <<'EOF'
lore.lance/
.lore-index-hash
EOF

# 4. Import whatever lessons files you already have, then build the index
cd ~/code/lore
npm run harvest       # optional: only if you have a file-based lessons corpus
npm run reindex
npm run sync

# 5. Register with your agent(s)
claude mcp add lore -s user -- node ~/code/lore/index.js
```

Those two `.gitattributes` lines are load-bearing; see [Why the merge works](#why-the-merge-works).

---

## Every additional machine

Shorter than the first, and the differences matter:

```bash
git clone <this-repo> ~/code/lore
cd ~/code/lore && npm install

git clone <your-private-data-repo> ~/.lore

npm run reindex        # build THIS machine's local vector index from the JSONL
npm run sync           # confirm the loop works end to end

# absolute path — `~` is not expanded inside this argument on every shell
claude mcp add lore -s user -- node "$HOME/code/lore/index.js"
```

**Do not run `npm run harvest` here, and do not create `.gitattributes` or `.gitignore`.**
Both are steps for the *first* machine only:

- The archive already exists. `harvest` imports lessons **files**, and this machine's set of
  lessons files is probably not the same as the machine that seeded the archive. Importing
  is safe — it only adds and updates — but it is pointless work unless this machine is where
  you actually edit lessons files. It is never necessary to get Lore running.
- `.gitattributes` and `.gitignore` arrive with the clone. Rewriting them by hand risks
  dropping the `-text` line, which is what stops Git for Windows corrupting the merge.

`npm run reindex` **is** required. The index is gitignored, so a fresh clone has the archive
and no vectors, and `query_lore` would return nothing until you build them.

### Verify the machine is actually participating

```bash
npm run sync                 # expect: "archive unchanged since last reindex — skipping"
```

Then ask the server for `get_lore_health`. The **Recorded on:** breakdown should list this
machine once it has archived anything. If a machine never appears there, it is reading the
archive but not contributing to it.

To confirm merging works before you trust it, archive a throwaway finding on each of two
machines, `npm run sync` on both in turn, and check that both survive on both. It should
require no conflict resolution.

---

## Daily loop

```bash
npm run sync
```

Run it before a work session and after archiving anything. It does, in order: normalize →
commit → pull → normalize → reindex only if the archive changed → push.

`archive_lore` writes to the JSONL immediately but does **not** commit, so until you sync,
a finding exists on one machine only.

Sync is safe to run from a hook or a scheduler. It takes a lock and stands down if another
run is already in progress, so overlapping invocations cost a skipped run rather than a
corrupted archive. Backgrounding it is fine — it is the recommended shape, since a run that
has to rebuild the index is slow enough to be worth not waiting on:

```bash
node ~/code/lore/sync.js >> ~/.lore/sync.log 2>&1
```

Invoke `sync.js` directly rather than through `npm run` when the caller's working
directory is not the repo — `npm run` resolves scripts from the cwd and fails elsewhere.
Each run stamps the log with a timestamp.

In Claude Code, wire it to the `SessionStart` and `Stop` hooks with `"async": true` so it
never blocks a session. Add `sync.log` to the data repo's `.gitignore`: the log is written
into the archive directory, so otherwise every run dirties the repo and the next run
commits the log.

### Platform notes

- **Windows.** Git for Windows defaults to `core.autocrlf=true`. The `-text` attribute above
  is what stops it rewriting the archive's line endings; without it every line differs from
  every other machine's copy and each sync becomes a whole-file conflict. Paths in commands
  above become `%USERPROFILE%\.lore` etc.
- **First run downloads the embedding model** (~90 MB, `Xenova/all-MiniLM-L6-v2`). It is
  cached afterwards, but the first `reindex` or first query on a new machine is slow and
  needs network. Everything after that is local and offline.
- **Machine name.** Detected automatically (`.local` suffix stripped). Override with
  `LORE_HOST` if two machines would otherwise report the same name.

---

## Why the merge works

The archive is one JSON object per line, appended to independently by machines that never
talk to each other. Four properties keep that reconcilable:

1. **`merge=union`.** Two machines archiving different findings is not a conflict, it is two
   findings. A conflicting hunk keeps both sides instead of stopping for a human.
2. **Ids that cannot collide.** Ids minted by `archive_lore` are prefixed with a hash of the
   machine name, so two machines can never mint the same id.
3. **Dedup by id after every merge.** Union can leave the same id twice — but only for
   *content-addressed* ids, which are deliberately identical across machines (see below).
   Sync collapses those, newest timestamp winning. That last part is a heuristic: clocks on
   two machines are not perfectly ordered.
4. **Canonical order.** Entries are sorted by id after every sync, so both machines converge
   on the same byte order and the next merge has far less to conflict over.

**The one deliberate exception to rule 2:** ids produced by `npm run harvest` are derived
from the source file's path, *not* the machine, so both machines importing the same lessons
file agree on one id. That agreement is what stops a shared corpus from landing once per
machine. Rule 3 is what makes that safe.

Entries also carry `origin`, which decides who may modify them:

| `origin` | Written by | Rule |
| :--- | :--- | :--- |
| `file` | `npm run harvest`, from a Markdown lessons file | The importer owns these and updates them in place. Edit the source file, not the entry. It never deletes them unless you pass `--prune`. |
| `agent` | `archive_lore` | Live only in Lore. The importer never touches them. |

---

## When something goes wrong

The archive is a git repository containing a plain text file. Almost every failure is
recoverable with `git revert` and `npm run reindex`.

| Symptom | Cause and fix |
| :--- | :--- |
| `query_lore` returns nothing on a new machine | No local index. `npm run reindex`. |
| Sync aborts naming a line number | A malformed line. It refuses to write anything rather than silently dropping data. Fix the line by hand, re-run. |
| Every sync is a whole-file conflict | Missing `-text`; a machine converted line endings. Add it, renormalize, commit. |
| Duplicate lessons, one per machine | Two machines' harvest disagreed on ids — usually different `LORE_PROJECTS_ROOT` shapes, so the source path differs. Make the layouts match, re-harvest, sync. |
| An entry you edited in Lore reverted | It was `origin: file`; harvest replaced it. Edit the Markdown source instead. |
| Index disagrees with the archive | `npm run reindex`. The index is always disposable. |
| Total loss of a machine | Clone both repos, `npm run reindex`. Nothing else is machine-specific. |
| `Another sync is already running` | Expected when syncs overlap. Harmless — the next run does the work. A lock older than 15 minutes is treated as stale and cleared. |
