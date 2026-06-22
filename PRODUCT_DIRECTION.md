# Gozzle Product Direction

Captured while questioning whether what's built is a payable product and lives up
to "The ClickHouse brain in your AI agent." This is a strategy note, not a spec.

## The honest verdict

What's built today is an excellent **tool**, not yet a **product**. The
verification core is strong and hard to replicate — most people get dedup/FINAL
scope, mutation cost, and EXPLAIN-proven pruning wrong; Gozzle gets them right,
with a safety posture that holds up. That is a real moat and the right
foundation.

But as it stands Gozzle is **reactive, stateless, and narrow in stance**:

- **Reactive** — it only answers when an agent invokes a specific tool on a
  specific table/query. It never surfaces a problem you didn't know to ask about.
- **Stateless** — every call is cold. No model of *your* cluster, no memory of
  prior findings, no sense of what changed.
- **A verifier, not an advisor** — it proves facts; it doesn't carry judgment.

That combination is a **one-time audit**, which is the trap the implementation
plan already names ("recurring toolkit or one-time audit?"). People run a check,
fix the issue, and leave — hard to charge a subscription for.

"The ClickHouse **brain**" also oversells today's reality: the brain is Claude;
Gozzle is the **senses and the lab** (precise instruments that give the agent
ground truth). The gap to "brain" is not *smartness* — the checks are smart — it
is **stance**: reactive → proactive, stateless → context, verifier → advisor.

## The three additions (priority order)

These are additive to the verification core, not a rebuild.

### 1. Workload awareness — aggregate and flag (the product-maker)

Today Gozzle diagnoses *one* query when asked. The product version ingests
`system.query_log`, normalizes by query pattern, ranks by cost/frequency, and
**proactively flags the worst offenders**: "these 5 query shapes are 80% of your
scan bytes — here's why each is bad and the fix."

This single shift delivers what a paid product needs:

- **Recurring** — the workload changes weekly, so there's a reason to return.
- **Proactive** — finds problems the user didn't know to ask about (the "wow").
- **Aggregated value** — a ranked list of real problems beats a single verdict.

Defensible because it's Gozzle's ClickHouse expertise applied at fleet scale.
**This is the next thing to build**, because it is the hypothesis that decides
whether a recurring product exists at all.

### 2. Persistent context / memory of the cluster (earns the word "brain")

A retained model of *this* ClickHouse — its tables, which are
correctness-sensitive, prior findings, what changed. Every agent interaction then
gets that context for free, and value **compounds** with use. This is the
difference between a calculator and a brain, and it is what makes switching away
painful.

### 3. Baked-in skills + compose with the agent's skills

- **Baked-in**: encode ClickHouse judgment, not just checks — ORDER BY/partition
  design, projection/MV advice, schema review. Verifier → advisor.
- **Compose, don't replace**: keep the no-auto-fix stance, but return
  **structured outputs** so the agent's *own* skills act on findings (write the
  corrected query, draft the migration). Gozzle stays the source of truth; the
  agent stays the actor. This makes Gozzle a force-multiplier for Claude, not a
  competitor.

## What not to lose

The verification core and the safety/trust posture ("verdict + proof",
read-only, nothing leaves the machine). That is the wedge and the moat. Do not
dilute it into a generic AI database assistant.

## How this resolves open-core / monetization

- **Free (the wedge):** on-demand verification — the checks already built. Open,
  local, trust-building.
- **Paid (the brain):** the persistent, proactive layer — workload monitoring,
  cluster memory, flagging over time. Naturally recurring and naturally tied to
  something Gozzle operates, which justifies a subscription and a license check.

Free attracts; the brain is what they pay for.

## The next bet and how to measure it

Ship **#1 (query_log aggregation)** to the first design partners and watch one
signal: **do they come back next week without being prompted?** That answer is
worth more than any further analysis. If yes, there is a recurring product. If
no, it is an audit tool and the strategy must change.
