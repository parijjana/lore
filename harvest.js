const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ARCHIVE_PATH = "C:\\Users\\anime\\.gemini\\lessons_archive.jsonl";
const TMP_DIR = "C:\\Users\\anime\\.gemini\\tmp";

/**
 * Specifically harvest from known memory files found during research
 */
async function harvest() {
  if (!fs.existsSync(TMP_DIR)) return;
  const projects = fs.readdirSync(TMP_DIR).filter(f => {
    try {
        return fs.statSync(path.join(TMP_DIR, f)).isDirectory();
    } catch(e) {
        return false;
    }
  });
  
  for (const project of projects) {
    const memoryDir = path.join(TMP_DIR, project, "memory");
    if (fs.existsSync(memoryDir)) {
      console.log(`Processing project: ${project}`);
      const files = fs.readdirSync(memoryDir).filter(f => f.endsWith(".md") && f !== "MEMORY.md");
      
      for (const file of files) {
        const content = fs.readFileSync(path.join(memoryDir, file), "utf8");
        
        // Basic extraction logic
        const lines = content.split("\n");
        const title = lines[0].replace(/^#\s+/, "").trim();
        
        let problem = "";
        let solution = "";
        
        let currentSection = "";
        
        for (const line of lines) {
          const lowerLine = line.toLowerCase();
          if (lowerLine.includes("## problem")) {
            currentSection = "problem";
            continue;
          }
          if (lowerLine.includes("## solution") || lowerLine.includes("## definitive fix strategy") || lowerLine.includes("## strategy")) {
            currentSection = "solution";
            continue;
          }
          
          if (currentSection === "problem") problem += line + "\n";
          if (currentSection === "solution") solution += line + "\n";
        }

        const lesson = {
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          project: project,
          category: (project.includes("audio") || project.includes("theme")) ? "flutter" : "general",
          tags: [project, "migrated"],
          problem: problem.trim() || title,
          solution: solution.trim() || "Refer to original Markdown.",
          code_snippets: []
        };

        fs.appendFileSync(ARCHIVE_PATH, JSON.stringify(lesson) + "\n", "utf8");
        console.log(`  Archived: ${title}`);
      }
    }
  }
}

harvest().catch(console.error);
