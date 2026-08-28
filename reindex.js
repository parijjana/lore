const fs = require('fs');
const path = require('path');
const os = require('os');

async function reindex() {
    console.log("Starting Vector Re-indexing...");
    
    // We need to use the logic from index.js to ensure consistency
    const { pipeline } = require("@xenova/transformers");
    const lancedb = require("@lancedb/lancedb");
    
    const { JSONL_PATH, LANCE_DIR } = require("./paths.js");

    if (!fs.existsSync(JSONL_PATH)) {
        console.log("No JSONL file found to re-index.");
        return;
    }

    const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    const db = await lancedb.connect(LANCE_DIR);
    
    const tableNames = await db.tableNames();
    if (tableNames.includes("lessons")) {
        await db.dropTable("lessons");
    }

    const lessons = fs.readFileSync(JSONL_PATH, "utf8")
        .split("\n")
        .filter(l => l.trim())
        .map(l => JSON.parse(l));

    console.log(`Found ${lessons.length} lessons. Generating embeddings...`);

    const data = [];
    for (const lesson of lessons) {
        const combinedText = `${lesson.category} ${lesson.problem} ${lesson.solution} ${(lesson.tags || []).join(" ")}`;
        const output = await embedder(combinedText, { pooling: 'mean', normalize: true });
        const vector = Array.from(output.data);
        
        data.push({
            id: String(lesson.id || ""),
            vector: vector,
            text: String(combinedText || ""),
            project: String(lesson.project || "unknown"),
            category: String(lesson.category || "general"),
            problem: String(lesson.problem || ""),
            solution: String(lesson.solution || ""),
            type: String(lesson.type || "raw"),
            host: String(lesson.host || ""),
            author: String(lesson.author || ""),
            source_ids: (lesson.source_ids || []).map(id => String(id)),
            timestamp: String(lesson.timestamp || new Date().toISOString()),
            tags: (lesson.tags || []).map(t => String(t))
        });
        console.log(`  Indexed: ${lesson.id} (${lesson.project})`);
    }

    // Ensure the first row has at least one element in arrays to help inference
    if (data.length > 0) {
        if (data[0].source_ids.length === 0) data[0].source_ids = ["none"];
        if (data[0].tags.length === 0) data[0].tags = ["none"];
    }

    await db.createTable("lessons", data);
    console.log("Re-indexing complete!");
}

reindex().catch(console.error);
