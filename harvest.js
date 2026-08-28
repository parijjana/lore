// Import the file-based lessons corpus into the Lore archive.
//
// Rewritten 2026-08-27. The previous version read `~/.gemini/tmp/<project>/memory/*.md`
// (a corpus that no longer exists), used hardcoded Windows paths, and appended to
// `lessons_archive.jsonl` — a file the server never reads. It could only ever no-op.
//
// Source of truth is now `~/code/projects/project_docs/lessons_learnt/`, override with
// LESSONS_DIR. Writes to the same JSONL the server reads (paths.js); run `reindex.js`
// afterwards to rebuild the vectors.
//
// Re-runnable: ids are derived from the filename, so a second run replaces rather than
// duplicates. The original appended random UUIDs and would double the corpus each time.

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { JSONL_PATH } = require("./paths.js");
const { hostName, defaultAuthor } = require("./identity.js");

const LESSONS_DIR = process.env.LESSONS_DIR ||
    path.join(os.homedir(), "code", "projects", "project_docs", "lessons_learnt");

// The corpus has an open-ended heading vocabulary ("## The part that is smaller than it
// looks", "## Two traps in the wiring"), so an allowlist of solution headings cannot work.
// Only the problem-side headings are enumerated; everything else is solution material.
const PROBLEM_HEADINGS = ["symptom", "the trap", "root cause", "problem",
                          "why a shipped mac app gives false confidence"];
const SUMMARY_HEADINGS = ["tl;dr"];

function categoryFor(slug) {
    const rules = [
        [/^flutter-/, "flutter"],
        [/^ios-/, "ios"],
        [/^appstore-|^apple-/, "appstore"],
        [/^cloudflare-/, "infrastructure"],
        [/^claude-code-/, "agent-workflow"],
        [/^web-/, "web"],
    ];
    for (const [re, cat] of rules) if (re.test(slug)) return cat;
    return "general";
}

// Split a document into ordered [heading, body] pairs at the h2 level. Deeper headings
// stay inside their parent section so structure survives the round trip.
function sections(markdown) {
    const out = [];
    let current = null;
    for (const line of markdown.split("\n")) {
        const h = line.match(/^##\s+(.*?)\s*$/);
        if (h) {
            current = { heading: h[1].replace(/[`*]/g, "").trim(), body: "" };
            out.push(current);
            continue;
        }
        if (line.startsWith("# ")) { current = null; continue; }
        if (current) current.body += line + "\n";
    }
    return out;
}

// Headings carry qualifiers ("## Symptom (the one you will get if you skip this)"), so
// match on prefix rather than equality.
function matches(heading, list) {
    const h = heading.toLowerCase();
    return list.some(w => h === w || h.startsWith(w + " ") || h.startsWith(w + " ("));
}

function render(secs) {
    return secs.map(s => `## ${s.heading}\n${s.body.trim()}`).join("\n\n").trim();
}

function parse(file) {
    const slug = path.basename(file, ".md");
    const raw = fs.readFileSync(file, "utf8");
    const titleLine = raw.split("\n").find(l => l.startsWith("# ")) || slug;
    const title = titleLine.replace(/^#\s+/, "").replace(/[`]/g, "").trim();
    const secs = sections(raw).filter(s => s.body.trim());

    const problemSecs = secs.filter(s => matches(s.heading, PROBLEM_HEADINGS));
    const summarySecs = secs.filter(s => matches(s.heading, SUMMARY_HEADINGS));
    const restSecs = secs.filter(s => !problemSecs.includes(s) && !summarySecs.includes(s));

    const problem = render(problemSecs) || title;
    // TL;DR leads: query_lore prints the solution field directly, and the distilled
    // version is what a reader wants ahead of the full detail.
    const solution = [render(summarySecs), render(restSecs)].filter(Boolean).join("\n\n") ||
                     render(secs) || "See the source document.";

    return {
        // Deterministic id from the slug, and deliberately NOT host-prefixed: both
        // machines import the same lessons_learnt corpus, and they must agree on one id
        // per lesson or the shared corpus lands twice. Idempotent across re-runs and
        // across machines for the same reason.
        id: "lesson-" + crypto.createHash("sha1").update(slug).digest("hex").slice(0, 12),
        timestamp: new Date(fs.statSync(file).mtime).toISOString(),
        project: "cross-project",
        category: categoryFor(slug),
        problem: `${title}\n\n${problem}`.trim(),
        solution,
        // These files are already hand-distilled standards, not one-off anecdotes, so
        // query_lore should surface them as best practice. source_ids stays empty: they
        // were written directly, not synthesized from archived raw entries.
        type: "synthesized",
        source_ids: [],
        host: hostName(),
        // These files were written by hand, so the synthesizer is the archive owner.
        // Override with LORE_AUTHOR when importing someone else's corpus.
        author: defaultAuthor(),
        tags: ["lessons_learnt", slug],
    };
}

function main() {
    if (!fs.existsSync(LESSONS_DIR)) {
        console.error(`No lessons directory at ${LESSONS_DIR}. Set LESSONS_DIR.`);
        process.exit(1);
    }
    const files = fs.readdirSync(LESSONS_DIR)
        .filter(f => f.endsWith(".md") && f !== "README.md")
        .map(f => path.join(LESSONS_DIR, f));

    const imported = files.map(parse);
    const importedIds = new Set(imported.map(l => l.id));

    const existing = fs.existsSync(JSONL_PATH)
        ? fs.readFileSync(JSONL_PATH, "utf8").split("\n").filter(l => l.trim()).map(l => JSON.parse(l))
        : [];
    const kept = existing.filter(l => !importedIds.has(l.id));

    fs.mkdirSync(path.dirname(JSONL_PATH), { recursive: true });
    fs.writeFileSync(JSONL_PATH, [...kept, ...imported].map(l => JSON.stringify(l)).join("\n") + "\n", "utf8");

    for (const l of imported) console.log(`  ${l.id}  [${l.category}]  ${l.tags[1]}`);
    console.log(`\nImported ${imported.length} lessons into ${JSONL_PATH}`);
    console.log(`Kept ${kept.length} pre-existing entries. Now run: node reindex.js`);
}

main();
