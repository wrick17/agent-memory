# Agent Memory instructions

Before changing product behavior, interfaces, or decisions, read [the feature manifest](docs/feature-manifest.md). Update affected entries and evidence in the same change.

When user-visible features, setup, or project status change, update [README.md](README.md); keep it short, align its checklist with the feature manifest, and check only completed milestones.

## Temporary build-first policy

Until the owner explicitly asks to "go hard on testing":

- Prioritize a usable BothQ replacement: core memory, authenticated clients, safe migration and recovery. Keep BothQ running and readable; finish remaining features, optimization and polish after the caller transition.
- Keep focused checks for data loss, access control and broken core flows. Batch broader verification around working milestones.
- Reuse passing checks when their inputs are unchanged. Repeat them only for relevant changes, failures or new evidence.
- Reserve independent review for consequential risks. Avoid routine chains of design, component, glue and repeated reviews for every feature.
- Defer exhaustive edge-case coverage and minor improvements. Record known limits briefly; block delivery for concrete safety or core-functionality failures.
- Continue independent work in parallel when another feature has a provider or external blocker.

## Model and writer ownership

Opus does the Opus-owned work until an actual provider usage-limit error stops it; a reset clock or an estimate is not that. Only after such an error may Sol take the full Opus role, including architecture and implementation. Work returns to Opus only after an actual successful reply and a handoff through the parent, with one writer per shared file. Opus executed again after the 09:34:48 limit; the successful 16:55:46 to 17:05:12 UTC run ended a later fallback. Confirmed personal Claude API rate-limit failures at 19:23:13 to 19:23:59 UTC on 2026-10-29 superseded that return. All old Opus runs are terminal, and Sol is the sole shared-root source/canonical writer for this bounded adoption. Shared-root writes require authorization. README and import-verification remain Terra-owned; the parent is the sole BothQ writer. This retains the actual-error-only policy and supersedes the earlier wait-only rule and reset-clock assumptions.
