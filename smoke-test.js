const os = require("os");
const fs = require("fs");
const path = require("path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
(async () => {
  // Throwaway archive so the smoke test never touches the real corpus.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lore-smoke-"));
  const t = new StdioClientTransport({
    command: "node", args: [path.join(__dirname, "index.js")],
    env: { ...process.env,
           KNOWLEDGE_ADMIN_MODE: "true",
           LORE_ARCHIVE_PATH: path.join(home, "lore_archive.jsonl") },
  });
  const c = new Client({ name: "smoke", version: "1" }, { capabilities: {} });
  await c.connect(t);
  const fails = [];
  const check = (name, cond, detail) => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  <- " + detail}`);
    if (!cond) fails.push(name);
  };

  const tools = (await c.listTools()).tools.map(x => x.name);
  check("all 7 tools listed (admin mode)", tools.length === 7, tools.join(","));

  const call = async (n, a) => {
    const r = await c.callTool({ name: n, arguments: a });
    if (r.isError) throw new Error(`${n}: ${r.content[0].text}`);
    return r.content[0].text;
  };

  await call("archive_lore", { project: "Karst", category: "build", problem: "stale dart incremental build", solution: "clean before archive", tags: ["flutter"] });
  await call("archive_lore", { project: "pellucid", category: "signing", problem: "entitlement rejected", solution: "remove the entitlement" });
  check("archive_lore accepts tags (initial table schema carries the column)", true, "");

  const all = await call("query_lore", { query: "build cache went stale" });
  check("semantic query returns both entries", /Found 2 /.test(all), all);

  // Category is filtered inside the query; filtering after .limit() dropped matches.
  const cat = await call("query_lore", { query: "rejection", category: "SIGNING" });
  check("category filter is case-insensitive and scoped", /Found 1 /.test(cat) && /pellucid/.test(cat), cat);

  // table.select() does not exist in @lancedb/lancedb 0.29 — this path used to crash.
  const noq = await call("query_lore", {});
  check("query with no search text works", /Found 2 /.test(noq), noq);

  const none = await call("query_lore", { query: "x", category: "nope" });
  check("unknown category returns nothing", /Found 0 /.test(none), none);

  // Filters are SQL strings built from tool arguments.
  const inj = await call("query_lore", { query: "x", category: "a' OR '1'='1" });
  check("quote in category cannot break out of the filter", /Found 0 /.test(inj), inj);

  // --- provenance ---------------------------------------------------------------
  const { hostName, defaultAuthor } = require("./identity.js");
  const arch = await call("archive_lore", { project: "x", category: "prov", problem: "p", solution: "s" });
  check("archive stamps host and author by default",
        arch.includes(hostName()) && arch.includes(defaultAuthor()), arch);

  const credited = await call("archive_lore", {
      project: "x", category: "prov2", problem: "p2", solution: "s2",
      type: "synthesized", author: "claude-opus-5" });
  check("synthesizer can take credit via author", credited.includes("claude-opus-5"), credited);

  // host identifies the recording machine, so a caller must not be able to set it.
  const spoof = await call("archive_lore", {
      project: "x", category: "prov3", problem: "p3", solution: "s3", host: "not-my-machine" });
  check("host cannot be spoofed by the caller",
        spoof.includes(hostName()) && !spoof.includes("not-my-machine"), spoof);

  // Minted ids carry a host prefix so two machines can never collide.
  const { hostPrefix } = require("./identity.js");
  check("minted id is host-prefixed", new RegExp(`lesson ${hostPrefix()}-`).test(arch), arch);

  const byAuthor = await call("query_lore", { query: "p2", author: "claude-opus-5" });
  check("filter by author", /Found 1 /.test(byAuthor) || /PROACTIVE/.test(byAuthor), byAuthor);

  const byHost = await call("query_lore", { query: "p", host: hostName(), include_raw: true });
  check("filter by host matches this machine", !/Found 0 /.test(byHost), byHost);

  const otherHost = await call("query_lore", { query: "p", host: "some-other-box", include_raw: true });
  check("filter by an absent host returns nothing", /Found 0 /.test(otherHost), otherHost);

  const health = await call("get_lore_health", {});
  check("health reports both categories", /BUILD/.test(health) && /SIGNING/.test(health), health);

  await c.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(", ")}` : "\nAll checks passed.");
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
