# Agent Memory instructions

Before changing product behavior, interfaces, or decisions, read [the feature manifest](docs/feature-manifest.md). Update affected entries and evidence in the same change.

When user-visible features, setup, or project status change, update [README.md](README.md); keep it short, align its checklist with the feature manifest, and check only completed milestones.

## Completion-first policy

Finish the agreed features and usable end-to-end flows before edge-case handling, extra hardening, optimization or polish. Defer that follow-up work until the owner asks for it or says "go hard on testing".

- Prioritize a usable BothQ replacement: core memory, authenticated clients, safe migration and recovery. Keep BothQ running and readable.
- Complete and integrate the remaining implementation before the test phase and packaging/release checks. During implementation, use only the global build-and-load checks. Write and run tests, and review consequential changes, in one combined phase afterwards. Batch status documentation with the completed implementation.
- Reuse passing checks when their inputs are unchanged. Repeat them only for relevant changes, failures or new evidence.
- Reserve independent review for consequential risks. Avoid routine chains of design, component, glue and repeated reviews for every feature.
- Use the feature manifest's completion criteria without adding speculative acceptance gates. Record non-blocking limits briefly and continue. Concrete data loss, security or access-control failures and broken core flows still block delivery.
- Continue independent work in parallel when another feature has a provider or external blocker.
- Before finishing, commit and push all verified task-owned changes. Verify the remote commit and that no task-owned changes remain uncommitted. Preserve unrelated private files.

## Model and writer ownership

The owner's temporary Opus-for-Sol window on 2026-11-01 has elapsed. New work follows the normal roles: Opus implements and designs, Sol researches, reviews and handles controlled root integration, and Terra verifies and delivers. An already assigned bounded Opus review may finish its current frozen input. Keep one writer per shared file; the parent remains the sole journal writer.

Opus does the Opus-owned work until an actual provider usage-limit error stops it; a reset clock or an estimate is not that. Only after such an error may Sol take the full Opus role, including architecture and implementation. Work returns to Opus only after an actual successful reply and a handoff through the parent, with one writer per shared file. Opus executed again after the 09:34:48 limit; the successful 16:55:46 to 17:05:12 UTC run ended a later fallback. Confirmed personal Claude API rate-limit failures at 19:23:13 to 19:23:59 UTC on 2026-10-29 superseded that return. All old Opus runs are terminal, and Sol is the sole shared-root source/canonical writer for this bounded adoption. Shared-root writes require authorization. README and import-verification remain Terra-owned; the parent is the sole Agent Memory journal writer. Ordinary work memory uses `agent_memory`; BothQ is a read-only legacy archive with no automatic bridge or write fallback. This retains the actual-error-only policy and supersedes the earlier wait-only rule and reset-clock assumptions.
