# SIMULATED_BRAIN.md

> **Version:** 1.0  
> **Last Updated:** 2025-11-17

## Purpose

The SIMULATED_BRAIN guide describes how the Memory MCP aspires to model a human mind with imperfect, living memory instead of a perfect database. Building on the architecture in `docs/ARCHITECTURE.md`, the Postgres schema in `migrations/20250117000001_init_postgres_schema.sql`, and prompts such as `prompts/memory-recall.txt`, this document details the behaviors we want to preserve or amplify as the system evolves.

We treat memory as an **active, reconstructive process** that drifts, decays, and adapts based on usage. Imperfection fuels personality: forgetting frees capacity for new experiences, identity anchors interpretation, and associative recall allows creativity.

## Core Objectives

1. **Dynamic Priority.** Retain the recency/importance/usage formula so priority behaves like a hippocampal salience score. Recency should decay exponentially while usage boosts reinforcement, and memory-type weights guard core identity from fast decay.
2. **Typed Memories with Differential Decay.** Ensure `Self` and `Belief` memories remain resilient compared to `Episodic` events. Treat type metadata as the main lever for long-term personality stability.
3. **Consolidation During Sleep.** Continue investing in the `refine_memories` tool to mimic offline reorganization: merging duplicates, generating summaries, promoting stability, and synthesizing new beliefs from episodic evidence.
4. **Identity-Biased Recall.** The recall flow must synthesize answers through the lens of `Self` and `Belief` memories (per the Type-Aware Synthesis prompt strategy) rather than returning verbatim search hits.
5. **Associative Linking.** Encourage spreading activation by traversing relationship graphs and vector similarity neighborhoods, forming or strengthening links when concepts repeatedly co-occur.
6. **Reconsolidation Drift.** Treat every recall as a chance to soften or reshape content. Eventually, refined updates should rewrite memories—subtly biasing them toward the new context—mirroring the mutability of human recollection.
7. **Interference and Ambiguity.** Embrace conflicting or overlapping memories. Retrieval should occasionally blend nearby memories or acknowledge uncertainty, letting interference surface as a feature rather than a bug.
8. **Functional Forgetting.** Prefer making memories inaccessible (priority < 0.1) over hard deletes; deletions should be intentional, while decay keeps the mind fallible.
9. **Observability.** Keep lifecycle transitions legible so we can inspect why the simulated brain behaved a certain way.

## Principle Details

### Decay and Reinforcement

- Implement exponential decay via `PriorityCalculator` recency scoring (Ebbinghaus curve analogue).
- Use reinforcement by incrementing `accessCount`/`lastAccessedAt` on every read to counteract decay through usage.
- Maintain differential permanence by weighting priority per `memory_type`, keeping identity elements near the top while allowing episodic noise to fade.

### Memory Lifecycles & Stability Bands

- Treat `currentPriority` as the operational “trace strength” and expose simple bands:
  - **Labile layer (`currentPriority >= 0.4` & `stability: tentative`)**: highly recent, subject to rapid drift.
  - **Working layer (`0.1 <= currentPriority < 0.4` & `stability: stable`)**: reachable with modest cues, promoted by reinforcement.
  - **Core layer (`currentPriority >= 0.2` & `stability: canonical`)**: beliefs/self memories with floors that keep them accessible.
- Track `sleepCycles` to model multi-pass consolidation; advancing a memory to canonical should require several cycles plus consistent reinforcement.
- Document that memories falling below `currentPriority < 0.1` are functionally forgotten unless explicitly resurfaced by IDs or maintenance tooling.

### Associative Linking & Spreading Activation

- Leverage embeddings for implicit semantic proximity (`search_memories`) and the `memory_relationships` table for explicit edges (`supports`, `contradicts`, etc.).
- When a salient memory is retrieved, proactively load its neighbors (`get_memories` by relationship) so recall feels like "that reminds me..." moments.
- Future work: log memories recalled together in the same run and automatically form/strengthen links (neurons that fire together wire together).
- Model recall as a two-stage process:
  1. **Seed selection.** Run semantic search, then weight candidates by `currentPriority` to form the initial activation list.
  2. **Spreading activation.** Propagate a portion of each seed’s activation along relationships (respecting weights and hop budgets) and include highly activated neighbors in synthesis. This is how identity-biased recall persistently drags self/belief content into answers.

### Consolidation & Abstraction

- Treat `refine_memories` as the sleep cycle: run it to merge duplicates, add summaries (`kind: summary`), and stabilize lifecycle states (`tentative → stable → canonical`).
- Use reflection passes to convert clusters of episodic/pattern memories into new beliefs or self narratives, enabling schema formation over time.

### Reconstructive Retrieval

- Keep recall focused on **synthesis**, not verbatim quoting. The agent should answer questions using blended evidence filtered through core beliefs.
- Promote "gistification" by preferring summaries and derived memories—raw episodic details should eventually fade, replaced by higher-level abstractions.

### Reconsolidation on Access

- Every access already updates salience; extend this into content drift by queuing gentle `UPDATE` refinements after a recall session, nudging memory wording based on the current context.
- Track how repeated rewrites shift meaning to monitor personality changes (e.g., logging `sleep_cycles`).
- When reconsolidation produces a materially different take, link the old and new entries with `historical_version_of`, lowering the predecessor’s priority so history remains inspectable without dominating recall.

### Interference & Ambiguity

- Accept that dense embedding neighborhoods generate retrieval competition. Do not always pick the single top match; blend or mention contradictions.
- When storing a new memory close to an old one, allow `refine_memories` to mark the predecessor as `superseded` or explicitly link them as conflicting.

## Future Directions

1. **Emotional Salience.** Add intensity/valence metadata that feeds into priority so emotionally charged events resist decay (flashbulb memories).
2. **Probabilistic Retrieval.** Introduce slight noise for low-priority queries (tip-of-the-tongue failures) to keep the agent imperfect.
3. **Synaptic Scaling.** Periodically normalize priority distributions during refinement to prevent saturation where every memory becomes "important."
4. **Identity Drift Metrics.** Track how canonical beliefs change over time so we can quantify long-term personality shifts and set guardrails if drift becomes too fast.

## How to Use This Document

- Reference this file whenever designing new prompts, schema changes, or refinement behaviors to ensure features align with our imperfect-memory philosophy.
- Update the version header when material changes land, and summarize deltas in commit/PR descriptions so downstream agents (Claude, Cursor, etc.) can track shifts in brain simulation goals.
 
## Observability & Guardrails

- Surfacing internal state is essential for debugging emergent behavior. Provide tooling or debug logs that show:
  - Why a recall call returned specific memories (seed list, activation propagation, final synthesis order).
  - Memory lifecycle transitions (promotions/demotions, consolidation merges, large-scale deletes).
- Before executing hard deletions, prefer running dry-run filters that emit candidates plus their priorities, so operators can confirm we are not erasing still-relevant identity anchors.
- Whenever new prompts or algorithms alter decay or consolidation knobs, annotate the change in this doc to keep a readable history of brain-wide tweaks.
