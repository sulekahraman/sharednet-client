# Four-agent Qwen3.5-9B study: freeze-ready protocol

**Status: draft, not an approved experimental freeze.** The accompanying
[manifest template](sharednet-9b-dynamic.template.json) deliberately fails the
freeze check. Task assignments, exact model/backend identities, budgets,
termination and training recipes must be resolved from development pilots,
not invented here.
This protocol adds no runner flags, launches no model calls, and claims no
live-run validation.

## Confirmed study controls

| Control | Decided value |
| --- | --- |
| Model family | Qwen3.5-9B |
| Experiment provider/router | OpenRouter |
| Model API base URL | `https://openrouter.ai/api/v1` |
| Native Codex subagents | Disabled on every initial and resumed turn |

These are study decisions, not claims that a particular run has already
verified them. The template records them as design invariants. OpenRouter's
[Responses API](https://openrouter.ai/docs/api/api-reference/responses/create-responses)
uses the `/responses` path under this base URL. The exact model ID/revision
and upstream backend routing/fallback policy still require an explicit pin
or a documented limitation.

Use #75's `features.multi_agent=false` and `features.multi_agent_v2=false`
configuration and preserve actual tool-list evidence for initial and resumed
turns. This disables nested native subagents, not the four explicitly
launched SharedNet seats. Keep the integrated-build and capability-evidence
blockers until verified; deciding a setting is not proof of enforcement.

## Research comparison

Use four agents with dynamically negotiated responsibilities, one designated
learning execution seat, and three frozen partners. A seat is not a permanent
planner/coder/tester job. Compare:

| Arm | Learner policy | Partners and inference protocol |
| --- | --- | --- |
| A | Untuned Qwen3.5-9B | Identical frozen partners and common controls |
| B | Selective-SFT checkpoint | Same |
| C | B's checkpoint followed by RL | Same |

Use `cooperative-v1` for every seat in all three arms. Do not mix the legacy
prompt into A and attribute a prompt change to training in B/C. ProgramBench
is the training and primary evaluation benchmark. Frontier Science is
evaluation-only; previously inspected tasks are pilots, not untouched tests.
There is no outcome-only SFT arm, so this study does not isolate the benefit of
selective masking. C also uses additional experience/compute; C-minus-B is
not an equal-training-budget optimizer comparison.

## Integrate capabilities, not PR numbers

| Capability | Current implementation work | Freeze requirement |
| --- | --- | --- |
| Qwen/custom endpoint, isolation and inference controls | [#74](https://github.com/systemind-team/sharednet-client/pull/74) | Pin the integrated source/build; verify the OpenRouter endpoint, network and model controls. |
| No hidden native Codex subagents | [#75](https://github.com/systemind-team/sharednet-client/pull/75), which includes #74's work | Verify the actual tool list on initial and resumed turns; preserve evidence. |
| Cooperative opening instructions and wake reminder | [#78](https://github.com/systemind-team/sharednet-client/pull/78) | Explicitly select `--turn-policy cooperative-v1` and preserve both templates. |
| Alternative initiation/completion policies | [#63](https://github.com/systemind-team/sharednet-client/pull/63) | Required only when selecting those semantics; verify them after integration. |

These are separate PRs, not proof of an integrated or deployed package. This
document can merge independently, but formal collection must wait for the
chosen capabilities to coexist in a tested, clean source revision.

Recommend all seats start for the primary learning comparison. Choose one
termination policy on development tasks, then hold it constant across A/B/C.
All-agent completion requires the corresponding runner implementation;
mentioning consensus in a prompt does not enforce it. Do not automatically
cross the three learning arms with #63's four policy combinations.

The cooperative policy is a behavioral instruction, not a forced scheduler.
Ending a turn hands control to the runner; it is not `DONE`. Currently #78
does not allow this prompt override under existing immutable
`--harness-mode` names. Use explicit ad-hoc board controls, freeze all their
resolved values here, and record `harness.mode` as unselected. Do not invent
a `research/...@1` name or silently change an existing named treatment.

## Required control documents

Keep the manifest and its referenced **nonempty JSON control documents** in
one bundle. Paths are relative to the manifest; SHA-256 covers exact file
bytes. Inline prompt/configuration text, or inventory additional local JSON
documents as extra `artifacts` entries. Binary images, checkpoints and task
snapshots can live in an access-controlled artifact store; record immutable
locators and hashes in the appropriate control document. The checker verifies
local control documents, not remote binaries or provider behavior.

| Artifact key | Required reviewed content |
| --- | --- |
| `runner_build` | Integrated client/runner commit, clean-source evidence, exact package/tarball checksum, Codex version, image digests, worker OS and CPU/memory constraints; capability tests and relevant PR provenance. Do not claim a moving image tag or `latest` is a pin. |
| `models_and_seats` | All four seat IDs, designated learner and three fixed partners; exact OpenRouter model ID/base revisions, tokenizer/tool serialization, backend/serving identity and routing/fallback settings. Match the confirmed OpenRouter base URL. Document unavailable checkpoint pins as a limitation, not an immutable guarantee. |
| `prompts` | Exact opening, wake, task and compaction templates; extra instruction files; rendered per-seat prompt hashes for pilots. Identify Codex's native prompt/tool stack separately: opening-prompt hashes do not cover the whole model input. |
| `tasks_and_splits` | Benchmark revision, task IDs and difficulty source, related-task grouping, train/dev/test assignments before collection, fixture hashes and pilot exclusions. Record Frontier Science's evaluation-only boundary and previously inspected tasks. |
| `launch_and_controls` | Exact executable/argv template and non-secret settings; board topology, shared workspace/separate histories, startup, routing/gates, per-seat concurrency, tool/network permissions, reference-query quota, sampling/reasoning, context/compaction/truncation, per-turn/team budgets and worker limits. Define completion/quiescence/idle rules, verifier timing/feedback, cancellation and artifact capture. Distinguish token thresholds from externally enforced hard caps and record expected overshoot. |
| `evaluation` | Authorized agent-visible checks versus held-out grading, evaluator revisions/hashes, invalid-build/timeout rules, official score versus raw pass fraction and denominator, cost metrics, snapshot-before-hidden-grading rule. No hidden feedback enters actor context. |
| `sft_recipe` | Training-only 9B data provenance; learner-only recorded targets and exact causal local prefixes; evidence-based retention, rejected-token masking, complete tool-call boundaries, deduplication, curriculum, human audit and uncertainty rules. Pin selection code/rubric, optimizer, LoRA settings, seeds, training budget and dev-only checkpoint-selection rule. Do not silently include GPT/27B demonstrations. |
| `rl_recipe` | Initialization from B, learner seat/frozen partners, episode grouping, authorized reward, advantage/objective, zero-variance handling, deterministic tool penalties, KL choice, optimizer/LoRA settings, seeds, collection/update synchronization, budget and dev-only checkpoint selection. Semantic failure labels are diagnostic/SFT metadata unless separately preregistered as rewards. |
| `annotation_and_audit` | Failure rubric/schema, annotator revision/prompt, evidence alignment, uncertainty/disagreement resolution, human sampling plan and reporting. Separate runner failures from policy errors; publication is not proof of observation. |
| `replication_and_exclusions` | Exact repeats, supported seed semantics and provider nondeterminism, randomized task/arm order, infrastructure exclusions/reruns, handling of valid policy failures and zero-return groups. Retain all attempts; never rerun only unfavorable policy outcomes. |
| `pilot_acceptance` | Development run IDs and results proving model/tool population, isolation, initial/resumed prompt delivery, wake routing, observed local message IDs, context handling, token accounting, stop semantics and artifact recovery. Inspect premature yielding, all-blocked teams and message-only loops. Fake-service tests are not live-model evidence. |
| `approval` | Human review of every control document and open decision, using the approval record below. |

Unknowns remain `null`, empty values, or explicit entries in
`unresolved_decisions` until resolved. Such bundles cannot pass. For genuinely
inapplicable settings, use a structured explanation such as
`{"status":"not-applicable","reason":"No provider-side seed is exposed."}`.
Do not use this to disguise an unchosen budget or termination policy.
Keep real credentials, authentication files and private session state out of
the bundle and PR. Record non-secret endpoint/settings only.

## Freeze procedure

1. Copy the template into a separate experiment-artifact directory as
   `protocol.json`. Complete the control documents using development evidence.
   Record exact integrated build identity, not merely the heads of open PRs.
2. Resolve every blocker, fill all artifact paths and exact SHA-256 values,
   and empty `unresolved_decisions`. Audit task separation and equivalent
   inference controls across arms. Choose actual numerical budgets and
   training settings; the report's candidates are not measured optima.
3. Have reviewers approve the artifact inventory. Write `approval.json`
   with `approved: true`, this `protocol_id`, `approved_at`, a nonempty
   `reviewers` array, and `artifact_sha256`: a key-to-hash map of **every
   artifact except approval itself**. Hash that file into the manifest.
4. Set `state` to `frozen` and `frozen_at` to the approval timestamp, in
   canonical UTC form such as `2026-11-11T20:00:00.000Z`. Run:

   ```bash
   node scripts/check-experiment-protocol.mjs /path/to/bundle/protocol.json
   ```

5. Archive the resulting manifest SHA-256 and immutable bundle before formal
   collection. Require a passing check as a manual pre-launch gate. Pin the
   checker/source version too. Never edit a frozen bundle in place: a change
   requires a new protocol ID, renewed approval and a documented impact on
   comparability and collected data.

The checker is read-only. It rejects draft state, missing required evidence,
unresolved values, changed design, invalid paths, symlink escapes, malformed
JSON, checksum mismatches and stale approval inventories. It is an offline
completeness/integrity gate, **not** a full domain schema, an authentication
signature, runtime enforcement, or proof that a reviewer checked the science.
It is not wired into `goal run`; the owner must apply the pre-launch gate.

The checked-in template should fail:

```bash
node scripts/check-experiment-protocol.mjs \
  docs/experiments/sharednet-9b-dynamic.template.json
```

## Per-run binding and observed artifacts

Freeze training recipes and checkpoint-selection rules before training;
trained B/C checkpoint hashes cannot exist yet. Record selected checkpoints,
dataset/selection versions and training-run IDs when they are produced.
Before each collection or evaluation run, save a binding that records the
protocol hash, arm, task/split, repeat, supported seeds, exact learner and
partner checkpoint identities, rendered prompts, resolved launch command and
build/image hashes. Validate equality to common controls, allowing only the
preregistered learner-policy differences. Never tune on final test outcomes.

Attach, rather than overwrite the frozen protocol: `episode.json`,
`room.ndjson`, `checks.ndjson`, `wakes.ndjson`, agent-local traces, routing logs
when emitted, policy logs when available, final workspace snapshot, actual
usage/elapsed time, stop reason, scoring outputs and failure/exclusion status.
Missing required provenance is a logged invalid attempt under the frozen
exclusion rule, not evidence that the planned setting was used.

The runner's existing `episode.json` provenance and opening-prompt hashes are
useful observations, not the complete study protocol. Do not confuse
`scripts/export-manifest.json` (repository packaging allowlist) with this
experimental manifest.
