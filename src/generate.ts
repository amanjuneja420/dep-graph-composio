/**
 * Generator entrypoint. Read a toolkit catalog, infer its dependencies, write a graph.
 *
 * How we run it:
 *   - The path to a toolkit's catalog JSON is passed as a CLI ARGUMENT, e.g.
 *     `node --import tsx src/generate.ts path/to/catalog.json`. We append it as the last
 *     argument, so reading the final argv entry works whatever else your command carries.
 *   - Write your graph to `dependency_graph.json` in the working directory.
 *   - For LLM access, the OpenAI SDK reads OPENAI_API_KEY / OPENAI_BASE_URL from the
 *     environment (set from your assessment page's AI credentials; the same are provided
 *     when we run your generator). Use an OpenRouter model id such as `openai/gpt-4o`.
 *
 * Approach (see README for the task): for every tool's *required* input field, figure out
 * which other tools' outputs could plausibly supply a value for it, and emit those as
 * producer -> consumer edges. This is done in two passes:
 *
 *   1. Heuristic schema matching (deterministic, catalog-only, no network calls). We walk
 *      each tool's outputParameters (resolving $ref/$defs) to collect "qualified" producible
 *      fields -- e.g. a `LIST_REPOSITORY_ISSUES` tool returns an array of `Issue` objects
 *      that each have a bare `number` field; we register that as the qualified candidate
 *      `issue_number`, `issue_id`, etc. We do the same to figure out which entity a tool's
 *      *required* input field belongs to (from the tool's own slug), then look up a match.
 *      This mirrors how the GitHub API itself names things (`issue_number`, `pull_number`,
 *      `owner`, `repo`, ...) so exact/aliased qualified-name matching catches the vast
 *      majority of real dependencies without ever calling a model.
 *
 *   2. LLM refinement (optional, only runs if OPENAI_API_KEY is set). The heuristic pass is
 *      good at recall but can't tell "this field merely has the same name" from "this field
 *      really is the same entity" for ambiguous/generic matches. We batch the heuristic
 *      candidates (grouped by consumer tool) and ask the model to confirm/reject each one
 *      using the tools' descriptions. If no API key is configured (or a call fails), we fall
 *      back to the heuristic-only edges so the generator still works standalone.
 */
import { readFileSync, writeFileSync } from "fs";
import OpenAI from "openai";

type JSONSchema = Record<string, any>;
type Tool = Record<string, any>;

interface Node {
  id: string;
  service?: string;
}
interface Edge {
  from: string;
  to: string;
  label?: string;
}
interface Graph {
  nodes: Node[];
  edges: Edge[];
}

// The catalog path is the last CLI argument (we append it after your run command).
const CATALOG_PATH = process.argv.length > 2 ? process.argv[process.argv.length - 1] : undefined;
const OUT_PATH = "dependency_graph.json";

function loadCatalog(): Tool[] {
  if (!CATALOG_PATH) {
    throw new Error("pass the toolkit catalog path as the first argument");
  }
  const data = JSON.parse(readFileSync(CATALOG_PATH, "utf-8"));
  // getRawComposioTools returns a list of tools (or { tools: [...] }).
  return Array.isArray(data) ? data : (data.tools ?? data.items ?? []);
}

function slugOf(tool: Tool): string | undefined {
  return tool.slug ?? tool.name ?? tool.function?.name;
}

// ---------------------------------------------------------------------------
// name normalization
// ---------------------------------------------------------------------------

/** camelCase / PascalCase / kebab-case / "Title Case" -> snake_case, lowercase. */
function toSnake(s: string): string {
  return s
    .replace(/[-\s]+/g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/**
 * Known GitHub-domain entities and the short forms Composio's own slugs/params use for them
 * (e.g. `pull_number` instead of `pull_request_number`, `repo` instead of `repository`).
 * Every alias maps to the same canonical entity, and when we register a qualified field we
 * register it once per alias so matching works from either direction.
 */
const ENTITY_ALIASES: Record<string, string[]> = {
  issue: ["issue"],
  pull_request: ["pull_request", "pull", "pr"],
  repository: ["repository", "repo"],
  organization: ["organization", "org"],
  comment: ["comment"],
  label: ["label"],
  milestone: ["milestone"],
  branch: ["branch"],
  release: ["release"],
  tag: ["tag"],
  commit: ["commit"],
  gist: ["gist"],
  review: ["review"],
  workflow_run: ["workflow_run", "run"],
  workflow: ["workflow"],
  job: ["job"],
  artifact: ["artifact"],
  webhook: ["webhook", "hook"],
  deployment: ["deployment"],
  environment: ["environment"],
  project: ["project"],
  team: ["team"],
  user: ["user"],
  discussion: ["discussion"],
  check_run: ["check_run", "check"],
  invitation: ["invitation"],
  installation: ["installation"],
  app: ["app"],
  key: ["key"],
  collaborator: ["collaborator"],
  event: ["event"],
  file: ["file"],
  reference: ["reference", "ref"],
  secret: ["secret"],
  variable: ["variable"],
  migration: ["migration"],
  package: ["package"],
  asset: ["asset"],
};

// alias word -> canonical entity, longest-alias-first for greedy slug scanning
const ALIAS_TO_CANONICAL = new Map<string, string>();
for (const [canonical, aliases] of Object.entries(ENTITY_ALIASES)) {
  for (const alias of aliases) ALIAS_TO_CANONICAL.set(alias, canonical);
}
const ALL_ALIASES_BY_LENGTH = [...ALIAS_TO_CANONICAL.keys()].sort((a, b) => b.length - a.length);

/** Leaf field names generic enough that they need an entity qualifier to be a useful label. */
const GENERIC_LEAFS = new Set(["id", "number", "name", "key", "node_id", "slug"]);
/** Leaf field names distinctive enough to also be registered unqualified. */
const DISTINCTIVE_LEAFS = new Set(["sha", "ref", "login", "email", "tag_name", "branch"]);
const CANDIDATE_LEAFS = new Set([...GENERIC_LEAFS, ...DISTINCTIVE_LEAFS]);

/** Which entity keywords are present in a tool's own slug (used to qualify its own bare output fields). */
function entitiesFromSlug(slug: string): string[] {
  const words = new Set(toSnake(slug).split("_"));
  const found = new Set<string>();
  for (const alias of ALL_ALIASES_BY_LENGTH) {
    const aliasWords = alias.split("_");
    if (aliasWords.every((w) => words.has(w))) found.add(ALIAS_TO_CANONICAL.get(alias)!);
  }
  return [...found];
}

// ---------------------------------------------------------------------------
// schema traversal
// ---------------------------------------------------------------------------

function resolveRef(schema: JSONSchema, defs: Record<string, JSONSchema>): JSONSchema {
  if (schema && typeof schema === "object" && typeof schema.$ref === "string") {
    const name = schema.$ref.split("/").pop()!;
    const target = defs[name];
    return target ? { ...target, title: target.title ?? name } : schema;
  }
  return schema;
}

/** A candidate producible field: qualified label -> (unused metadata for now, just presence). */
type ProducerField = { label: string; leaf: string };

/**
 * Walk a tool's outputParameters and collect every candidate producible field, qualified by
 * the entity it logically belongs to (from the surrounding object's title, the property key
 * that led to it, or -- for fields sitting directly on the response root -- the tool's own
 * slug, e.g. GITHUB_GET_AN_ISSUE's bare `number` field becomes `issue_number`).
 */
function extractProducibleFields(tool: Tool): ProducerField[] {
  const out: ProducerField[] = tool.outputParameters;
  if (!out || typeof out !== "object") return [];
  const defs: Record<string, JSONSchema> = out.$defs ?? {};
  const rootEntities = entitiesFromSlug(String(slugOf(tool) ?? ""));
  const results: ProducerField[] = [];
  const seenPaths = new Set<string>();

  function registerLeaf(entityCanonical: string | undefined, leaf: string) {
    const entities = entityCanonical ? [entityCanonical] : rootEntities;
    if (GENERIC_LEAFS.has(leaf)) {
      for (const canonical of entities) {
        for (const alias of ENTITY_ALIASES[canonical] ?? [canonical]) {
          results.push({ label: `${alias}_${leaf}`, leaf });
        }
      }
    }
    if (DISTINCTIVE_LEAFS.has(leaf)) {
      results.push({ label: leaf, leaf });
      for (const canonical of entities) {
        for (const alias of ENTITY_ALIASES[canonical] ?? [canonical]) {
          results.push({ label: `${alias}_${leaf}`, leaf });
        }
      }
    }
  }

  function walk(node: JSONSchema, entityCtx: string | undefined, depth: number, path: string) {
    if (!node || depth > 3 || seenPaths.has(path)) return;
    seenPaths.add(path);
    const resolved = resolveRef(node, defs);
    const entityFromTitle =
      entityCtx ?? (resolved.title ? ALIAS_TO_CANONICAL.get(toSnake(resolved.title)) : undefined);

    if (resolved.type === "array" && resolved.items) {
      const itemsResolved = resolveRef(resolved.items, defs);
      const itemEntity =
        entityFromTitle ??
        (itemsResolved.title ? ALIAS_TO_CANONICAL.get(toSnake(itemsResolved.title)) : undefined);
      walk(itemsResolved, itemEntity, depth + 1, path + "[]");
      return;
    }
    if (resolved.properties && typeof resolved.properties === "object") {
      for (const [key, prop] of Object.entries<JSONSchema>(resolved.properties)) {
        const propPath = `${path}.${key}`;
        const propKeyEntity = ALIAS_TO_CANONICAL.get(key) ?? entityFromTitle;
        if (CANDIDATE_LEAFS.has(key)) {
          registerLeaf(propKeyEntity, key);
        }
        if (prop && typeof prop === "object" && (prop.$ref || prop.type === "array" || prop.properties)) {
          const nextEntity = ALIAS_TO_CANONICAL.get(key) ?? undefined;
          walk(prop, nextEntity, depth + 1, propPath);
        }
      }
    }
  }

  walk(out, undefined, 0, "$");
  return results;
}

/** A tool's required input fields, normalized. */
function extractRequiredInputs(tool: Tool): string[] {
  const inp = tool.inputParameters;
  if (!inp || typeof inp !== "object") return [];
  const required: string[] = Array.isArray(inp.required) ? inp.required : [];
  return required.filter((f) => typeof f === "string");
}

// ---------------------------------------------------------------------------
// service inference (best-effort, for the optional Node.service field)
// ---------------------------------------------------------------------------

function inferService(slug: string): string | undefined {
  const entities = entitiesFromSlug(slug);
  return entities[0];
}

// ---------------------------------------------------------------------------
// heuristic candidate-edge generation
// ---------------------------------------------------------------------------

interface CandidateEdge extends Edge {
  from: string;
  to: string;
  label: string;
}

/**
 * How strongly a tool's own verb suggests it's a natural "precursor" action (something you'd
 * call to look up/discover a value) vs. a mutation. Read-style tools are ranked first when we
 * cap how many candidate producers we keep per (consumer, field) pair -- with hundreds of
 * tools sharing common fields like `repository_id`, keeping every possible producer would
 * bury the useful edges in noise.
 */
const READ_VERBS = ["LIST", "GET", "SEARCH", "FIND"];
function producerRank(slug: string): number {
  return READ_VERBS.some((v) => slug.startsWith(`GITHUB_${v}_`) || slug.includes(`_${v}_`)) ? 0 : 1;
}

/** Cap on how many producer tools we keep per (consumer tool, required field). */
const MAX_PRODUCERS_PER_FIELD = 6;

function buildHeuristicEdges(tools: Tool[]): CandidateEdge[] {
  const producerIndex = new Map<string, Set<string>>(); // qualified label -> producer slugs
  const toolBySlug = new Map<string, Tool>();

  for (const tool of tools) {
    const slug = slugOf(tool);
    if (!slug) continue;
    toolBySlug.set(slug, tool);
    for (const field of extractProducibleFields(tool)) {
      if (!producerIndex.has(field.label)) producerIndex.set(field.label, new Set());
      producerIndex.get(field.label)!.add(slug);
    }
  }

  const edgeKeys = new Set<string>();
  const edges: CandidateEdge[] = [];

  for (const tool of tools) {
    const consumerSlug = slugOf(tool);
    if (!consumerSlug) continue;
    for (const rawField of extractRequiredInputs(tool)) {
      const field = toSnake(rawField);
      const producers = producerIndex.get(field);
      if (!producers) continue;
      const ranked = [...producers]
        .filter((p) => p !== consumerSlug)
        .sort((a, b) => producerRank(a) - producerRank(b) || a.localeCompare(b))
        .slice(0, MAX_PRODUCERS_PER_FIELD);
      for (const producerSlug of ranked) {
        const key = `${producerSlug}=>${consumerSlug}=>${field}`;
        if (edgeKeys.has(key)) continue;
        edgeKeys.add(key);
        edges.push({ from: producerSlug, to: consumerSlug, label: field });
      }
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// LLM refinement (optional)
// ---------------------------------------------------------------------------

const LLM_MODEL = process.env.OPENAI_MODEL ?? "openai/gpt-4o";
/** Cap how many candidate edges we'll spend tokens refining, keeps this bounded on huge catalogs. */
const LLM_MAX_EDGES = Number(process.env.DEPGRAPH_LLM_MAX_EDGES ?? 2000);
const LLM_BATCH_SIZE = 10;
const LLM_CONCURRENCY = 5;
/**
 * The completion is a short JSON verdict list, not prose -- keep this small. Letting the SDK
 * default max_tokens (which can be the model's full completion ceiling, e.g. 16384) burns
 * credits fast on hundreds of batches and risks a mid-run 402 on a metered key.
 */
const LLM_MAX_TOKENS = 200;

function toolSummary(tool: Tool | undefined): { slug: string; description: string } {
  const slug = tool ? String(slugOf(tool)) : "unknown";
  const description = tool?.description ?? tool?.name ?? "";
  return { slug, description: String(description).slice(0, 120) };
}

async function refineWithLLM(
  candidates: CandidateEdge[],
  toolBySlug: Map<string, Tool>,
): Promise<CandidateEdge[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OPENAI_API_KEY not set; skipping LLM refinement, using heuristic edges as-is.");
    return candidates;
  }
  if (candidates.length === 0) return candidates;

  const client = new OpenAI({ apiKey, baseURL: process.env.OPENAI_BASE_URL });

  const toRefine = candidates.slice(0, LLM_MAX_EDGES);
  const overflow = candidates.slice(LLM_MAX_EDGES); // kept as-is, not sent to the model
  if (overflow.length) {
    console.error(`LLM refinement capped at ${LLM_MAX_EDGES} candidates; ${overflow.length} kept unreviewed.`);
  }

  const batches: CandidateEdge[][] = [];
  for (let i = 0; i < toRefine.length; i += LLM_BATCH_SIZE) {
    batches.push(toRefine.slice(i, i + LLM_BATCH_SIZE));
  }

  const kept: (CandidateEdge | null)[][] = new Array(batches.length);
  let failedBatches = 0;

  async function runBatch(batchIdx: number) {
    const batch = batches[batchIdx];
    const items = batch.map((e, i) => {
      const from = toolSummary(toolBySlug.get(e.from));
      const to = toolSummary(toolBySlug.get(e.to));
      return {
        index: i,
        producer_tool: from.slug,
        producer_description: from.description,
        consumer_tool: to.slug,
        consumer_required_field: e.label,
        consumer_description: to.description,
      };
    });

    const prompt =
      "You are validating candidate dependency edges in a tool-call graph for the GitHub API.\n" +
      "Each candidate claims: to call `consumer_tool`, you first call `producer_tool` to obtain a value for " +
      "`consumer_required_field`, because producer_tool's response plausibly contains that value.\n" +
      "Reject a candidate ONLY if the field name match is coincidental and producer_tool's output does NOT " +
      "actually represent the same real-world entity/value that consumer_tool needs (e.g. a `name` field on an " +
      "unrelated resource). Keep it if the relationship is real and useful, even if imperfectly labeled.\n\n" +
      "Candidates:\n" +
      JSON.stringify(items, null, 2) +
      "\n\nRespond with ONLY a JSON array (no prose, no markdown fences), one entry per candidate index, " +
      'like [{"index":0,"keep":true},{"index":1,"keep":false}].';

    try {
      const resp = await client.chat.completions.create({
        model: LLM_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: LLM_MAX_TOKENS,
      });
      const text = resp.choices[0]?.message?.content ?? "[]";
      const jsonText = text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
      const verdicts: { index: number; keep: boolean }[] = JSON.parse(jsonText);
      const verdictByIndex = new Map(verdicts.map((v) => [v.index, v.keep]));
      const rejected = batch.filter((_, i) => verdictByIndex.get(i) === false).length;
      kept[batchIdx] = batch.map((e, i) => (verdictByIndex.get(i) !== false ? e : null));
      console.error(`LLM refinement batch ${batchIdx}: kept ${batch.length - rejected}/${batch.length}`);
    } catch (err) {
      failedBatches++;
      console.error(`LLM refinement batch ${batchIdx} failed (${(err as Error).message}); keeping candidates as-is.`);
      kept[batchIdx] = batch;
    }
  }

  let next = 0;
  async function worker() {
    while (next < batches.length) {
      const idx = next++;
      await runBatch(idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(LLM_CONCURRENCY, batches.length) }, worker));

  const refined = kept.flat().filter((e): e is CandidateEdge => e !== null);
  const rejectedTotal = toRefine.length - refined.length;
  console.error(
    `LLM refinement summary: ${refined.length}/${toRefine.length} candidates kept ` +
      `(${rejectedTotal} rejected), ${failedBatches}/${batches.length} batches fell back to keep-as-is.`,
  );
  return [...refined, ...overflow];
}

// ---------------------------------------------------------------------------
// main generate()
// ---------------------------------------------------------------------------

async function generate(tools: Tool[]): Promise<Graph> {
  const toolBySlug = new Map<string, Tool>();
  const nodes: Node[] = tools
    .map((t) => {
      const slug = slugOf(t);
      if (slug) toolBySlug.set(slug, t);
      return slug;
    })
    .filter((s): s is string => !!s)
    .map((id) => ({ id, service: inferService(id) }));

  const heuristicEdges = buildHeuristicEdges(tools);
  const edges = await refineWithLLM(heuristicEdges, toolBySlug);

  return { nodes, edges };
}

async function main() {
  const graph = await generate(loadCatalog());
  writeFileSync(OUT_PATH, JSON.stringify(graph, null, 2), "utf-8");
  console.error(
    `wrote ${graph.nodes.length} nodes, ${graph.edges.length} edges to ${OUT_PATH}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
