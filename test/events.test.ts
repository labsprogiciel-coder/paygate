import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventFeed } from '../src/events.ts';
import { setup, stubFetch, COLLECT } from './helpers/gateway.ts';
import { silence } from './helpers/env.ts';

/** A gateway with one tenant, a few payments, a stored callback of each kind and a dead webhook. */
async function seeded() {
	const quiet = silence();
	const g = await setup({}, { webhookUrl: 'https://shop.test/hook' });
	const net = stubFetch(() => new Response('nope', { status: 500 }));
	try {
		const a = await g.call('POST', '/v1/collections', COLLECT);
		const b = await g.call('POST', '/v1/collections', { ...COLLECT, reference: 'order-0002', phone: '+2250700000002' });
		await g.call('GET', `/v1/collections/${b.body.id}`); // the re-check finds the sandbox's "0002" failed
		const insert = g.sqlite.prepare('INSERT INTO provider_events (provider, path, accepted, body, received_at) VALUES (?, ?, ?, ?, ?)');
		insert.run('pawapay', '/callbacks/pawapay/deposits', 1, '{"ok":true}', Date.now());
		insert.run('pawapay', '/callbacks/pawapay/payouts', 0, '{"bad":true}', Date.now());
		g.sqlite.prepare(`INSERT INTO webhook_deliveries (id, tenant_id, payment_id, type, payload, status, attempts, next_attempt_at, last_error, created_at) VALUES ('evt_dead', 'shop', ?, 'payment.completed', '{}', 'dead', 8, 0, 'HTTP 500', ?)`).run(a.body.id, Date.now());
		return { ...g, paymentId: a.body.id as string };
	} finally { net.restore(); quiet(); }
}

test('the feed merges payment events, callbacks and webhooks, newest first', async () => {
	const g = await seeded();
	const r = await g.admin('GET', '/admin/events');
	assert.equal(r.status, 200);
	const sources = new Set(r.body.data.map((e: any) => e.source));
	assert.deepEqual([...sources].sort(), ['callback', 'payment', 'webhook']);
	const ats = r.body.data.map((e: any) => e.at);
	assert.deepEqual(ats, [...ats].sort((x: number, y: number) => y - x));
	assert.equal(new Set(r.body.data.map((e: any) => e.id)).size, r.body.data.length, 'ids are unique across sources');
	const rejected = r.body.data.find((e: any) => e.source === 'callback' && e.status === 'rejected');
	assert.equal(rejected.problem, true);
	assert.equal(rejected.body, '{"bad":true}');
	assert.equal(r.body.next, null);
});

test('filters: source, needs attention, tenant and payment', async () => {
	const g = await seeded();
	const only = async (qs: string) => (await g.admin('GET', `/admin/events?${qs}`)).body.data as any[];
	assert.ok((await only('source=callback')).every((e) => e.source === 'callback'));
	assert.ok((await only('source=webhook,payment')).every((e) => e.source !== 'callback'));

	const problems = await only('problems=1');
	assert.ok(problems.length >= 3 && problems.every((e) => e.problem));
	assert.ok(problems.some((e) => e.source === 'payment' && e.type === 'failed'));
	assert.ok(problems.some((e) => e.source === 'webhook' && e.status === 'dead'));

	assert.ok((await only('tenant=shop')).every((e) => e.tenant === 'shop'), 'callbacks have no tenant and drop out');
	assert.equal((await only('tenant=nobody')).length, 0);
	const forPayment = await only(`payment=${g.paymentId}`);
	assert.ok(forPayment.length >= 2 && forPayment.every((e) => e.paymentId === g.paymentId));
	assert.equal((await g.admin('GET', '/admin/events?source=bogus')).status, 200, 'an unknown source means all of them');
});

test('paging never skips or repeats an event, even when several share a timestamp', async () => {
	const g = await seeded();
	const t = Date.now() + 1000;
	const insert = g.sqlite.prepare('INSERT INTO provider_events (provider, path, accepted, body, received_at) VALUES (?, ?, 1, ?, ?)');
	for (let i = 0; i < 7; i++) insert.run('pawapay', '/callbacks/pawapay/deposits', `{"i":${i}}`, i < 4 ? t : t - i); // four at the same instant
	const full = (await eventFeed(g.env, { limit: 200 })).data.map((e) => e.id);
	const seen: string[] = [];
	let before: string | null = null;
	for (let i = 0; i < 50; i++) {
		const r = await eventFeed(g.env, { limit: 3, before });
		seen.push(...r.data.map((e) => e.id));
		if (!r.next) break;
		before = r.next;
	}
	assert.deepEqual(seen, full);
});

test('the attention counts match what needs a person', async () => {
	const g = await seeded();
	const r = await g.admin('GET', '/admin/attention');
	assert.deepEqual(r.body, { unknown: 0, deadWebhooks: 1, rejectedCallbacks24h: 1 });
	assert.equal((await g.call('GET', '/admin/attention')).status, 401, 'a tenant key cannot read it');
});
