// Single source of truth for where the archive lives. index.js and reindex.js used to
// compute this independently, and reindex.js ignored LORE_ARCHIVE_PATH entirely — so a
// relocated archive rebuilt from the wrong (usually empty) file.
const path = require("path");
const os = require("os");

const DEFAULT_HOME = path.join(os.homedir(), ".lore");
const JSONL_PATH = process.env.LORE_ARCHIVE_PATH || path.join(DEFAULT_HOME, "lore_archive.jsonl");
const LANCE_DIR = path.join(path.dirname(JSONL_PATH), "lore.lance");

// Append-only record of every entry version that stopped being live: the loser of a
// dedup, the pre-image of an update, the target of a delete. Nothing that was ever in the
// archive is truly gone, so a lesson can always be re-synthesized from the raw material.
// Tracked in the data repo alongside the archive; never read by the server.
const SUPERSEDED_PATH = path.join(path.dirname(JSONL_PATH), "lore_superseded.jsonl");

module.exports = { JSONL_PATH, LANCE_DIR, SUPERSEDED_PATH };
