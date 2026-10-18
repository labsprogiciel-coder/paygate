import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup, COLLECT } from './helpers/gateway.ts';
import { silence } from './helpers/env.ts';

/** Seven payments; four of them created in the same millisecond, the case a timestamp-only cursor gets wrong. */
async function seeded() {
	const quiet = silence();
	try {
		const g = await setup();
		for (let i = 1; i <= 7; i++) await g.call('POST', '/v1/collections', { ...COLLECT, reference: `order-${i}`, phone: `+22507000000${i < 2 ? 1 : 3}` });
		const t = Date.now() + 1000;
		g.sqlite.prepare(`UPDATE payments SET created_at = ? WHERE reference IN ('order-2', 'order-3', 'order-4', 'order-5')`).run(t);
		return g;
	} finally { quiet(); }
}

test('the operator payment list pages newest first, never skipping or repeating a row, with a total', async () => {
	const g = await seeded();
	const all = (await g.admin('GET', '/admin/payments?limit=100')).body;
	assert.equal(all.total, 7);
	assert.equal(all.data.length, 7);
	assert.equal(all.next, null);

	const seen: string[] = [];
	let before: string | null = null;
	for (let i = 0; i < 10; i++) {
		const r: any = (await g.admin('GET', `/admin/payments?limit=3${before ? `&before=${encodeURIComponent(before)}` : ''}`)).body;
		assert.equal(r.total, 7, 'the total is for the whole filter, not the page');
		assert.ok(r.data.length <= 3);
		seen.push(...r.data.map((p: any) => p.id));
		if (!r.next) break;
		before = r.next;
	}
	assert.deepEqual(seen, all.data.map((p: any) => p.id));
});

test('filters apply to the page and the total; a malformed cursor starts from the top', async () => {
	const g = await seeded();
	const r = (await g.admin('GET', '/admin/payments?tenant=nobody')).body;
	assert.deepEqual([r.data.length, r.total, r.next], [0, 0, null]);
	const first = (await g.admin('GET', '/admin/payments?limit=2')).body;
	const junk = (await g.admin('GET', `/admin/payments?limit=2&before=${encodeURIComponent("1' OR 1=1 --")}`)).body;
	assert.deepEqual(junk.data.map((p: any) => p.id), first.data.map((p: any) => p.id));
	assert.equal((await g.admin('GET', '/admin/payments?limit=-5')).body.data.length, 1, 'the limit is clamped to 1..100');
	assert.equal((await g.admin('GET', '/admin/payments?limit=0')).body.data.length, 7, 'no limit means the default page (50)');
});

test('the payments page headline: last-24 h completed and success rate, open work of any age, for the same tenant and direction', async () => {
	const g = await seeded();
	const day = 86_400_000, now = Date.now();
	const set = (ref: string, status: string, at = now) => g.sqlite.prepare('UPDATE payments SET status = ?, created_at = ? WHERE reference = ?').run(status, at, ref);
	set('order-1', 'completed'); set('order-2', 'completed'); set('order-3', 'failed'); set('order-4', 'expired');
	set('order-5', 'completed', now - 2 * day); // too old to count as settled today
	set('order-6', 'processing', now - 3 * day); // still open: counts whatever its age
	set('order-7', 'unknown');
	const amount = (ref: string) => (g.sqlite.prepare('SELECT amount FROM payments WHERE reference = ?').get(ref) as { amount: number }).amount;
	const k = (await g.admin('GET', '/admin/payments/stats')).body;
	assert.deepEqual(k.completed, { n: 2, amount: amount('order-1') + amount('order-2') });
	assert.equal(k.settled, 4);
	assert.equal(k.successRate, 50);
	assert.deepEqual(k.processing, { n: 1, amount: amount('order-6') });
	assert.deepEqual(k.unknown, { n: 1, amount: amount('order-7') });
	const none = (await g.admin('GET', '/admin/payments/stats?tenant=nobody')).body;
	assert.deepEqual([none.completed.n, none.successRate, none.processing.n, none.unknown.n], [0, null, 0, 0]);
	assert.equal((await g.admin('GET', '/admin/payments/stats?kind=disbursement')).body.completed.n, 0, 'the seeded payments are all collections');
	assert.equal((await g.call('GET', '/admin/payments/stats')).status, 401, 'a tenant key cannot read it');
});
