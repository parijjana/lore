// Provenance identity for archived findings.
//
// Two distinct questions, two fields:
//   host   — WHICH MACHINE recorded this. Captured automatically, never passed in.
//            The archive is written by more than one machine, so this is what makes a
//            merged JSONL attributable line by line.
//   author — WHO is responsible for the content. On a raw finding that is whoever
//            observed it; on a synthesized entry it is whoever did the synthesis, which
//            is the reason the field exists at all.
//
// Callers may pass `author` explicitly (an agent crediting itself, or a human crediting
// a colleague). The default is deliberately the human who owns the archive, not the
// agent process — an unattributed entry should read as the owner's, and an agent that
// wants the credit has to say so.

const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

function hostName() {
    if (process.env.LORE_HOST) return process.env.LORE_HOST;
    // mDNS appends ".local" on macOS; it is noise and it makes the same machine look
    // like two different ones depending on how the name was resolved.
    return os.hostname().replace(/\.local$/i, "");
}

let cachedAuthor;
function defaultAuthor() {
    if (process.env.LORE_AUTHOR) return process.env.LORE_AUTHOR;
    if (cachedAuthor !== undefined) return cachedAuthor;
    try {
        cachedAuthor = execFileSync("git", ["config", "--global", "user.name"],
                                    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch (e) {
        cachedAuthor = "";
    }
    if (!cachedAuthor) cachedAuthor = os.userInfo().username;
    return cachedAuthor;
}

// Short, stable hash of the machine name, prefixed onto ids that this machine MINTS
// (archive_lore). Two machines can then never mint the same id, and an id is
// self-describing about where it came from even if the row is read in isolation.
//
// Hashed rather than used raw so the prefix has a fixed width and no characters that
// need escaping in a SQL filter or a filename.
//
// Deliberately NOT applied to content-addressed ids. harvest.js derives its ids from the
// source filename precisely so that both machines importing the same lessons file agree
// on one id — that is what keeps the shared corpus from landing twice. Prefixing those
// would turn one lesson into one-per-machine, which is the opposite of the goal.
function hostPrefix() {
    return crypto.createHash("sha1").update(hostName()).digest("hex").slice(0, 6);
}

module.exports = { hostName, defaultAuthor, hostPrefix };
