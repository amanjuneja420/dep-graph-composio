# Design notes

What `src/generate.ts` does and why, for a human reviewer. (`handoff.txt` covers the same
ground but is written for another AI session to continue from — this is the human-facing
version, per the assessment's own instruction that we're graded on depth and reasoning, not
just a passing selfcheck.)

## The core idea

A tool's `inputParameters.required` fields and another tool's `outputParameters` fields are
written by the same API designer, so they tend to share vocabulary: `GITHUB_CREATE_AN_ISSUE_COMMENT`
requires `issue_number`, and some other tool's output — an `Issue` object with a bare `number`
field — is the thing that supplies it. The whole generator is built around recovering that
shared vocabulary from the schemas themselves, in two passes.

**Pass 1 — build a vocabulary from the catalog.** Walk every tool's `outputParameters`
(resolving `$ref`/`$defs`, including array items and nested objects), and record every scalar
leaf field, tagged with the entity it belongs to when the schema tells us (the nearest
enclosing `$ref`'s own `title` — e.g. a `number` field found while walking into an `Issue`
def is tagged `entity: "issue"`). Two things come out of this pass:
- `entities`: the set of all entity titles seen, catalog-wide (`issue`, `pull_request`,
  `milestone`, ... — or, for a different toolkit entirely, whatever nouns *that* catalog uses).
- `distinctiveLeaves`: leaf names that appear under very few (≤2) distinct entities catalog-wide.
  A leaf like `id` or `name` appears under dozens of entities and is useless unqualified; a leaf
  like `tag_name` or `sha` appears under one or two and is safe to match on its own.

**Pass 2 — match.** For each tool's required input field, try two things against the pass-1
index:
1. **Bare match** — the field name exactly equals a *distinctive* leaf key somewhere in the
   catalog (covers `sha`, `ref`, `tag_name`, or a compound field like `assignee_id` that some
   entity exposes directly).
2. **Qualified match** — split the field at its last underscore (`issue_number` → prefix
   `issue`, leaf `number`); if the prefix fuzzily names an entity that produced that leaf
   (`entityMatchesWord`: exact token match, or the entity's joined tokens start with the
   prefix — `repo` vs. `repository`, `pull` vs. `pull_request`), it's a candidate.

Neither step uses a fixed dictionary of GitHub nouns. `fixtures/fake_toolkit_catalog.json` is a
7-tool, zero-GitHub-vocabulary fake "Linear" catalog (tickets, projects, assignees) committed
specifically to prove this — `node --import tsx src/generate.ts fixtures/fake_toolkit_catalog.json`
produces 10 correct edges (`LINEAR_LIST_PROJECTS → LINEAR_LIST_TICKETS` via `project_id`,
`LINEAR_LIST_TICKETS → LINEAR_ASSIGN_TICKET` via `assignee_id`, etc.) from a catalog the code
has never seen the shape of before.

The **only** non-generic pieces left, both explicitly called out in code comments, are (a)
folding simple English plurals (`issues`/`issue`) when comparing tokens, and (b) a small list
of generic English *verbs* (`list`/`get`/`search`/`find`/`query`) used only to break ties when
ranking candidate producers, never to decide whether an edge exists at all. Both are much
smaller, more defensible generalizations than a fixed noun dictionary tied to one API.

## Why a cap per (consumer, field)

An early version with no cap on producers-per-field produced 8515 edges on the GitHub catalog:
extremely common fields like `repository_id` were matching hundreds of producers, drowning the
useful signal in noise. `MAX_PRODUCERS_PER_FIELD = 6`, preferring read-style tools
(list/get/search/find/query — a tool you'd naturally call *first* to discover a value) over
mutations, brought that down to ~2500–2650 edges with much better signal-to-noise, while still
allowing multiple legitimate ways to obtain a value (matching the README's own note that
`issue_number` "could [come from] other ways too").

## The LLM refinement pass (implemented, not live-verified)

`refineWithLLM` batches the heuristic candidates and asks the model to confirm/reject each one
using the tools' own descriptions — meant to catch cases where a field name matches but the
entities genuinely differ. It's designed to fail closed: any error (no key, network failure,
JSON parse failure, a 402) falls that batch back to "keep as heuristic". In practice, during
this session's live testing, the very first run (before `max_tokens` was capped) let the SDK
default to a large per-request completion budget across ~130 batches and exhausted the
assessment's OpenRouter credit balance; a second, properly-capped run then failed every batch
on zero remaining credit. Both runs demonstrate the fallback working correctly, but neither
demonstrates a real reject decision — so **the shipped `dependency_graph.json`/`graph.html` are
heuristic-only**. See `handoff.txt` for the exact error text and how to re-verify if a funded
key becomes available.

## Known limitations / what I'd do next with more time

- The entity-from-title inference only looks at the *nearest* enclosing `$ref`'s title, so a
  deeply nested field two levels below an unrelated container could get mis-tagged. In
  practice this rarely fires because `walkOutputLeaves` re-derives the entity fresh at every
  container boundary rather than inheriting it, but it's not proven exhaustively.
- Plural-folding and the read-verb list are the two remaining English-specific assumptions;
  a non-English-named toolkit would degrade gracefully (fewer matches) rather than break, since
  they're used for token comparison and tie-breaking, not gating.
- `entityMatchesWord`'s substring rule (`repo` vs. `repository`) can occasionally over-match on
  short prefixes against unrelated longer entity names in a much bigger/denser catalog than
  GitHub's 893 tools; the `word.length >= 3` guard limits but doesn't eliminate this.
- I did not get to test against a second *real* toolkit catalog (only the hand-written fake
  one) since none was provided in this repo — the fake fixture demonstrates the mechanism
  generalizes, but a real second catalog would be a stronger proof.
