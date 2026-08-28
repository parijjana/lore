// npm run sync — reconcile the archive between machines and rebuild the index if needed.
//
// The archive is written by more than one machine and nothing was pushing it, so the
// backup drifted the moment an agent called archive_lore. This closes that, and closes
// the merge question underneath it.
//
// The reconciliation rules, in one place:
//
//   * lore_archive.jsonl is line-oriented and mostly append-only, so a `union` merge
//     driver (.gitattributes) is the right resolution for a conflicting hunk: keep both
//     sides rather than asking a human to pick. Two machines archiving different findings
//     is not a conflict, it is just two findings.
//   * union merges can leave the same id twice. Ids minted by archive_lore are
//     host-prefixed and cannot collide, so this only happens for CONTENT-addressed ids —
//     when an entry was rewritten in place rather than appended, or when both machines
//     imported the same source file (harvest.js does both, by design). So after any merge
//     the file is deduplicated by id, keeping the newest timestamp.
//   * the file is then sorted by id, which makes the order canonical. Both machines
//     converge on the same byte order, so the NEXT merge has far less to conflict over.
//   * a malformed line aborts the whole run. Silently dropping a line you cannot parse
//     is data loss wearing the costume of a cleanup.
//
// The vector index is rebuilt only when the JSONL actually changed, tracked by a hash in
// .lore-index-hash (untracked) rather than by mtime, which a checkout perturbs freely.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { JSONL_PATH } = require("./paths.js");

const ARCHIVE_DIR = path.dirname(JSONL_PATH);
const HASH_FILE = path.join(ARCHIVE_DIR, ".lore-index-hash");
const LOCK_FILE = path.join(ARCHIVE_DIR, ".lore-sync.lock");
const PUSH = !process.argv.includes("--no-push");
const STALE_LOCK_MS = 15 * 60 * 1000;

// Sync is safe to invoke from a hook, which means it can be invoked while an earlier run
// is still going. Two concurrent runs would interleave a rewrite of the archive with a
// git operation on it, so take a lock and simply stand down if another holds it — a
// skipped sync costs nothing, the next one picks up the same work.
function acquireLock() {
    try {
        const age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
        if (age < STALE_LOCK_MS) {
            console.log(`Another sync is already running (lock held ${Math.round(age / 1000)}s). Standing down.`);
            process.exit(0);
        }
        console.log("Removing a stale lock from an interrupted run.");
        fs.unlinkSync(LOCK_FILE);
    } catch (e) {
        if (e.code !== "ENOENT") throw e;
    }
    fs.writeFileSync(LOCK_FILE, `${process.pid}\n`, { flag: "wx" });
    const release = () => { try { fs.unlinkSync(LOCK_FILE); } catch (e) {} };
    process.on("exit", release);
    process.on("SIGINT", () => { release(); process.exit(130); });
    process.on("SIGTERM", () => { release(); process.exit(143); });
}

function git(args, opts = {}) {
    return execFileSync("git", args, {
        cwd: ARCHIVE_DIR, encoding: "utf8",
        stdio: ["ignore", "pipe", opts.quiet ? "pipe" : "inherit"],
    }).trim();
}
function gitOk(args) {
    try { git(args, { quiet: true }); return true; } catch (e) { return false; }
}
function hashOf(file) {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function step(msg) { console.log(`\n== ${msg}`); }

// Deduplicate by id (newest timestamp wins) and sort by id. Returns a change summary.
function normalize() {
    const raw = fs.readFileSync(JSONL_PATH, "utf8");
    const lines = raw.split("\n").filter(l => l.trim());
    const entries = lines.map((line, i) => {
        try { return JSON.parse(line); }
        catch (e) {
            console.error(`\nFATAL: ${JSONL_PATH} line ${i + 1} is not valid JSON.`);
            console.error(`  ${line.slice(0, 160)}`);
            console.error("\nRefusing to continue — fix or remove the line by hand. Nothing was written.");
            process.exit(1);
        }
    });

    const byId = new Map();
    let duplicates = 0;
    for (const e of entries) {
        const id = e.id;
        if (!id) { console.error("FATAL: an entry has no id. Nothing was written."); process.exit(1); }
        const prev = byId.get(id);
        if (!prev) { byId.set(id, e); continue; }
        duplicates++;
        // Newest wins. Clocks across two machines are not perfectly ordered, so this is a
        // heuristic — it is recorded here rather than hidden in a one-liner.
        const keep = new Date(e.timestamp || 0) >= new Date(prev.timestamp || 0) ? e : prev;
        byId.set(id, keep);
    }

    const sorted = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const out = sorted.map(e => JSON.stringify(e)).join("\n") + "\n";
    const changed = out !== raw;
    if (changed) fs.writeFileSync(JSONL_PATH, out, "utf8");
    return { changed, duplicates, total: sorted.length };
}

function commitIfDirty(message) {
    if (!git(["status", "--porcelain"], { quiet: true })) return false;
    git(["add", "-A"]);
    git(["commit", "-q", "-m", message]);
    console.log(`   committed: ${message}`);
    return true;
}

function main() {
    if (!fs.existsSync(JSONL_PATH)) {
        console.error(`No archive at ${JSONL_PATH}. Nothing to sync.`);
        process.exit(1);
    }
    if (!gitOk(["rev-parse", "--git-dir"])) {
        console.error(`${ARCHIVE_DIR} is not a git repository.`);
        console.error("Set it up with:  git init && git remote add origin <private repo>");
        process.exit(1);
    }

    acquireLock();

    step("Normalizing local archive");
    let n = normalize();
    console.log(`   ${n.total} entries${n.duplicates ? `, ${n.duplicates} duplicate id(s) collapsed` : ""}`);
    commitIfDirty("Sync: local changes");

    const hasRemote = !!git(["remote"], { quiet: true });
    const hasUpstream = hasRemote && gitOk(["rev-parse", "--abbrev-ref", "@{upstream}"]);

    if (hasUpstream) {
        step("Pulling");
        // A merge, not a rebase: the union driver in .gitattributes is what makes two
        // machines' appends combine instead of conflict, and rebase would replay them
        // one commit at a time against a moving base for no benefit here.
        git(["pull", "--no-rebase", "--no-edit"]);

        step("Normalizing after merge");
        n = normalize();
        console.log(`   ${n.total} entries${n.duplicates ? `, ${n.duplicates} duplicate id(s) collapsed` : ""}`);
        commitIfDirty("Sync: normalize after merge");
    } else {
        console.log(`\n== No upstream branch — skipping pull${hasRemote ? "" : " (no remote configured)"}`);
    }

    step("Index");
    const current = hashOf(JSONL_PATH);
    const previous = fs.existsSync(HASH_FILE) ? fs.readFileSync(HASH_FILE, "utf8").trim() : null;
    if (current === previous) {
        console.log("   archive unchanged since last reindex — skipping");
    } else {
        console.log("   archive changed — reindexing");
        execFileSync("node", [path.join(__dirname, "reindex.js")], { stdio: "inherit", env: process.env });
        fs.writeFileSync(HASH_FILE, current + "\n", "utf8");
    }

    if (hasRemote && PUSH) {
        step("Pushing");
        git(["push"]);
    } else if (!PUSH) {
        console.log("\n== --no-push given, skipping push");
    }

    console.log("\nSync complete.");
}

main();
