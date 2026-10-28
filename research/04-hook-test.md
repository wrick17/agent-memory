# Session-end hook test under T3 Code

Source: Sol (gpt-6.1-sol, high) docs research plus empirical test, 2026-10-28. Claude Code 2.1.312, Codex 0.165.0, T3 commit 48a2923. All temporary hook files, scratch dirs and logs were removed; user config files verified against original SHA256 hashes.

## Verdict

Use turn completion (`Stop`) for capture, debounced and deduplicated. Claude `SessionEnd` fires under T3 only at SDK teardown (thread archive or session cleanup), not when a turn goes idle. Codex hooks run under T3 (trusted plugin hooks fired), but custom end hooks were not exposed in the test, so T3 Codex end-hook behavior is unverified.

## Events

Both providers send JSON with `hook_event_name`, `session_id`, `cwd`, `transcript_path` (Codex may send null).

| Event | Claude Code | Codex | Extra payload |
|---|---|---|---|
| `Stop` | Normal response finishes | Normal turn finishes | `stop_hook_active`, `last_assistant_message`; Codex adds `turn_id` |
| `SessionEnd` | Exit, clear, switch, logout | Normal shutdown, archive/delete of open conversation, or 30 min idle without clients | `reason` (Codex uses `other`) |
| `SubagentStop` | Native subagent finishes | Native subagent finishes | Agent identity, `agent_transcript_path` |
| `PreCompact` / `PostCompact` | Before / after compaction | Same | `trigger`; Claude adds `custom_instructions` / `compact_summary` |
| Other | `StopFailure`, `TeammateIdle` | `Interrupt` | Error details, teammate identity, interrupted `turn_id` |

Docs: https://code.claude.com/docs/en/hooks and https://learn.chatgpt.com/docs/hooks

## T3 source facts

- Agent SDK default (omitted `settingSources`) loads user, project and local settings including hooks: https://code.claude.com/docs/en/agent-sdk/claude-code-features
- T3 omits `settingSources`: https://github.com/pingdotgg/t3code/blob/48a292364ab37574c67fb377b5227e5d281d9203/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L1512-L1575
- T3 keeps the streaming query open and closes it at session cleanup: same file, lines 10519-10563.
- Codex thread config keeps ordinary config loading: https://github.com/pingdotgg/t3code/blob/48a292364ab37574c67fb377b5227e5d281d9203/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L1321-L1354
- T3 unload uses `thread/unsubscribe` (lines 6995-7003), which per https://learn.chatgpt.com/docs/hooks#sessionend does not immediately trigger `SessionEnd`.

## Empirical results (UTC, 2026-10-28)

| Path | Event | Fired | Timing |
|---|---|---|---|
| Claude `-p` | Stop | Yes | 11:27:49.055 |
| Claude `-p` | SessionEnd | Yes | 11:27:50.218, reason other |
| Claude persistent stream | Stop | Yes | 11:30:31.070, process stayed open |
| Claude persistent stream | SessionEnd | Yes | only after EOF, 11:30:33.251 |
| T3 Claude | Stop | Yes | 11:27:52.311 |
| T3 Claude | SessionEnd | Yes | only after archive closed the SDK process, 11:32:05.544 |
| Codex exec | Stop | Yes | 11:27:50.915, with turn_id |
| Codex exec | SessionEnd | Yes | 11:27:51.619 |
| T3 Codex | Stop, SessionEnd | No records | custom hooks not exposed by `hooks/list` (trust); trusted plugin hooks did run |

## Recommended trigger

- Portable: `Stop` enqueues capture quickly (debounced until idle, deduplicated by session id plus transcript position); `SessionEnd` and a `SessionStart` sweep of the previous session's transcript act as recovery triggers.
- Under T3 specifically, run completion (Claude SDK result, Codex `turn/completed`) is the durable signal, but that is T3-internal.
- MCP disconnect alone is not evidence of completion.
- Codex custom hooks need hook trust before they run under T3; verify in phase 2.
