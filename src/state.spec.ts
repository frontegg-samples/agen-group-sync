import { describe, expect, it } from 'vitest';
import { GuardTrippedError, LockHeldError, Store, type StateIo } from './state.js';

const mem = (initial?: string, over: StateIo = {}) => {
	const files = new Map<string, string>();
	if (initial !== undefined) files.set('/s.json', initial);
	let clock = new Date('2026-09-28T12:00:00.000Z');
	const io: StateIo = {
		exists: (p) => files.has(p),
		read: (p) => files.get(p)!,
		write: (p, d) => void files.set(p, d),
		remove: (p) => void files.delete(p),
		pid: 111,
		now: () => clock,
		...over,
	};
	return { store: new Store('/s.json', io), files, setClock: (d: string) => (clock = new Date(d)) };
};

describe('sticky guard', () => {
	it('passes when nothing has tripped', () => {
		expect(() => mem().store.assertNotTripped()).not.toThrow();
	});

	it('refuses to run after a trip, and says how to clear it', () => {
		const { store } = mem();
		store.trip('blast-radius', 'would remove 40 of 44 memberships');
		try {
			store.assertNotTripped();
			expect.unreachable('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(GuardTrippedError);
			expect((err as Error).message).toMatch(/would remove 40 of 44/);
			expect((err as Error).message).toMatch(/--clear-guard/);
		}
	});

	it('stays tripped across passes — it does not reset itself', () => {
		// A guard that resets on the next pass is not a guard; the condition is usually still true.
		const { store, files } = mem();
		store.trip('blast-radius', 'first');
		const persisted = files.get('/s.json')!;
		expect(new Store('/s.json', { exists: () => true, read: () => persisted }).read().tripped?.message).toBe('first');
	});

	it('keeps the FIRST trip reason, not the latest', () => {
		const { store } = mem();
		store.trip('blast-radius', 'first');
		store.trip('empty-google', 'second');
		expect(store.read().tripped).toMatchObject({ reason: 'blast-radius', message: 'first' });
	});

	it('clears only on explicit request, returning what was cleared', () => {
		const { store } = mem();
		store.trip('no-candidates', 'prefix drift');
		expect(store.clearGuard()).toMatchObject({ reason: 'no-candidates' });
		expect(() => store.assertNotTripped()).not.toThrow();
		expect(store.clearGuard()).toBeUndefined();
	});

	it('preserves a held lock when the guard is cleared', () => {
		const { store } = mem();
		store.acquireLock();
		store.trip('blast-radius', 'x');
		store.clearGuard();
		expect(store.read().lock).toBeDefined();
	});
});

describe('lock', () => {
	it('acquires and releases', () => {
		const { store } = mem();
		store.acquireLock();
		expect(store.read().lock).toMatchObject({ pid: 111 });
		store.releaseLock();
		expect(store.read().lock).toBeUndefined();
	});

	it('refuses a second concurrent pass', () => {
		const { store, files } = mem();
		store.acquireLock();
		const other = new Store('/s.json', {
			exists: (p) => files.has(p),
			read: (p) => files.get(p)!,
			write: (p, d) => void files.set(p, d),
			pid: 222,
			now: () => new Date('2026-09-28T12:00:05.000Z'),
		});
		expect(() => other.acquireLock()).toThrow(LockHeldError);
	});

	it('takes over a lock older than the stale threshold, so a crash cannot block forever', () => {
		const { store, setClock } = mem();
		store.acquireLock();
		setClock('2026-09-28T13:00:00.000Z'); // +60 min, past the 30 min default
		expect(() => store.acquireLock()).not.toThrow();
		expect(store.read().lock).toMatchObject({ pid: 111 });
	});

	it("does NOT let the displaced holder release the new holder's lock", () => {
		const { store, files } = mem();
		store.acquireLock(); // pid 111
		const io = (pid: number, now: string): StateIo => ({
			exists: (p) => files.has(p),
			read: (p) => files.get(p)!,
			write: (p, d) => void files.set(p, d),
			pid,
			now: () => new Date(now),
		});
		new Store('/s.json', io(222, '2026-09-28T13:00:00.000Z')).acquireLock(); // stale takeover
		store.releaseLock(); // original holder tries to release
		expect(store.read().lock).toMatchObject({ pid: 222 });
	});

	it('treats an unparseable acquiredAt as stale rather than blocking forever', () => {
		const { store } = mem(JSON.stringify({ lock: { pid: 9, acquiredAt: 'not-a-date' } }));
		expect(() => store.acquireLock()).not.toThrow();
	});
});

describe('corrupt or absent state', () => {
	it('reads absent state as empty', () => expect(mem().store.read()).toEqual({}));

	it.each([
		['invalid json', '{oops'],
		['a JSON scalar', '42'],
		['null', 'null'],
	])('reads %s as empty rather than crashing the pass', (_label, contents) => {
		expect(mem(contents).store.read()).toEqual({});
	});

	it('writes state as formatted JSON so an operator can read and edit it', () => {
		const { store, files } = mem();
		store.trip('blast-radius', 'x');
		expect(files.get('/s.json')).toMatch(/^\{\n {2}"tripped"/);
	});
});
