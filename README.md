# Lore

A cross-project technical knowledge management system for the Gemini CLI, now powered by **LanceDB Semantic Search**. This tool allows your AI agents to archive and query technical lessons learned across different workspaces, creating a persistent, high-intelligence "global memory."

## Features

- **Semantic Search:** Uses local CPU embeddings (`all-MiniLM-L6-v2`) to find lessons by *meaning* and *intent*, not just keywords.
- **Cross-Project Memory:** Share insights between unrelated projects automatically.
- **Hierarchical Knowledge:** Supports `raw` observations and `synthesized` Best Practices with full provenance tracking.
- **Proactive Wisdom:** Agents automatically check the archive for relevant patterns before proposing solutions.
- **Recursive Audit:** Agents automatically trace the ancestry of synthesized rules (up to 3 levels deep) to ensure no contradictions.
- **Admin Isolation:** Destructive tools (`update_lesson`, `delete_lesson`) are hidden by default and only available in a dedicated "Maintenance Mode."

## Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- [Gemini CLI](https://github.com/google/gemini-cli)

## Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/your-username/lore.git
   cd lore
   ```

2. **Run the installer:**

   **Windows (PowerShell):**
   ```powershell
   ./install.ps1
   ```

   **macOS / Linux:**
   ```bash
   chmod +x install.sh
   ./install.sh
   ```

3. **Restart Gemini CLI.**

## Usage

Interact with the archive naturally:

- *"Archive this fix for the TabController race condition to the global lessons repository."*
- *"Based on our past projects, what is the best way to handle Flutter pagination?"* (The agent will perform a semantic search and return the synthesized best practice).

## Admin Mode (Maintenance)

To update or delete lessons, you must enable Admin Mode by setting an environment variable:

1. Create a dedicated `admin-settings.json` (or use a temporary flag).
2. Set `KNOWLEDGE_ADMIN_MODE=true` in your environment.
3. The agent will now have access to `update_lesson` and `delete_lesson`.

## Technical Details

- **Database:** LanceDB (Serverless, local file-based).
- **Embeddings:** Local CPU-based (Transformers.js).
- **Backup:** A human-readable `lore_archive.jsonl` is maintained alongside the binary vector store.

## License

MIT License - See [LICENSE](./LICENSE) for details.
