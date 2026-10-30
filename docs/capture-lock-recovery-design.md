# Capture lock recovery

**Implemented and closed 2026-10-29** by an independent review of the source, with local tests only ([phase 2 status](phase-2-implementation.md)). The capture client stays uninstalled. The implementation leaves out `sweep()`: a worker killed before its rename leaves a small empty private directory, marked as a shortcut in the code. The design below is otherwise as built. Opus (`claude-opus-5-5`), author of the capture client, wrote it while the import fixes are under review. It fixes the open finding L4 ([local closure review](review-sol-phase2a-local-fixes-2026-10-29.md#remaining-finding); [phase 2 status](phase-2-implementation.md)). The capture client stays uninstalled until this lands.

## The defect

`takeLock` in `local/agent-memory.mjs` (lines 82-97) creates `run.lock` by hard link. To remove a dead owner's lock, a worker first creates an exclusive marker, `run.lock.reclaimed-<hash of the lock>`, then deletes the lock. The marker is never removed. A reclaimer killed between the two steps leaves the dead lock and its marker behind for good:
- every later worker fails to create the marker, and returns `false`;
- `run()` returns `locked`;
- capture stops on that machine until someone repairs it by hand.

Each marker is itself a claim with no recovery, so adding a claim on the claim would only move the problem.

## The proposed lock

The lock becomes a directory, `run.lock.d`, holding at most one entry named `owner.<pid>.<nonce>`. The nonce is 8 random bytes.

```js
const lockDir = () => path.join(home(), "run.lock.d");
const live = (entry) => { const pid = Number(/^owner\.(\d+)\./.exec(entry)?.[1]); return pid > 0 && alive(pid); };
// Before this version first makes run.lock.d, a worker of the previous version may still hold run.lock.
const legacyLive = () => { if (fs.existsSync(lockDir())) return false; const pid = readJson(lockFile(), null)?.pid; return Number.isInteger(pid) && pid > 0 && alive(pid); };
let ownLock = null;
function lockHeld() {
	try { if (fs.readdirSync(lockDir()).some(live)) return true; } catch { /* no lock yet */ }
	return legacyLive();
}
/**
 * One owner: the lock is a directory with exactly one entry, owner.<pid>.<nonce>. A private directory holding that entry is
 * renamed onto run.lock.d, which succeeds only while run.lock.d is absent or empty. A dead owner's entry is removed by its
 * unique name, so a reclaimer can only ever remove that dead entry, never a later owner's.
 */
export function takeLock() {
	fs.mkdirSync(home(), { recursive: true, mode: 0o700 });
	if (legacyLive()) return false;
	const name = `owner.${process.pid}.${randomBytes(8).toString("hex")}`;
	for (let i = 0; i < 3; i++) {
		const tmp = `${lockDir()}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
		fs.mkdirSync(tmp, { mode: 0o700 });
		fs.writeFileSync(path.join(tmp, name), "", { flag: "wx", mode: 0o600 });
		try { fs.renameSync(tmp, lockDir()); ownLock = name; sweep(); return true; } catch (e) {
			fs.rmSync(tmp, { recursive: true, force: true });
			if (e.code !== "ENOTEMPTY" && e.code !== "EEXIST") throw e;
		}
		let entries;
		try { entries = fs.readdirSync(lockDir()); } catch { continue; } // released meanwhile
		if (entries.some(live)) return false;
		for (const e of entries) fs.rmSync(path.join(lockDir(), e), { force: true });
	}
	return false;
}
// A killed acquirer leaves its private directory; only its dead creator could ever rename it, so the owner removes it.
function sweep() {
	for (const f of fs.readdirSync(home())) {
		const pid = Number(/^run\.lock\.d\.(\d+)\.[0-9a-f]+\.tmp$/.exec(f)?.[1]);
		if (pid > 0 && !alive(pid)) fs.rmSync(path.join(home(), f), { recursive: true, force: true });
	}
}
export const dropLock = () => {
	if (ownLock) fs.rmSync(path.join(lockDir(), ownLock), { force: true });
	ownLock = null;
};
```

This replaces lines 69-102. `lockFile` stays, renamed in use to the legacy `run.lock`, and the hard-link and marker code goes. Callers are unchanged: `hook` still calls `lockHeld()`, and `run` still loops on `takeLock()` and `dropLock()`.

**Why one owner, with no ABA.**
- `rename` of a directory onto `run.lock.d` succeeds only when `run.lock.d` is absent or empty, and it installs exactly one entry. Nothing else ever adds an entry. So the directory holds at most one entry, and at most one owner.
- An entry leaves only when its owner unlinks it in `dropLock`, or a reclaimer unlinks it after seeing its process dead.
- Each entry name is unique: pid plus a 64-bit nonce, never reused. A reclaimer that read a dead entry earlier and acts later can only unlink that same name. If a new owner holds the lock meanwhile, the unlink finds nothing (`force`), and the reclaimer's rename then fails on the new owner's non-empty directory.
- No step removes or replaces anything by path that could belong to a live owner.

Cross-machine homes and reused PIDs are as before: see the limits below.

## Every crash point

| SIGKILL during | Left behind | Next worker |
|---|---|---|
| Acquire, before the rename | A private `.tmp` directory; the lock unchanged | Unaffected; the next owner sweeps the directory once its pid is dead |
| Holding the lock | `run.lock.d` with a dead entry | Unlinks the entry and takes the lock |
| Reclaim, before the unlink | The dead entry | Same |
| Reclaim, after the unlink, before the rename | An empty `run.lock.d` | Its rename replaces the empty directory |
| Release, before the unlink | The dead entry | Same as holding |
| Release, after the unlink | An empty `run.lock.d`, a free lock | Takes it |

A stopped or slow live owner keeps the lock: its pid is alive. Two reclaimers of one dead entry both unlink it; one rename wins and the other sees a live owner and returns `false`.

## Unchanged

- Queue, `claimed/` rename claims, debounce, pending text, acknowledgement state and immutable parts. The new owner still returns every `claimed/` trigger to the queue first.
- The hook writes a trigger and spawns a run with no network I/O. It reads one directory instead of one file.
- Node's standard library only: no dependency, no global setup, no new option or file outside `~/.agent-memory`.
- The three-attempt bound. A worker that gives up leaves its trigger queued, and the next hook starts a run.

**Upgrading.** Until the new version first creates `run.lock.d`, a live `run.lock` from the old version blocks it (`legacyLive`). After that, `run.lock` and old markers are ignored and left in place. A home stuck in the L4 state (a dead `run.lock` plus its marker) recovers on the first new run.

## Changes when released

| File | Change |
|---|---|
| `local/agent-memory.mjs` | The lock code above; about 25 lines replace 30 |
| `local/agent-memory.test.mjs` | Line 341 checks that `run.lock.d` has no entry after a run; the L4 test becomes the cases below |
| `docs/phase-2-implementation.md` (lines 19, 49, 61), `docs/architecture.md` (the capture lock sentence), `docs/feature-manifest.md` (AM-09), `README.md` if its checklist names L4 | Record the closure with evidence |

## Proposed regressions

Each case uses the test file's existing pattern: a child process that pauses at a chosen `fs` call, then SIGKILL. Each also queues one trigger with pending text, then checks that `run()` returns `ran` and consumes the trigger, and that the acknowledgement reaches the transcript size. The current-lock outcomes come from running the same cases against the current module.

| Case | Current lock | Proposed |
|---|---|---|
| Reclaimer killed after claiming the dead lock (the review's `L4-reclaimer-crash`) | **Red**: three `takeLock()` calls return `false`; `run()` returns `locked` | Green |
| A home left in that state by the current version | **Red**: `locked` | Green on first run |
| Acquirer killed before its rename; owner killed holding; reclaimer killed after unlinking, before renaming | Green where the phase exists | Green |
| Two reclaimers of one dead entry; the second resumes after the first owns | Green (the current L4 test) | Green: one `won`, one `lost`; the first owner's entry stays |
| Stopped live owner: `takeLock()` and the hook's `lockHeld()` | Green | Green: `false`, and the hook spawns nothing; after SIGKILL the next run takes over |
| A live `run.lock` from the old version | n/a | Green: `false` until it exits |

The randomized stress below stays a private probe: it needs eight seconds and random timing.

## Evidence (private probes, no product code)

All under `/tmp/am-l4-design-3uiSra/`, mode 0700:
- **`fsprobe.mjs`, this Mac (APFS):**
  - a directory rename onto an absent or empty directory succeeds; onto a non-empty one it fails with `ENOTEMPTY`, and onto a file with `ENOTDIR`;
  - unlinking a missing entry gives `ENOENT`.

  POSIX allows `ENOTEMPTY` or `EEXIST` for a non-empty target, so both are accepted.
- **`model.mjs`:** every interleaving of two to four workers, each of which may be SIGKILLed before any step, from an absent, dead or empty lock.
  - Current lock: safe but not live. A reclaimer dead after its marker blocks every successor, in 584, 27,558 and 1,677,816 states for 2, 3 and 4 workers.
  - Proposed lock: safe and live, in 623, 26,001 and 1,364,923 states.
  - A mutant that removes the lock by path instead of by entry name is caught as unsafe.
- **`proc-probe.mjs` with the prototype `lock-proposed.mjs`, real processes:**
  - The current module (imported read-only) stays blocked after the reclaimer-crash case: `[false, false, false]`, one marker left.
  - The prototype recovers at every crash point above, gives `won` and `lost` to the two reclaimers, and keeps the stopped owner's lock until it is killed.
  - Six looping workers under 128 random SIGKILLs over 8 s made 1,371 acquisitions with 0 overlaps and 0 leftover `.tmp` directories, and a final successor won.

  Results are in `proc-results.json`.
- **The exact code block above:** extracted into `lock-from-doc.mjs`, it passes the same process probe (123 kills, 700 acquisitions, 0 overlaps, 0 leftovers). `upgrade-probe.mjs` covers the upgrade cases:
  - a home stuck in the L4 state is taken on the first try;
  - a live old-version `run.lock` gives `held: true, won: false`, then `won: true` once that worker exits;
  - after `run.lock.d` exists, a live legacy lock is ignored, as designed.

## Known limits

- **A reused pid** that is alive keeps a dead owner's entry until that process exits. This is unchanged from the current lock.
- **Networked or shared homes** are not supported, as before: liveness is a local pid check.
- **A foreign file at `run.lock.d`** makes `takeLock` throw `ENOTDIR`. Capture then stops until someone removes it. Nothing in the client creates one.
- **Old files stay:** the old `run.lock` and its markers are left in place, a few bytes each.
- **Linux not checked:** the rename semantics were checked on APFS only. Linux behavior follows POSIX, but it is unverified here, and the hosted headless box is the first Linux use.
