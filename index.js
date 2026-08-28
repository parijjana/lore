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

const { JSONL_PATH, LANCE_DIR } = require("./paths.js");
const { hostName, defaultAuthor, hostPrefix } = require("./identity.js");
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
            host: "",
            author: "",
            source_ids: ["none"],
            tags: ["none"],
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

// LanceDB filters are SQL strings; ids and categories reach them from tool arguments.
function sqlString(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}

function readJsonlBackup() {
    if (!fs.existsSync(JSONL_PATH)) return [];
    return fs.readFileSync(JSONL_PATH, "utf8").split("\n").filter(l => l.trim()).map(l => JSON.parse(l));
}

const server = new Server(
  { name: "lore", version: "2.2.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = [
    {
      name: "archive_lore",
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
          tags: { type: "array", items: { type: "string" } },
          author: {
            type: "string",
            description: "Who is responsible for this finding. On a synthesized entry, "
                       + "the synthesizer. Defaults to the archive owner; pass your own "
                       + "name to take credit. The recording machine is captured "
                       + "automatically and cannot be set here."
          }
        },
        required: ["project", "category", "problem", "solution"],
      },
    },
    {
      name: "query_lore",
      description: "Perform semantic search across the knowledge archive.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search by meaning or intent." },
          category: { type: "string" },
          include_raw: { type: "boolean", default: false },
          limit: { type: "number", default: 10 },
          author: { type: "string", description: "Only findings attributed to this author." },
          host: { type: "string", description: "Only findings recorded on this machine." }
        }
      },
    },
    {
      name: "get_lore_ancestry",
      description: "Retrieve source lessons for synthesized rules (Recursive).",
      inputSchema: {
        type: "object",
        properties: { lesson_id: { type: "string" }, max_depth: { type: "number", default: 3 } },
        required: ["lesson_id"]
      }
    },
    {
      name: "get_lore_protocol",
      description: "Retrieve the official Knowledge Architect instructions. CALL THIS FIRST when connecting to Lore for the first time.",
      inputSchema: { type: "object", properties: {} }
    },
    {
        name: "get_lore_health",
        description: "Get statistics and fragmentation status of the knowledge base.",
        inputSchema: { type: "object", properties: {} }
    }
  ];

  if (ADMIN_MODE) {
    tools.push({
        name: "update_lore",
        description: "ADMIN ONLY: Update an existing lesson.",
        inputSchema: {
            type: "object",
            properties: { id: { type: "string" }, updates: { type: "object" } },
            required: ["id", "updates"]
        }
    });
    tools.push({
        name: "delete_lore",
        description: "ADMIN ONLY: Permanently remove a lesson.",
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
    if (name === "archive_lore") {
      // Host-prefixed so two machines can never mint the same id, and so an id says
      // where it came from on its own. See identity.js for why harvest.js opts out.
      const id = `${hostPrefix()}-${crypto.randomUUID()}`;
      const timestamp = new Date().toISOString();
      const lesson = {
          id, timestamp, ...args,
          source_ids: args.source_ids || [],
          type: args.type || "raw",
          // Which machine wrote this. Never taken from the caller — the point is that it
          // is trustworthy when two machines merge into one JSONL.
          host: hostName(),
          // Who is responsible for the content. On a synthesized entry this is the
          // synthesizer, which is what makes the raw -> synthesized promotion auditable.
          author: args.author || defaultAuthor(),
      };
      fs.appendFileSync(JSONL_PATH, JSON.stringify(lesson) + "\n", "utf8");
      const combinedText = `${lesson.category} ${lesson.problem} ${lesson.solution} ${lesson.tags?.join(" ") || ""}`;
      const vector = await getEmbedding(combinedText);
      await table.add([{ ...lesson, vector, text: combinedText }]);
      return { content: [{ type: "text", text: `Successfully archived ${lesson.type} lesson ${id} (author: ${lesson.author}, host: ${lesson.host}).` }] };
    }

    if (name === "query_lore") {
      const query = args.query || "";
      const limit = args.limit || 10;
      // Filtered inside the query, not after it: filtering a limited result set
      // silently hides matches that sit deeper in the index.
      const clauses = [];
      if (args.category) clauses.push(`lower(category) = ${sqlString(args.category.toLowerCase())}`);
      if (args.author)   clauses.push(`lower(author) = ${sqlString(args.author.toLowerCase())}`);
      if (args.host)     clauses.push(`lower(host) = ${sqlString(args.host.toLowerCase())}`);
      const filter = clauses.length ? clauses.join(" AND ") : null;
      let builder;
      if (query) {
          const vector = await getEmbedding(query);
          builder = table.search(vector);
      } else {
          builder = table.query();
      }
      if (filter) builder = builder.where(filter);
      const results = await builder.limit(limit).toArray();
      const synthesized = results.filter(r => r.type === "synthesized");
      if (synthesized.length > 0 && !args.include_raw) {
          // Pick the best MATCH, not the newest entry. Results arrive distance-sorted, so
          // the first synthesized hit is the closest one; timestamp only breaks ties (and
          // is the only signal available when there is no query vector at all). Sorting by
          // timestamp alone returned whichever lesson was written last, for every query.
          const best = synthesized.sort((a, b) => {
              const da = a._distance, db = b._distance;
              if (da !== undefined && db !== undefined && da !== db) return da - db;
              return new Date(b.timestamp) - new Date(a.timestamp);
          })[0];
          const headline = (best.problem || "").split("\n")[0];
          return { content: [{ type: "text", text: `PROACTIVE BEST PRACTICE FOUND:\n\n### [${(best.category || "general").toUpperCase()}] ${headline}\n\n${best.solution}\n\nProvenance: synthesized by ${best.author || "unknown"}, derived from ${best.source_ids.length} sources. ID: ${best.id}` }] };
      }
      const output = results.map(r => `[${(r.type || "raw").toUpperCase()}] ${r.project}: ${(r.problem || "").substring(0, 100)}... (Score: ${r._distance ? (1 - r._distance).toFixed(2) : "N/A"}) by ${r.author || "unknown"}@${r.host || "unknown"} ID: ${r.id}`).join("\n");
      return { content: [{ type: "text", text: `Found ${results.length} semantic matches:\n\n${output}` }] };
    }

    if (name === "get_lore_ancestry") {
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

    if (name === "get_lore_protocol") {
        const protocol = `
# Lore Knowledge Architect Protocol (Agent-Agnostic)
You are connected to a "Lore" Knowledge Archive. Follow these rules:
1. **Bootstrap**: CALL THIS TOOL (get_lore_protocol) to remind yourself of your identity and instincts.
2. **Proactive Lookup**: Before proposing architectures or fixing bugs, use 'query_lore' to ensure continuity with past breakthroughs.
3. **Usage Mode**: Trust 'synthesized' lessons as the Current Standard.
4. **Synthesis Mode**: When 5+ related findings accumulate, offer to consolidate them. During synthesis, use 'get_lore_ancestry' (depth 3) to identify and resolve any contradictions. **Pass 'author' with your own name when you archive the synthesized entry** — the raw findings keep the attribution of whoever observed them, and the synthesized entry records who did the distilling. That is what makes a promotion auditable after the fact.
5. **Transparency**: Always mention project names and provenance counts when sharing Lore results.
6. **Source of truth (interim, 2026-08-27)**: entries with 'origin: "file"' are imported from Markdown lessons files, which are still canonical until Telarch runs on both machines. Do NOT use 'update_lore' on them — edit the source file and re-run the importer. Entries with 'origin: "agent"' live only in Lore and are yours to maintain.
7. **Provenance**: Every entry carries 'host' (the machine that recorded it, captured automatically and not settable by you) and 'author' (who is responsible for the content). Filter on either via 'query_lore'. When two machines write one archive, 'host' is what makes a merged archive attributable.
        `.trim();
        return { content: [{ type: "text", text: protocol }] };
    }

    if (name === "get_lore_health") {
        const all = readJsonlBackup();
        const stats = {};
        all.forEach(l => {
            const cat = l.category || "general";
            if (!stats[cat]) stats[cat] = { total: 0, raw: 0, synthesized: 0 };
            stats[cat].total++;
            stats[cat][l.type]++;
        });
        const summary = Object.entries(stats).map(([cat, s]) => 
            `- **${cat.toUpperCase()}**: ${s.total} total (${s.raw} raw, ${s.synthesized} synthesized). ${s.raw >= 5 ? "️ Fragmentation High - Recommend Synthesis." : " Healthy"}`
        ).join("\n");

        // The archive is written by more than one machine. A per-host count is how you
        // notice that one of them stopped contributing, or that a merge dropped a side.
        const tally = (key) => {
            const t = {};
            all.forEach(l => { const v = l[key] || "unattributed"; t[v] = (t[v] || 0) + 1; });
            return Object.entries(t).sort((a, b) => b[1] - a[1])
                     .map(([v, n]) => `- ${v}: ${n}`).join("\n");
        };
        const provenance = `Recorded on:\n${tally("host")}\n\nAttributed to:\n${tally("author")}`;
        return { content: [{ type: "text", text: `Lore Health Status:\n\n${summary}\n\n${provenance}` }] };
    }

    if (name === "update_lore" && ADMIN_MODE) {
        await table.update(args.updates, `id = ${sqlString(args.id)}`);
        const all = readJsonlBackup();
        const updated = all.map(l => l.id === args.id ? { ...l, ...args.updates } : l);
        fs.writeFileSync(JSONL_PATH, updated.map(l => JSON.stringify(l)).join("\n") + "\n");
        return { content: [{ type: "text", text: `Lesson ${args.id} updated.` }] };
    }

    if (name === "delete_lore" && ADMIN_MODE) {
        await table.delete(`id = ${sqlString(args.id)}`);
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
