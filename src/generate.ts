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
 *   1. Heuristic schema matching (deterministic, catalog-only, no network calls, and NOT
 *      GitHub-specific -- every entity/leaf name it matches against is discovered from
 *      whatever catalog it's handed, in two structural passes:
 *        a) scan every tool's outputParameters to build a vocabulary of "entities" (the
 *           $ref-titled object types that show up as array items or nested properties, e.g.
 *           `Issue`, `PullRequest` -- or, for a different toolkit, whatever nouns that
 *           toolkit's schemas use) and, for every leaf (scalar) field name, how many distinct
 *           entities it appears under catalog-wide (a field appearing under many entities,
 *           like `id`/`name`, is "generic"; one appearing under only one or two, like
 *           `tag_name`, is "distinctive").
 *        b) for each tool's required input fields, match against that vocabulary two ways:
 *           an exact/bare match against a distinctive leaf key (covers fields like `sha`,
 *           `ref`, `tag_name` that need no qualifier), or a `<entity>_<leaf>` split match
 *           where the prefix fuzzily names an entity (covers `issue_number`, `pull_number`,
 *           `repo` vs. `repository`, etc. -- via token/substring matching, not a fixed
 *           dictionary of English nouns).
 *      This is how the GitHub catalog's own naming (`issue_number`, `pull_number`, `owner`,
 *      `repo`, ...) gets matched, but the mechanism itself carries no GitHub-specific
 *      vocabulary -- point it at a different toolkit's catalog and it rebuilds the entity/leaf
 *      vocabulary from that catalog instead. See DESIGN.md for the full rationale and a
 *      worked example against a second, non-GitHub fake catalog.
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
 * Fold simple English plurals so token comparisons treat "issues"/"issue",
 * "requests"/"request" as the same word. A small, explicitly acknowledged non-generalization
 * (see DESIGN.md) -- the rest of the entity/leaf vocabulary below is 100% catalog-derived.
 */
function singularize(word: string): string {
  if (word.length > 3 && word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}
function tokens(s: string): string[] {
  return toSnake(s)
    .split("_")
    .filter(Boolean)
    .map(singularize);
}

/**
 * Does `entity` (a canonical entity name like "pull_request") plausibly correspond to a
 * short-form `word` used elsewhere (like "pull", "pr" is NOT caught -- true acronyms aren't
 * derivable from token/substring matching, only truncations/single-token references are)?
 * Matches by exact token membership ("pull" is a token of "pull_request") or by the entity's
 * token-joined form starting with the word ("repo" is a prefix of "repository").
 */
function entityMatchesWord(entity: string, word: string): boolean {
  const entityTokens = tokens(entity);
  if (entityTokens.includes(word)) return true;
  const joined = entityTokens.join("");
  return word.length >= 3 && joined.startsWith(word);
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

/** One occurrence of a leaf (scalar) field found while walking a tool's output schema. */
type LeafOccurrence = { leaf: string; entity: string | undefined };

/**
 * Walk a tool's outputParameters and collect every scalar leaf field it produces, tagged with
 * the entity it belongs to when we can tell (from the nearest enclosing $ref's own title --
 * never from the property key, so this needs no fixed vocabulary at all). Fields sitting
 * directly on the tool's own response root (depth 0, e.g. a `GET_AN_ISSUE`-style endpoint
 * that returns the entity inline rather than nested) have no title-derived entity; the caller
 * fills that in from the tool's slug once the catalog-wide entity vocabulary is known.
 */
function walkOutputLeaves(tool: Tool): LeafOccurrence[] {
  const out: JSONSchema = tool.outputParameters;
  if (!out || typeof out !== "object") return [];
  const defs: Record<string, JSONSchema> = out.$defs ?? {};
  const results: LeafOccurrence[] = [];
  const seenPaths = new Set<string>();

  function walk(node: JSONSchema, entityCtx: string | undefined, depth: number, path: string) {
    if (!node || depth > 4 || seenPaths.has(path)) return;
    seenPaths.add(path);
    const resolved = resolveRef(node, defs);
    const entityFromTitle = depth > 0 && resolved.title ? toSnake(resolved.title) : entityCtx;

    if (resolved.type === "array" && resolved.items) {
      const itemsResolved = resolveRef(resolved.items, defs);
      const itemEntity = itemsResolved.title ? toSnake(itemsResolved.title) : entityFromTitle;
      walk(itemsResolved, itemEntity, depth + 1, path + "[]");
      return;
    }
    if (resolved.properties && typeof resolved.properties === "object") {
      for (const [key, prop] of Object.entries<JSONSchema>(resolved.properties)) {
        const propPath = `${path}.${key}`;
        const isContainer = prop && typeof prop === "object" && (prop.$ref || prop.type === "array" || prop.properties);
        if (isContainer) {
          walk(prop, undefined, depth + 1, propPath);
        } else if (prop && typeof prop === "object" && prop.type && prop.type !== "object") {
          results.push({ leaf: toSnake(key), entity: entityFromTitle });
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
// catalog-wide vocabulary (pass 1): entities + leaf distinctiveness, both derived
// purely from the catalog we were handed -- no fixed toolkit-specific dictionary.
// ---------------------------------------------------------------------------

/** A leaf appearing under this many or fewer distinct entities catalog-wide is "distinctive"
 *  enough to also match bare/unqualified (e.g. `sha`, `tag_name`); above it, it needs an
 *  entity qualifier (e.g. bare `id`/`name`/`number` are hopelessly ambiguous catalog-wide). */
const DISTINCTIVE_ENTITY_THRESHOLD = 2;

interface CatalogVocabulary {
  entities: Set<string>;
  distinctiveLeaves: Set<string>;
}

function buildVocabulary(tools: Tool[]): CatalogVocabulary {
  const entities = new Set<string>();
  const leafEntities = new Map<string, Set<string>>();

  for (const tool of tools) {
    for (const { leaf, entity } of walkOutputLeaves(tool)) {
      if (entity) {
        entities.add(entity);
        if (!leafEntities.has(leaf)) leafEntities.set(leaf, new Set());
        leafEntities.get(leaf)!.add(entity);
      }
    }
  }

  const distinctiveLeaves = new Set<string>();
  for (const [leaf, ents] of leafEntities) {
    if (ents.size <= DISTINCTIVE_ENTITY_THRESHOLD) distinctiveLeaves.add(leaf);
  }
  return { entities, distinctiveLeaves };
}

/** Which catalog entities a tool's own slug plausibly refers to (fuzzy token match, no
 *  fixed dictionary -- e.g. slug tokens ["get","an","issue"] match entity "issue"). */
function entitiesFromSlug(slug: string, vocab: CatalogVocabulary): string[] {
  const slugTokens = new Set(tokens(slug));
  const found: string[] = [];
  for (const entity of vocab.entities) {
    const entityTokens = tokens(entity);
    if (entityTokens.every((t) => slugTokens.has(t))) found.push(entity);
  }
  // prefer more specific (more-token) entity names first
  return found.sort((a, b) => tokens(b).length - tokens(a).length);
}

// ---------------------------------------------------------------------------
// service inference (best-effort, for the optional Node.service field)
// ---------------------------------------------------------------------------

function inferService(slug: string, vocab: CatalogVocabulary): string | undefined {
  return entitiesFromSlug(slug, vocab)[0];
}

// ---------------------------------------------------------------------------
// heuristic candidate-edge generation (pass 2)
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
 * bury the useful edges in noise. Generic verb words, not toolkit-specific.
 */
const READ_VERBS = new Set(["list", "get", "search", "find", "query"]);
function producerRank(slug: string): number {
  return tokens(slug).some((t) => READ_VERBS.has(t)) ? 0 : 1;
}

/** Cap on how many producer tools we keep per (consumer tool, required field). */
const MAX_PRODUCERS_PER_FIELD = 6;

/** Producer index entry: a tool slug, and the entity it produces this leaf under (undefined
 *  when the leaf is only registered as a bare/distinctive candidate with no entity tag). */
type ProducerEntry = { producerSlug: string; entity: string | undefined };

function buildHeuristicEdges(tools: Tool[], vocab: CatalogVocabulary): CandidateEdge[] {
  const producerIndex = new Map<string, ProducerEntry[]>(); // raw leaf key -> producers

  function register(leaf: string, entity: string | undefined, producerSlug: string) {
    if (!producerIndex.has(leaf)) producerIndex.set(leaf, []);
    producerIndex.get(leaf)!.push({ producerSlug, entity });
  }

  for (const tool of tools) {
    const slug = slugOf(tool);
    if (!slug) continue;
    const rootEntities = entitiesFromSlug(slug, vocab);
    for (const { leaf, entity } of walkOutputLeaves(tool)) {
      const resolvedEntities = entity ? [entity] : rootEntities;
      if (resolvedEntities.length === 0 && !vocab.distinctiveLeaves.has(leaf)) continue;
      for (const e of resolvedEntities) register(leaf, e, slug);
      if (vocab.distinctiveLeaves.has(leaf)) register(leaf, undefined, slug);
    }
  }

  const edgeKeys = new Set<string>();
  const edges: CandidateEdge[] = [];

  function addEdge(producerSlug: string, consumerSlug: string, field: string) {
    if (producerSlug === consumerSlug) return;
    const key = `${producerSlug}=>${consumerSlug}=>${field}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from: producerSlug, to: consumerSlug, label: field });
  }

  for (const tool of tools) {
    const consumerSlug = slugOf(tool);
    if (!consumerSlug) continue;
    for (const rawField of extractRequiredInputs(tool)) {
      const field = toSnake(rawField);
      const matched = new Map<string, ProducerEntry>(); // producerSlug -> entry (dedupe)

      // bare/distinctive match: the whole field name equals a distinctively-scoped leaf key
      for (const entry of producerIndex.get(field) ?? []) {
        if (entry.entity === undefined) matched.set(entry.producerSlug, entry);
      }
      // qualified match: split at the last underscore, prefix must fuzzily name an entity
      // that produced the remaining leaf token
      const fieldTokens = field.split("_");
      if (fieldTokens.length >= 2) {
        const leafKey = fieldTokens[fieldTokens.length - 1];
        const prefix = fieldTokens.slice(0, -1).join("_");
        for (const entry of producerIndex.get(leafKey) ?? []) {
          if (entry.entity && entityMatchesWord(entry.entity, prefix)) matched.set(entry.producerSlug, entry);
        }
      }

      const ranked = [...matched.keys()]
        .filter((p) => p !== consumerSlug)
        .sort((a, b) => producerRank(a) - producerRank(b) || a.localeCompare(b))
        .slice(0, MAX_PRODUCERS_PER_FIELD);
      for (const producerSlug of ranked) addEdge(producerSlug, consumerSlug, field);
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
  for (const t of tools) {
    const slug = slugOf(t);
    if (slug) toolBySlug.set(slug, t);
  }

  // Pass 1: derive the entity/leaf vocabulary from this catalog alone.
  const vocab = buildVocabulary(tools);

  const nodes: Node[] = [...toolBySlug.keys()].map((id) => ({ id, service: inferService(id, vocab) }));

  // Pass 2: match required inputs against the vocabulary to produce candidate edges.
  const heuristicEdges = buildHeuristicEdges(tools, vocab);
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
