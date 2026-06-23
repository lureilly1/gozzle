# gozzle — Verification Model (exact vs. sampled)

Expands guardrail A of `PRODUCT_DIRECTION.md`. The job: keep a `correct` verdict
trustworthy when you **cannot** replicate a billion-row table locally, while
staying seamless and never leaving scan artifacts behind.

## The reframe: push the comparison to the source, don't pull the data

The spec leaned on "replicate a representative slice locally." That is the wrong
default. The cheapest *and* most exact path is usually the opposite:

> Run the correctness comparison **inside the source engine** (read-only). The
> cluster does the aggregation over all N rows; gozzle transfers only a verdict
> and a small capped sample of divergent rows.

This is exactly how `verify_dedup` already works — it scans full partitions on
the cluster with one aggregate query and never pulls rows. It scales to 1B rows
because ClickHouse aggregates server-side. **Local replication is needed only
when the artifact cannot be run against production** — chiefly a migration's
`ALTER`/`UPDATE`/`DELETE`, which we must never apply to prod. So the
"can't-fit-locally" problem is confined to the migration shadow-execution case,
not the whole product.

## The asymmetry that makes this tractable

> A sample can **prove `incorrect`** but can never **prove `correct`**.

Finding one diverging row in any sample is definitive proof of incorrectness.
Finding none only means "none in what we looked at." So:

- `incorrect` is cheap — often catchable from a small/fast pass.
- `correct` is expensive — it requires an **exact** method.

gozzle exploits this: try the cheap pass first to catch obvious bugs, and only
spend the exact pass to upgrade `likely-correct → correct`.

## Verdict model

```
verdict: "correct" | "incorrect" | "likely-correct" | "indeterminate"
method:  "exact-source" | "exact-replica" | "sampled"
coverage: { scope: "table" | "partition" | "sample",
            rowsCompared: number, ofTotal?: number, note?: string }
```

- **`correct`** — only from `exact-source` or `exact-replica`. Never from a
  sample. Carries the exact scope it holds for (whole table, or a named
  partition).
- **`incorrect`** — divergence proven; valid from *any* method (including a
  sample) because a found divergence is real. Carries the divergent-row sample.
- **`likely-correct`** — `sampled`, no divergence found; always with coverage
  stats. Never silently upgrades to `correct`.
- **`indeterminate`** — couldn't verify within budget/guardrails; carries a
  reason and an actionable next step ("scope to partition X", "raise the scan
  guard").

## Method selection (the seamless decision tree)

For each check, in order:

1. **Exact in-source?** If the check is a read-only comparison the engine can run
   (dedup, equivalence via `EXCEPT`/symmetric-difference count, grain via key
   uniqueness, predicate-matched migration impact counts) → run it server-side,
   bounded by the existing scan guard (`max_execution_time`,
   `GOZZLE_DEDUP_MAX_SCAN_*`). Result: `correct`/`incorrect`, `method:
   exact-source`, `scope: table`.
2. **Scan too big for the guard?** Return `indeterminate` with "scope to
   partition X" — or, when the check is partition-decomposable, auto-scope to the
   relevant/recent partition and return an exact verdict labelled `scope:
   partition`. (Partition-exact is the sweet spot: exact within a bounded slice.)
3. **Must execute an un-runnable-on-prod artifact (migration)?**
   a. Estimate scope from metadata (exact, in-source) — this alone gives the
      "what it touches" impact today.
   b. If the scope fits the local budget → **full local replica** → run
      as-written vs. reference, diff → `exact-replica` verdict.
   c. Else → **sampled replica** (see representativeness) → `likely-correct` /
      `incorrect` / `indeterminate`, with coverage; offer partition-scoped exact
      as the upgrade path.
4. Always tear the replica down (see cleanup).

The user never picks a method; gozzle picks the most-exact feasible one and
labels it. The only time it asks for input is to *scope* an otherwise-too-big
exact check.

## Per-check mapping

| Check | Primary method | Notes |
|---|---|---|
| `verify_dedup` | exact-source | shipped; full-partition aggregate, no replica |
| read-path proof | exact-source | runs dedup on the trusted table |
| `verify_equivalent` | exact-source | `(A EXCEPT B) UNION (B EXCEPT A)` count = 0 |
| `verify_grain` | exact-source | row-count / key-uniqueness checks |
| migration **impact** | exact-source | predicate-matched rows/parts/bytes (shipped) |
| migration **data correctness** | exact-replica if it fits, else sampled | the only check that forces replication |
| `verify_semantics` | exact-source | NULL/tz/float comparisons as SQL |

The takeaway: **only migration data-correctness is sampling-bound.** Everything
else is exact-in-source and scales to any table size (subject to the scan guard).

## Representativeness (only relevant to the sampled fallback)

When sampling is unavoidable, bias toward where divergence hides rather than
uniform random:

- **Prefer partition-exact** over a random row sample: replicate one or a few
  *complete* partitions (exact within them) instead of scattered rows. Bounded
  and exact-per-partition.
- Stratify toward recent partitions, NULL-heavy ranges, and high-cardinality
  keys (where dedup/grain bugs concentrate).
- Always report coverage (`rowsCompared`, `ofTotal`, strategy) in the honesty
  footer. A `likely-correct` with "sampled 250k of 1.2B (0.02%, 3 recent
  partitions)" is honest; it never becomes `correct`.

Open research (the gating problem): there is **no general guarantee** a sample
surfaces low-frequency divergence — which is precisely why a sample can never
return `correct`. The product makes `likely-correct` genuinely useful and honest
instead of pretending.

## Storage & cleanup (must be seamless and self-tidying)

Two replica lifetimes, kept distinct:

- **Ephemeral verify replicas (default, new):** created under
  `~/.gozzle/tmp/<run-id>` for a single `verify` run, torn down in `finally` —
  success or failure. Never retained.
- **Persistent slices (`create_local_slice`, existing):** explicit, retained for
  reproduction, with the existing retention warnings and `gozzle slices clean`.

Required plumbing for the ephemeral path:

1. **Budget gate before replicating** — refuse (→ sampled/indeterminate) when the
   scope exceeds `GOZZLE_MAX_SLICE_ROWS/BYTES`, and **check free disk** before
   writing; never fill the disk.
2. **Guaranteed teardown** — `try/finally` rm of the run dir; the streaming
   Parquet/chDB path already avoids buffering rows in Node.
3. **Orphan sweep** — on every gozzle invocation, best-effort remove
   `~/.gozzle/tmp` entries older than a short TTL (covers crashes/SIGKILL), plus
   an explicit `gozzle gc`. This is the safety net for "clearing up after scans."
4. **Process-exit handler** — clean the current run dir on SIGINT/SIGTERM.

## What this changes vs. the spec / guardrail A

- Guardrail A stands, sharpened: `correct` ⟺ exact (`exact-source` **or**
  `exact-replica`); sampling yields `likely-correct`/`incorrect`/`indeterminate`.
- The spec's "replicate a slice" is demoted from default to a migration-only
  fallback. **Exact-in-source is the default and is what scales to 1B rows.**
- New verdict states `likely-correct` (was implied) and the `method`/`coverage`
  fields become part of every check's contract and the diff-report footer.

## Already built vs. to build

- **Built:** exact-in-source `verify_dedup`; the scan guard →
  `indeterminate`-style "scope to a partition"; slice budgets; streaming replica;
  persistent slice cleanup.
- **To build:** the unified `verdict/method/coverage` contract across checks; the
  ephemeral verify-replica lifetime + orphan sweep + `gozzle gc`; the sampled
  fallback (partition-exact-first) with honest coverage; `verify_equivalent` as
  the first new exact-in-source check (cheap, high-value, validates the model).
