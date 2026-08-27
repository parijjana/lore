// Single source of truth for where the archive lives. index.js and reindex.js used to
// compute this independently, and reindex.js ignored LORE_ARCHIVE_PATH entirely — so a
// relocated archive rebuilt from the wrong (usually empty) file.
const path = require("path");
const os = require("os");

const DEFAULT_HOME = path.join(os.homedir(), ".lore");
const JSONL_PATH = process.env.LORE_ARCHIVE_PATH || path.join(DEFAULT_HOME, "lore_archive.jsonl");
const LANCE_DIR = path.join(path.dirname(JSONL_PATH), "lore.lance");

module.exports = { JSONL_PATH, LANCE_DIR };
