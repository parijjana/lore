const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

// LanceDB and Transformers
let lancedb;
let pipeline;
try {
    lancedb = require("@lancedb/lancedb");
    const transformers = require("@xenova/transformers");
    pipeline = transformers.pipeline;
} catch (e) {
    console.error("Error loading dependencies. Ensure @lancedb/lancedb and @xenova/transformers are installed.");
}

const DEFAULT_HOME = path.join(os.homedir(), ".gemini");
const JSONL_PATH = process.env.LORE_ARCHIVE_PATH || path.join(DEFAULT_HOME, "lore_archive.jsonl");
const LANCE_DIR = path.join(path.dirname(JSONL_PATH), "lore.lance");
const ADMIN_MODE = process.env.KNOWLEDGE_ADMIN_MODE === 'true';

let db, table, embedder;

async function init() {
    if (!fs.existsSync(path.dirname(JSONL_PATH))) {
        fs.mkdirSync(path.dirname(JSONL_PATH), { recursive: true });
    }
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    db = await lancedb.connect(LANCE_DIR);
    const tableNames = await db.tableNames();
    if (!tableNames.includes("lessons")) {
        table = await db.createTable("lessons", [{
            id: "initial",
            vector: Array(384).fill(0),
            text: "",
            project: "",
            category: "",
            problem: "",
            solution: "",
            type: "raw",
            source_ids: [],
            timestamp: new Date().toISOString()
        }]);
        await table.delete('id = "initial"');
    } else {
        table = await db.openTable("lessons");
    }
}

async function getEmbedding(text) {
    const output = await embedder(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
}

function readJsonlBackup() {
    if (!fs.existsSync(JSONL_PATH)) return [];
    return fs.readFileSync(JSONL_PATH, "utf8").split("\n").filter(l => l.trim()).map(l => JSON.parse(l));
}

const server = new Server(
  { name: "lore", version: "2.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = [
    {
      name: "archive_lesson",
      description: "Archive a technical lesson with automated vector indexing.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          category: { type: "string" },
          problem: { type: "string" },
          solution: { type: "string" },
          type: { type: "string", enum: ["raw", "synthesized"], default: "raw" },
          source_ids: { type: "array", items: { type: "string" } },
          tags: { type: "array", items: { type: "string" } }
        },
        required: ["project", "category", "problem", "solution"],
      },
    },
    {
      name: "query_lessons",
      description: "Perform semantic search across the knowledge archive.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search by meaning or intent." },
          category: { type: "string" },
          include_raw: { type: "boolean", default: false }
        }
      },
    },
    {
      name: "get_lesson_ancestry",
      description: "Retrieve source lessons for synthesized rules (Recursive).",
      inputSchema: {
        type: "object",
        properties: { lesson_id: { type: "string" }, max_depth: { type: "number", default: 3 } },
        required: ["lesson_id"]
      }
    },
    {
      name: "get_lore_bootstrap_info",
      description: "Get the instructions and briefing for setting up the Lore Knowledge Architect protocol in global memory.",
      inputSchema: { type: "object", properties: {} }
    }
  ];

  if (ADMIN_MODE) {
    tools.push({
        name: "update_lesson",
        description: "ADMIN ONLY: Update an existing lesson's content or metadata.",
        inputSchema: {
            type: "object",
            properties: { id: { type: "string" }, updates: { type: "object" } },
            required: ["id", "updates"]
        }
    });
    tools.push({
        name: "delete_lesson",
        description: "ADMIN ONLY: Permanently remove a lesson from the archive.",
        inputSchema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"]
        }
    });
  }

  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "archive_lesson") {
      const id = crypto.randomUUID();
      const timestamp = new Date().toISOString();
      const lesson = { id, timestamp, ...args, source_ids: args.source_ids || [], type: args.type || "raw" };
      fs.appendFileSync(JSONL_PATH, JSON.stringify(lesson) + "\n", "utf8");
      const combinedText = `${lesson.category} ${lesson.problem} ${lesson.solution} ${lesson.tags?.join(" ") || ""}`;
      const vector = await getEmbedding(combinedText);
      await table.add([{ ...lesson, vector, text: combinedText }]);
      return { content: [{ type: "text", text: `Successfully archived ${lesson.type} lesson ${id}. (Vector Indexed)` }] };
    }

    if (name === "query_lessons") {
      const query = args.query || "";
      let results;
      if (query) {
          const vector = await getEmbedding(query);
          results = await table.search(vector).limit(10).execute();
      } else {
          results = await table.select().limit(10).execute();
      }
      if (args.category) {
          results = results.filter(r => r.category.toLowerCase() === args.category.toLowerCase());
      }
      const synthesized = results.filter(r => r.type === "synthesized");
      if (synthesized.length > 0 && !args.include_raw) {
          const latest = synthesized.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
          return { content: [{ type: "text", text: `PROACTIVE BEST PRACTICE FOUND:\n\n### [${latest.category.toUpperCase()}] ${latest.project}\n${latest.solution}\n\nProvenance: Derived from ${latest.source_ids.length} sources. ID: ${latest.id}` }] };
      }
      const output = results.map(r => `[${r.type.toUpperCase()}] ${r.project}: ${r.problem.substring(0, 100)}... (Match Score: ${r._distance ? (1 - r._distance).toFixed(2) : "N/A"}) ID: ${r.id}`).join("\n");
      return { content: [{ type: "text", text: `Found ${results.length} semantic matches:\n\n${output}` }] };
    }

    if (name === "get_lesson_ancestry") {
        const all = readJsonlBackup();
        const findAncestors = (id, currentDepth) => {
            if (currentDepth <= 0) return [];
            const lesson = all.find(l => l.id === id);
            if (!lesson || !lesson.source_ids) return [];
            let ancestors = [];
            for (const sId of lesson.source_ids) {
                const source = all.find(l => l.id === sId);
                if (source) {
                    ancestors.push(source);
                    ancestors = ancestors.concat(findAncestors(sId, currentDepth - 1));
                }
            }
            return ancestors;
        };
        const ancestry = findAncestors(args.lesson_id, args.max_depth || 3);
        return { content: [{ type: "text", text: JSON.stringify(ancestry, null, 2) }] };
    }

    if (name === "get_lore_bootstrap_info") {
        const briefing = `
# Lore Setup: Why Proactive Memory Matters
Lore is your cross-project technical memory. By adding its protocol to your global context:
1. **Never repeat mistakes**: I will instinctively check past projects before suggesting architectures.
2. **Automated Consistency**: Best practices evolve as you solve bugs in different repos.
3. **Recursive Integrity**: New rules are audited against their history to ensure they aren't built on stale assumptions.

**If you decline**:
- You must manually ask me to "search Lore" for every task.
- I will not proactively warn you about known anti-patterns.
- Synthesis and audits will require explicit manual triggers.
        `.trim();

        const payload = `
## Lore: Knowledge Architect Protocol
- **Usage Mode**: When queried for a solution, trust and present synthesized lessons as the Current Standard.
- **Synthesis Mode**: When creating a NEW synthesized lesson, you MUST call get_lesson_ancestry (depth 3) to resolve contradictions.
- **Proactive Wisdom**: Before proposing architectures or fixing bugs, silently use query_lore to ensure continuity with past breakthroughs.
        `.trim();

        return {
            content: [{ type: "text", text: JSON.stringify({ briefing, payload }, null, 2) }]
        };
    }

    if (name === "update_lesson" && ADMIN_MODE) {
        await table.update(args.updates, `id = "${args.id}"`);
        const all = readJsonlBackup();
        const updated = all.map(l => l.id === args.id ? { ...l, ...args.updates } : l);
        fs.writeFileSync(JSONL_PATH, updated.map(l => JSON.stringify(l)).join("\n") + "\n");
        return { content: [{ type: "text", text: `Lesson ${args.id} updated successfully.` }] };
    }

    if (name === "delete_lesson" && ADMIN_MODE) {
        await table.delete(`id = "${args.id}"`);
        const all = readJsonlBackup();
        const filtered = all.filter(l => l.id !== args.id);
        fs.writeFileSync(JSONL_PATH, filtered.map(l => JSON.stringify(l)).join("\n") + "\n");
        return { content: [{ type: "text", text: `Lesson ${args.id} deleted.` }] };
    }

    throw new Error(`Unknown tool or unauthorized: ${name}`);
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
  }
});

async function run() {
  await init();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

run().catch(console.error);
