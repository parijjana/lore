// Retiring an entry never destroys it.
//
// The archive is the raw material for later synthesis, so anything that stops being live —
// the losing side of a merge dedup, the previous version of an updated entry, a deleted
// entry — is appended here first, with a note about why. Recovering something is then
// reading a file, not archaeology through git history.

const fs = require("fs");
const path = require("path");
const { SUPERSEDED_PATH } = require("./paths.js");

function supersede(entries, reason) {
    const rows = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
    if (!rows.length) return 0;
    const stamp = new Date().toISOString();
    const lines = rows.map(e => JSON.stringify({
        superseded_at: stamp,
        superseded_reason: reason,
        entry: e,
    }));
    fs.mkdirSync(path.dirname(SUPERSEDED_PATH), { recursive: true });
    fs.appendFileSync(SUPERSEDED_PATH, lines.join("\n") + "\n", "utf8");
    return rows.length;
}

module.exports = { supersede };
