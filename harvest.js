// Import every file-based lessons corpus into the Lore archive. Repeatable: run it as
// often as you like, on either machine, from any agent.
//
//   npm run harvest && npm run reindex
//
// Interim contract (2026-08-27). Lore is the intended single source of truth, but the
// `lessons_learnt/` files stay canonical until Telarch is live on both machines. Until
// then this importer is the bridge, so it has to be safe to re-run rather than
// merely runnable once:
//
//   * Sources are DISCOVERED, not configured. Absolute paths differ between the two
//     machines, so a config file would need per-machine editing and would drift. The
//     convention is `<projects-root>/*/lessons_learn{t,ed}` (both spellings are in use).
//     Override the root with LORE_PROJECTS_ROOT.
//   * Ids are namespaced by source. `database_batching.md` is exactly the kind of name
//     that will exist in two projects at once; keying on the filename alone would let
//     one project silently overwrite another's lesson.
//   * Ids are NOT host-prefixed, unlike the ones archive_lore mints. Both machines
//     import the same corpus and must agree on one id per lesson, or every lesson lands
//     once per machine. See identity.js.
//   * IT NEVER DELETES BY DEFAULT. Importing adds and updates; that is all. A lesson in
//     the archive with no matching file on this machine is REPORTED, not removed, because
//     the two explanations are indistinguishable from here: the file was deleted, or this
//     machine's checkout simply does not have it (a project it never cloned, or a clone
//     that is behind). Guessing wrong deletes another machine's work and syncs the
//     deletion upstream. Pass `--prune` when you know the deletions are real.
//   * Entries archived by an agent (origin: "agent") are never touched at all.
//
// `--dry-run` reports what would change and writes nothing.

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { JSONL_PATH } = require("./paths.js");
const { hostName, defaultAuthor } = require("./identity.js");

const DRY_RUN = process.argv.includes("--dry-run");
const PRUNE = process.argv.includes("--prune");
const PROJECTS_ROOT = process.env.LORE_PROJECTS_ROOT ||
    path.join(os.homedir(), "code", "projects");

// Both spellings are in the wild: project_docs/lessons_learnt, Aulos/lessons_learned.
const DIR_PATTERN = /^lessons?[_-]learn(t|ed)$/i;

// project_docs holds the cross-cutting corpus rather than one project's.
const PROJECT_ALIASES = { project_docs: "cross-project" };

// Only the problem side is enumerated; everything else in a document is solution
// material. The corpora do not share a heading vocabulary and never will.
const PROBLEM_HEADINGS = ["symptom", "the trap", "root cause", "problem", "the problem",
                          "context", "why a shipped mac app gives false confidence"];
const SUMMARY_HEADINGS = ["tl;dr"];

function categoryFor(slug) {
    const rules = [
        [/^flutter-/, "flutter"],
        [/^ios-/, "ios"],
        [/^appstore-|^apple-/, "appstore"],
        [/^cloudflare-/, "infrastructure"],
        [/^claude-code-/, "agent-workflow"],
        [/^web-/, "web"],
        [/database|drift|migration/, "database"],
        [/state|recursion|isolat/, "state-management"],
        [/ui_|_ui|gesture|tabview|playback/, "ui"],
    ];
    for (const [re, cat] of rules) if (re.test(slug)) return cat;
    return "general";
}

function discoverSources() {
    if (!fs.existsSync(PROJECTS_ROOT)) return [];
    const found = [];
    for (const project of fs.readdirSync(PROJECTS_ROOT).sort()) {
        const projectDir = path.join(PROJECTS_ROOT, project);
        let entries;
        try {
            if (!fs.statSync(projectDir).isDirectory()) continue;
            entries = fs.readdirSync(projectDir);
        } catch (e) { continue; }
        for (const name of entries) {
            if (!DIR_PATTERN.test(name)) continue;
            const dir = path.join(projectDir, name);
            if (fs.statSync(dir).isDirectory()) {
                found.push({ key: PROJECT_ALIASES[project] || project, dir, rel: `${project}/${name}` });
            }
        }
    }
    return found;
}

// Ordered [heading, body] pairs at the h2 level; deeper headings stay in their parent.
function sections(markdown) {
    const out = [];
    let current = null;
    for (const line of markdown.split("\n")) {
        const h = line.match(/^##\s+(.*?)\s*$/);
        if (h) { current = { heading: h[1].replace(/[`*]/g, "").trim(), body: "" }; out.push(current); continue; }
        if (line.startsWith("# ")) { current = null; continue; }
        if (current) current.body += line + "\n";
    }
    return out;
}

// Headings carry qualifiers ("## Symptom (the one you will get if you skip this)").
function matches(heading, list) {
    const h = heading.toLowerCase();
    return list.some(w => h === w || h.startsWith(w + " ") || h.startsWith(w + " ("));
}

function render(secs) {
    return secs.map(s => `## ${s.heading}\n${s.body.trim()}`).join("\n\n").trim();
}

function parse(source, file) {
    const slug = path.basename(file, ".md");
    const raw = fs.readFileSync(file, "utf8");
    const titleLine = raw.split("\n").find(l => l.startsWith("# ")) || slug;
    const title = titleLine.replace(/^#\s+/, "").replace(/[`]/g, "")
                           .replace(/^Lesson(\s+Learned)?:\s*/i, "").trim();
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
        // Namespaced by source so two projects can hold the same filename, and stable
        // across machines and re-runs so re-importing updates in place.
        id: "lesson-" + crypto.createHash("sha1").update(`${source.key}/${slug}`).digest("hex").slice(0, 12),
        timestamp: new Date(fs.statSync(file).mtime).toISOString(),
        project: source.key,
        category: categoryFor(slug),
        problem: `${title}\n\n${problem}`.trim(),
        solution,
        // A hand-written lessons file is already a distilled standard, not a raw
        // observation, so query_lore should surface it as current best practice.
        type: "synthesized",
        source_ids: [],
        host: hostName(),
        author: defaultAuthor(),
        // Provenance is what makes re-running safe: it marks which rows this importer
        // owns and may replace.
        origin: "file",
        source_path: `${source.rel}/${slug}.md`,
        tags: ["lessons_learnt", source.key, slug],
    };
}

// Rows this importer owns. Legacy rows predate the `origin` field but are recognisable
// by the id shape the importer has always produced.
function isFileDerived(entry) {
    if (entry.origin) return entry.origin === "file";
    return /^lesson-[0-9a-f]{12}$/.test(entry.id || "");
}

function main() {
    const sources = discoverSources();
    if (!sources.length) {
        console.error(`No lessons directories found under ${PROJECTS_ROOT}.`);
        console.error(`Looked for */lessons_learnt and */lessons_learned. Set LORE_PROJECTS_ROOT.`);
        process.exit(1);
    }

    const imported = [];
    for (const source of sources) {
        const files = fs.readdirSync(source.dir)
            .filter(f => f.endsWith(".md") && f.toLowerCase() !== "readme.md")
            .sort();
        for (const f of files) imported.push(parse(source, path.join(source.dir, f)));
        console.log(`  ${source.rel}  ->  ${files.length} lesson(s) as "${source.key}"`);
    }

    const importedIds = new Set(imported.map(l => l.id));
    if (importedIds.size !== imported.length) {
        console.error("FATAL: two source files produced the same id. Nothing was written.");
        process.exit(1);
    }

    const existing = fs.existsSync(JSONL_PATH)
        ? fs.readFileSync(JSONL_PATH, "utf8").split("\n").filter(l => l.trim()).map(l => JSON.parse(l))
        : [];

    const agentEntries = existing.filter(e => !isFileDerived(e));
    const unmatched = existing.filter(e => isFileDerived(e) && !importedIds.has(e.id));
    const updated = existing.filter(e => isFileDerived(e) && importedIds.has(e.id)).length;
    const kept = PRUNE ? [] : unmatched;

    console.log(`\n${imported.length} file lesson(s) from ${sources.length} source(s): ` +
                `${updated} updated, ${imported.length - updated} new.`);

    if (unmatched.length) {
        const projects = [...new Set(unmatched.map(e => e.project))].sort().join(", ");
        if (PRUNE) {
            console.log(`\n--prune: ${DRY_RUN ? "would remove" : "removing"} ${unmatched.length} ` +
                        `lesson(s) with no source file here, from: ${projects}`);
            for (const o of unmatched) console.log(`  ${o.id}  ${o.source_path || "(no source_path)"}`);
            console.log(`The archive is in git; revert the commit if that was not intended.`);
        } else {
            console.log(`\n${unmatched.length} lesson(s) in the archive have no source file on this ` +
                        `machine, from: ${projects}`);
            console.log(`KEPT. They may have been deleted upstream, or this machine may simply not ` +
                        `have those files — that is indistinguishable from here, and guessing wrong ` +
                        `destroys another machine's work.`);
            console.log(`If you know the deletions are real, re-run with --prune.`);
        }
    }
    console.log(`Kept ${agentEntries.length} agent-archived entr(y|ies) untouched.`);

    if (DRY_RUN) {
        console.log(`\n--dry-run: nothing was written.`);
        return;
    }
    fs.mkdirSync(path.dirname(JSONL_PATH), { recursive: true });
    fs.writeFileSync(JSONL_PATH,
        [...agentEntries, ...kept, ...imported].map(l => JSON.stringify(l)).join("\n") + "\n", "utf8");
    console.log(`\nWritten to ${JSONL_PATH}. Now run: npm run reindex`);
}

main();
