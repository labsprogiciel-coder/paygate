import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COLLECT, setup } from './helpers/gateway.ts';

/** A Workers Rate Limiting binding: `limit` calls per key, then refused. */
const limiter = (limit: number) => {
	const seen = new Map<string, number>();
	return { seen, limit: async ({ key }: { key: string }) => { const n = (seen.get(key) ?? 0) + 1; seen.set(key, n); return { success: n <= limit }; } };
};

test('a tenant over its write budget gets 429 rate_limited with Retry-After; nothing is created', async () => {
	const g = await setup({ WRITE_LIMIT: limiter(2), READ_LIMIT: limiter(100) });
	assert.equal((await g.call('POST', '/v1/collections', { ...COLLECT, reference: 'rl-1' })).status, 201);
	assert.equal((await g.call('POST', '/v1/collections', { ...COLLECT, reference: 'rl-2' })).status, 201);
	const over = await g.call('POST', '/v1/collections', { ...COLLECT, reference: 'rl-3' });
	assert.equal(over.status, 429);
	assert.equal(over.body.error.code, 'rate_limited');
	assert.equal(over.body.error.retryAfter, 60);
	assert.equal(over.headers.get('retry-after'), '60');
	assert.equal((g.sqlite.prepare(`SELECT COUNT(*) AS n FROM payments WHERE reference = 'rl-3'`).get() as { n: number }).n, 0);
	assert.equal((await g.call('POST', '/v1/disbursements', { ...COLLECT, reference: 'rl-4' })).status, 429, 'payouts share the write budget');
});

test('reads have their own budget, and one tenant cannot use up another one\'s', async () => {
	const g = await setup({ WRITE_LIMIT: limiter(1), READ_LIMIT: limiter(2) });
	const other = await g.addTenant('other');
	assert.equal((await g.call('POST', '/v1/collections', COLLECT)).status, 201);
	assert.equal((await g.call('POST', '/v1/collections', { ...COLLECT, reference: 'again' })).status, 429);
	assert.equal((await g.call('GET', '/v1/me')).status, 200, 'out of writes, reads still work');
	assert.equal((await g.call('GET', '/v1/me')).status, 200);
	assert.equal((await g.call('GET', '/v1/me')).status, 429);
	assert.equal((await other('POST', '/v1/collections', COLLECT)).status, 201, 'the other tenant is untouched');
	assert.equal((await other('GET', '/v1/me')).status, 200);
});

test('without a limiter, or when it fails, requests go through: a limiter outage never stops payments', async () => {
	const none = await setup();
	for (let i = 0; i < 5; i++) assert.equal((await none.call('POST', '/v1/collections', { ...COLLECT, reference: `free-${i}` })).status, 201);
	const broken = { limit: async () => { throw new Error('limiter down'); } };
	const g = await setup({ WRITE_LIMIT: broken, READ_LIMIT: broken });
	const quiet = console.error; console.error = () => {};
	try {
		assert.equal((await g.call('POST', '/v1/collections', COLLECT)).status, 201);
		assert.equal((await g.call('GET', '/v1/me')).status, 200);
	} finally { console.error = quiet; }
});

test('operator and provider routes are not tenant-limited', async () => {
	const g = await setup({ WRITE_LIMIT: limiter(0), READ_LIMIT: limiter(0) });
	assert.equal((await g.admin('GET', '/admin/tenants')).status, 200);
	assert.equal((await g.call('GET', '/v1/me')).status, 429);
});
