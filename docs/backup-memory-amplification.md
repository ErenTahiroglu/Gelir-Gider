# Backup memory / byte amplification profiling

Post-Phase-20 follow-up B. Answers whether the `GG_BACKUP_V1` export/encrypt/
upload/verify pipeline has an adequate safety margin at its current
`DEFAULT_MAX_PLAINTEXT_BYTES = 25 MiB` ceiling, using a reproducible harness.

**Outcome: the production 25 MiB ceiling is UNCHANGED.** No `src/backups/*`
code was modified in this checkpoint. See "Hardening decision" below.

## Harness

| Artifact | What it does | Runs in `npm run check` |
| --- | --- | --- |
| `tests/helpers/backup-memory-profile.ts` | Deterministic synthetic-data generator (seeded LCG, no `crypto.randomUUID`) + a `runAmplificationPipeline` that walks the nine real pipeline stages recording the byte size of every transient buffer/string, + `buildStaticProfileTx` (fake `DatabaseTransaction`) | n/a (helper) |
| `tests/backups-memory-amplification.test.ts` | Permanent regression coverage: (1) size-guard timing, (2) deterministic byte amplification at 1/5/10/15/20/25 MiB + one over-limit case | yes |
| `scripts/profile-backup-memory.ts` | The same sweep with Node `heapUsed/heapTotal/external/arrayBuffers/rss` sampled at every stage boundary (optionally `--expose-gc`). Run: `node --expose-gc --import tsx scripts/profile-backup-memory.ts` | no (diagnostic only) |

Synthetic rows are representative: UUID/scalar columns, strings, a
numeric-as-string money column, ISO timestamp strings, a nested JSON-like
object, and a JSON-like array; tens of thousands of rows per size to model
object-graph amplification. No fixtures are committed — data is generated in
memory at runtime.

Three evidence classes are kept strictly separate:

* **Deterministic byte amplification** — pure `TextEncoder` / base64 / AES-GCM
  output-length arithmetic. Runtime-independent, authoritative, asserted in
  the gate.
* **Node diagnostic memory** — `process.memoryUsage()` from
  `scripts/profile-backup-memory.ts`. Noisy (`rss` especially); indicative of
  order-of-magnitude, never a CI threshold.
* **Cloudflare/workerd evidence** — the gate suite already runs under the
  `@cloudflare/vitest-plugin` (workerd) pool, so the byte-amplification
  assertions and the guard-timing proof execute in workerd. But that pool
  reports `process.memoryUsage()` as **all-zero** and exposes no `gc`, so an
  **authoritative workerd isolate peak-memory figure cannot be captured in
  this environment**.

## 3B — Where the size guard fires

* **Is 25 MiB only a serialized-payload ceiling?** **Yes.** It is enforced
  only by `buildSnapshotPayload`, which throws `BACKUP_TOO_LARGE` when
  `TextEncoder().encode(JSON.stringify({ manifest, tables }))` exceeds the
  limit. It is not a memory limit and nothing enforces it earlier.

* **How much work/data is materialized before the ceiling is enforced?**
  For an over-limit dataset, `exportDatabaseSnapshot` runs to completion
  first and returns normally. By the time it returns it has, for **every**
  registry table: loaded the full row set (`rawRows`), built a normalized
  copy (`rows.map(normalizeRow)`), sorted it by full canonical-JSON key and
  SHA-256-hashed it (`computeTableContentHash` — which internally holds a
  second full array of every row's canonical-JSON string), and kept the
  sorted `TableSnapshot`. It then runs its **own** full
  `TextEncoder/JSON.stringify` pass over every table's rows to compute
  `plaintextSizeBytes` (already `> 25 MiB` at this point, with no throw).
  Only afterwards does `buildSnapshotPayload` build the manifest (another
  full `stringifyCanonical` pass) and serialize the whole payload a further
  time before finally throwing. So the entire plaintext object graph is
  materialized once and fully re-serialized **~3×** before the guard trips.
  `tests/backups-memory-amplification.test.ts` → "backup size guard timing"
  locks this in.

## 3B — Observed amplification by size / stage

Deterministic bytes from `runAmplificationPipeline` (identical under Node and
workerd). `plaintext` = stage-3 serialized payload; `envelope` = stage-6
bytes uploaded to R2; `Σ transient` = sum of all nine stage allocations.

| target | rows | plaintext | envelope | envelope ÷ plaintext | Σ transient | Σ ÷ plaintext |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 MiB  |  1 719 |  1.08 MiB |  1.45 MiB | ×1.334 |  11.0 MiB | ×10.2 |
| 5 MiB  |  8 595 |  5.10 MiB |  6.79 MiB | ×1.333 |  52.5 MiB | ×10.3 |
| 10 MiB | 17 190 | 10.11 MiB | 13.48 MiB | ×1.333 | 104.3 MiB | ×10.3 |
| 15 MiB | 25 785 | 15.13 MiB | 20.18 MiB | ×1.333 | 156.2 MiB | ×10.3 |
| 20 MiB | 34 380 | 20.16 MiB | 26.88 MiB | ×1.333 | 208.1 MiB | ×10.3 |
| 25 MiB | 42 974 | 25.17 MiB | 33.57 MiB | ×1.333 | 260.0 MiB | ×10.3 |
| 30 MiB (over) | 51 569 | 30.19 MiB | 40.26 MiB | ×1.333 | 311.8 MiB | ×10.3 |

Per-stage transient size, as a multiple of the plaintext payload (constant
across sizes; snapshot-locked in the test at 5 MiB):

| # | stage | ×plaintext |
| --- | --- | ---: |
| 1 | raw table object graph (`JSON.stringify` bytes) | 0.98 |
| 2 | normalized + sorted `TableSnapshot` rows | 0.98 |
| 3 | serialized plaintext payload (`Uint8Array`) | 1.00 |
| 4 | AES-GCM ciphertext (`ArrayBuffer`) | 1.00 |
| 5 | ciphertext → base64 string | 1.33 |
| 6 | serialized envelope (uploaded bytes) | 1.33 |
| 7 | R2 read-back `ArrayBuffer` | 1.33 |
| 8 | `JSON.parse` of read-back envelope (re-materialized base64) | 1.33 |
| 9 | decrypt + manifest verification re-parse | 1.00 |

Node diagnostic memory (from `scripts/profile-backup-memory.ts`,
`node v26.8.1 --expose-gc` on macOS; **DIAGNOSTIC, not a workerd isolate
peak**):

| target | Node `heapUsed` peak | Node `rss` peak |
| ---: | ---: | ---: |
| 1 MiB  |  17 MiB | ~206 MiB |
| 5 MiB  |  35 MiB | ~429 MiB |
| 10 MiB |  57 MiB | ~728 MiB |
| 15 MiB |  77 MiB | ~1.0 GiB |
| 20 MiB |  99 MiB | ~1.4 GiB |
| 25 MiB | 121 MiB | ~1.8 GiB |
| 30 MiB | 142 MiB | ~2.2 GiB |

`rss` is dominated by V8/OS allocator retention and is deliberately not used
for any assertion. `heapUsed` grows ≈ linearly at ≈ 4.8× the target size.

### Which stage produces the highest observed memory pressure?

* **Deterministic bytes:** stages 5–8 hold the widest single objects — the
  base64 ciphertext string (×1.33), the serialized envelope, the R2 read-back
  buffer, and the re-parsed envelope — and stage 8 is the point where the
  most large objects are simultaneously reachable (uploaded envelope bytes +
  read-back bytes + parsed-envelope base64, on top of a still-referenced
  plaintext), roughly ×4 of the plaintext concurrently live at 25 MiB
  (≈ 100 MiB).
* **Node `heapUsed` step change:** the single biggest jump is **stage 4,
  AES-GCM encryption** (`crypto.subtle.encrypt` materializes a full separate
  ciphertext `ArrayBuffer` while the plaintext is still live: +14–40 MiB
  depending on size), followed by **stage 8, `JSON.parse` of the read-back
  envelope** (+13–40 MiB).

## 3C — Hardening decision

The deterministic evidence (authoritative) shows the pipeline walks ≈ 10×
the plaintext in transient allocations and holds on the order of 4× the
plaintext concurrently live at the ceiling, and Node diagnostics put
`heapUsed` at ≈ 121 MiB for a 25 MiB backup — i.e. already near a typical
128 MiB Workers isolate soft limit *in Node*. That is a plausible
inadequate-margin signal.

However, this environment **cannot establish an authoritative safe
threshold for the Cloudflare isolate**: the workerd test pool reports zeroed
`process.memoryUsage()` and no `gc`, and Node figures are explicitly not a
workerd peak. Per the follow-up's own decision rule for that case, and to
respect "smallest safe fix":

* the production **25 MiB `DEFAULT_MAX_PLAINTEXT_BYTES` ceiling is left
  unchanged**;
* the reproducible harness + permanent regression tests are committed;
* **`GG_BACKUP_V1` format, AES-GCM encryption/authentication, and post-upload
  read-back verification are untouched**; there is no restore-compatibility
  change (`scripts/restore-backup.ts` reuses `exportDatabaseSnapshot`
  unchanged);
* **no streaming/multipart Backup V2 architecture** was introduced.

### Recommended follow-up (not done here — needs a real workerd memory measurement)

An **earlier cumulative fail-fast** inside `exportDatabaseSnapshot`:
accumulate the per-table serialized size it already computes and throw
`BACKUP_TOO_LARGE` as soon as the running total crosses the ceiling, instead
of only after every table is materialized, hashed, and fully re-serialized
twice more. This is byte-for-byte inert for within-limit backups, changes no
format/crypto/verification, and strictly reduces worst-case materialization
for an over-limit database. It was deliberately deferred because it also
touches the restore re-export path and the safety benefit cannot be
quantified without an authoritative isolate-memory figure this environment
does not provide.

## Remaining Cloudflare-specific uncertainty

* No authoritative workerd/isolate peak-memory measurement is possible here
  (zeroed `process.memoryUsage()`, no `gc`, no production credentials).
* Whether a 25 MiB (→ ≈ 34 MiB envelope, ≈ 100 MiB concurrently live,
  ≈ 260 MiB cumulative transient) backup actually OOMs a production Workers
  isolate is **not proven either way** — it depends on the isolate's real
  memory limit and GC behaviour under this allocation pattern, which must be
  measured with `wrangler dev`/`workerd` observability or a real invocation
  before the ceiling is lowered or the fail-fast guard is added.
