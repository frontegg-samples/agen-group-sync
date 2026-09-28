/**
 * Local run state: the sticky guard and the single-pass lock.
 *
 * Sticky guard (docs/OPERATIONS.md §5.4). "Once a guard trips, stay tripped until a human clears it." A
 * guard that resets itself on the next pass is not a guard — the condition that tripped it is
 * usually still true, and silently resuming is how a mass revocation lands on the second attempt.
 *
 * Lock (§5.6). Schedules are at-least-once and most runtimes retry on their own, so a slow pass can
 * overlap itself and two passes race on the same writes.
 *
 * LIMITATION, stated plainly because it changes how you deploy this: the lock is a file on local
 * disk. It serialises passes on ONE host. It does NOT serialise across hosts, containers without a
 * shared volume, or concurrent Lambda invocations. If you run this anywhere that can execute two
 * copies at once, you need a shared lock with a fencing token instead — see docs/OPERATIONS.md §7.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface TrippedGuard {
	reason: string;
	message: string;
	trippedAt: string;
}

export interface SyncState {
	tripped?: TrippedGuard;
	lock?: { pid: number; acquiredAt: string };
}

export interface StateIo {
	exists?: (path: string) => boolean;
	read?: (path: string) => string;
	write?: (path: string, data: string) => void;
	remove?: (path: string) => void;
	pid?: number;
	now?: () => Date;
	/** A lock older than this is treated as abandoned — a crashed pass must not block forever. */
	staleLockMs?: number;
}

export class GuardTrippedError extends Error {
	constructor(public readonly guard: TrippedGuard) {
		super(
			`Refusing to run: a safety guard tripped at ${guard.trippedAt} (${guard.reason}) and has not been cleared.\n` +
				`  ${guard.message}\n` +
				`Review the plan, then clear it with --clear-guard once you are satisfied.`,
		);
		this.name = 'GuardTrippedError';
	}
}

export class LockHeldError extends Error {
	constructor(pid: number, acquiredAt: string) {
		super(
			`Another pass is running (pid ${pid}, since ${acquiredAt}). Skipping this pass, and emitting no success signal.`,
		);
		this.name = 'LockHeldError';
	}
}

export class Store {
	private readonly io: Required<StateIo>;

	constructor(
		private readonly path: string,
		io: StateIo = {},
	) {
		this.io = {
			exists: io.exists ?? existsSync,
			read: io.read ?? ((p) => readFileSync(p, 'utf8')),
			write:
				io.write ??
				((p, data) => {
					mkdirSync(dirname(p), { recursive: true });
					writeFileSync(p, data, 'utf8');
				}),
			remove: io.remove ?? unlinkSync,
			pid: io.pid ?? process.pid,
			now: io.now ?? (() => new Date()),
			staleLockMs: io.staleLockMs ?? 30 * 60_000,
		};
	}

	read(): SyncState {
		if (!this.io.exists(this.path)) return {};
		try {
			const parsed = JSON.parse(this.io.read(this.path)) as SyncState;
			return parsed && typeof parsed === 'object' ? parsed : {};
		} catch {
			// Unreadable state is treated as no state for the LOCK, but a corrupt file must never
			// silently clear a tripped guard, so callers see {} and the guard re-trips on the next plan.
			return {};
		}
	}

	private save(state: SyncState): void {
		this.io.write(this.path, `${JSON.stringify(state, null, 2)}\n`);
	}

	assertNotTripped(): void {
		const { tripped } = this.read();
		if (tripped) throw new GuardTrippedError(tripped);
	}

	trip(reason: string, message: string): void {
		const state = this.read();
		// Never overwrite an earlier trip: the first one is the one a human needs to read.
		if (state.tripped) return;
		state.tripped = { reason, message, trippedAt: this.io.now().toISOString() };
		this.save(state);
	}

	clearGuard(): TrippedGuard | undefined {
		const state = this.read();
		const previous = state.tripped;
		delete state.tripped;
		this.save(state);
		return previous;
	}

	acquireLock(): void {
		const state = this.read();
		const held = state.lock;
		if (held) {
			const ageMs = this.io.now().getTime() - Date.parse(held.acquiredAt);
			if (Number.isFinite(ageMs) && ageMs < this.io.staleLockMs) {
				throw new LockHeldError(held.pid, held.acquiredAt);
			}
		}
		state.lock = { pid: this.io.pid, acquiredAt: this.io.now().toISOString() };
		this.save(state);
	}

	releaseLock(): void {
		const state = this.read();
		// Only the holder releases. A stale-lock takeover means the original holder must not be able
		// to release the lock the new pass is now relying on.
		if (state.lock?.pid !== this.io.pid) return;
		delete state.lock;
		this.save(state);
	}
}
