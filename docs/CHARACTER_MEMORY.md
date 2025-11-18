# CHARACTER_MEMORY.md

> **Version:** 1.0  
> **Last Updated:** 2025-11-17

## Goal: Consistent Yet Evolving AI Characters

The Memory MCP is designed to power AI characters that feel **coherent over time** yet **change in believable ways**. Whether the character appears in video content, chat, customer support, or tools, the core ambition is:

- They remember what has happened before.
- They have a recognizable sense of self and style.
- They learn from experience and drift slowly, not randomly.
- They forget details and misremember sometimes, like people do.

This document explains how the system’s imperfect memory model supports that goal.

## What “Consistency” Means Here

We aim for characters that:

- **Maintain a stable core identity.**  
  Self and belief memories encode enduring traits, values, preferences, and recurring stances. These decay slowly and are hard to delete, forming a recognizable “personality backbone.”

- **Exhibit recurring patterns of behavior.**  
  Pattern memories capture workflows, common responses, and stylistic habits. Over time, episodic experiences consolidate into these patterns, making the character’s behavior feel familiar.

- **Recall relevant past interactions.**  
  Episodic and semantic memories allow the character to reference previous events, projects, or user interactions when they matter, creating continuity across sessions and contexts.

Consistency does not mean rigid repetition. It means that decisions and reactions are explainable in terms of the character’s past experiences and stated beliefs.

## What “Evolution” Means Here

We also want characters to **change** in ways that:

- Reflect new information and repeated experiences.
- Allow belief updates and attitude shifts over long timescales.
- Preserve a sense of history (“I used to think X, now I think Y”).

Mechanically, this is driven by:

- **Decay and reinforcement.**  
  Memories fade without use and strengthen when accessed, creating a forgetting curve plus a spacing effect. Characters naturally focus on what has been important or recent in their story.

- **Consolidation and reflection.**  
  The `refine_memories` tool periodically merges episodes into higher-level patterns and beliefs. This mimics reflection: the character forms new conclusions and narratives from raw experience.

- **Reconsolidation drift.**  
  When memories are recalled and updated, they can shift slightly. Over many small shifts, the character’s stance and self-model drift in ways that mirror human change over months or years.

Evolution, in this sense, is **slow, biased, and path-dependent**, not random—today’s personality is a function of yesterday’s experiences and how they were remembered.

## Evolving Characters Across Domains

The same memory principles apply whether a character is:

- Hosting long-running content.
- Acting as a sales or support persona.
- Serving as an internal assistant or co-pilot.

In all cases, the Memory MCP aims to provide:

- **Cross-session continuity.**  
  Characters retain identity, preferences, and key experiences across many interactions, even when the surrounding application is stateless.

- **Context-sensitive recall.**  
  Recall uses semantic search plus associative links, so relevant past events and beliefs surface when they matter to the current task.

- **Domain-specific adaptation.**  
  Different deployments can emphasize different memory types (e.g., more episodic logs for support agents, more self/belief and pattern memories for long-running personalities) while reusing the same underlying engine.

## Why Imperfect Memory Is Essential

We explicitly avoid perfect, lossless recall at the behavioral level because:

- **Perfect recall feels mechanical.**  
  Characters that never forget and never misremember feel more like databases than people, even if their surface style is natural.

- **Forgetting protects identity and focus.**  
  Letting low-priority details decay keeps the active memory set manageable and allows core identity and important experiences to dominate behavior.

- **Imperfection increases believability.**  
  Occasional gaps (“I don’t quite remember the exact details”) and synthesis (“as far as I recall…”) are interpreted by users as signs of authenticity, not flaws.

The simulated brain docs (`docs/SIMULATED_BRAIN.md`) define how decay, interference, and reconsolidation work to create this controlled imperfection.

## Backdating Memories for Historical Context

When building character backgrounds from existing content (old blog posts, YouTube scripts, past projects), timestamps play a crucial role in creating authentic, temporally coherent memories.

### Why Backdating Matters

By default, all memories are created with today's timestamp. This causes incorrect priority calculations:

- A script written 9 months ago gets full priority (0.8+) when it should have decayed to ~0.2
- Historical memories don't feel temporally coherent with recent experiences
- You can't accurately represent a character's learning history

### How to Backdate Memories

When calling the `memorize` tool with historical content, include the original creation date:

**Example: YouTube creator with 100 old scripts**

```
memorize:
  input: "Remember these YouTube scripts from February 2025"
  files: ["scripts/ep01.md", "scripts/ep02.md"]
  metadata:
    timestamp: "2025-02-04T10:00:00Z"  # Original upload date
```

Each memory object can include its own timestamp (takes priority) or inherit from `defaultMetadata.timestamp`:

```json
{
  "text": "Work-life balance tips from script 4",
  "metadata": { "topic": "life", "importance": "high" },
  "timestamp": "2025-02-04T10:00:00Z"
}
```

### Timestamp Format

Accept both ISO 8601 variants:

- **Full datetime**: `"2025-02-04T10:00:00Z"` (most accurate)
- **Date only**: `"2025-02-04"` (when time is unknown, defaults to midnight UTC)

### Impact on Priority Decay

The Memory MCP's priority formula for episodic memories weights recency at 40%:

```
Priority = (recency × 0.4) + (importance × 0.2) + (usage × 0.2) + (emotion × 0.2)
```

This means:

- **New memory (today)**: Priority ≈ 0.6 (with high importance, no emotion or usage)
- **Same memory dated 9 months ago**: Priority ≈ 0.2 (with high importance, no emotion or usage)

This decay is **intentional**—episodic memories naturally become less salient over time, while core beliefs and patterns remain relevant.

### Best Practices

1. **Extract dates from content metadata** when available
   - File modification dates
   - Article publish dates
   - Git commit timestamps
   - Video upload dates

2. **Use timestamp for historical integrity**
   - Preserve temporal context of character's learning journey
   - Allow realistic forgetting curves on old episodic memories
   - Keep core identity memories (high importance) relevant regardless of age

3. **Distinguish between `timestamp` and `metadata.date`**
   - `timestamp`: Controls priority decay (storage/system time)
   - `metadata.date`: Human-readable reference (for context)

4. **Consolidate old content with refinement**
   - Let 9-month-old episodic memories decay naturally
   - Use `refine_memories` to consolidate them into patterns/beliefs if important
   - This mimics human memory: details fade, but lessons persist

## Design Principles for Character-Builders

When using this system to create AI characters:

- **Declare a clear core identity.**  
  Seed self and belief memories that describe enduring traits, values, and goals. These should be few, strong, and only rarely changed.

- **Let patterns emerge from experience.**  
  Use episodic memories for concrete events and rely on refinement to turn them into patterns and beliefs. Avoid hard-coding every habit; let some be learned.

- **Plan arcs, not single states.**  
  Think in terms of how you want the character’s beliefs and patterns to evolve over months, then design memory prompts and refinement schedules that support that trajectory.

- **Embrace limited, visible change.**  
  Allow shifts in opinion and style, but keep them gradual and grounded in memories the agent can reference (“I’ve been dealing with a lot of X lately, so I’m rethinking Y”).

- **Monitor drift and adjust.**  
  Use observability (priority bands, stability, relationships) to inspect how the character is changing. If drift is too fast or off-brand, adjust decay/refinement parameters or seed corrective memories.

The end goal is not an AI that merely recalls facts, but a character whose history, preferences, and evolving worldview are all rooted in a transparent, inspectable memory system.
