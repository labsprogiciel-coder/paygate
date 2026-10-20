import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEnv, silence, stubFetch, ALERT_URL } from './helpers/env.ts';
import { DB_LIMIT_BYTES, KEEP_PAYLOAD_DAYS, prune } from '../src/retention.ts';
import { attention, eventFeed } from '../src/events.ts';

const DAY = 86_400_000, NOW = 1_800_000_000_000, OLD = NOW - (KEEP_PAYLOAD_DAYS + 1) * DAY, RECENT = NOW - (KEEP_PAYLOAD_DAYS - 1) * DAY;

function seed(e: ReturnType<typeof createEnv>) {
	e.sqlite.exec(`INSERT INTO tenants (id, name, created_at) VALUES ('shop', 'Shop', 0)`);
	const add = e.sqlite.prepare(`INSERT INTO webhook_deliveries (id, tenant_id, payment_id, type, payload, status, attempts, next_attempt_at, created_at, delivered_at) VALUES (?, 'shop', ?, ?, '{"x":1}', ?, 1, 0, ?, ?)`);
	add.run('evt_old', 'pg1', 'payment.completed', 'delivered', OLD, OLD);
	add.run('evt_recent', 'pg2', 'payment.completed', 'delivered', RECENT, RECENT);
	add.run('evt_dead', 'pg3', 'payment.failed', 'dead', OLD, null);
	add.run('evt_pending', 'pg4', 'payment.completed', 'pending', OLD, null);
	add.run('evt_ping_old', '-', 'ping', 'delivered', OLD, OLD);
	add.run('evt_ping_recent', '-', 'ping', 'delivered', RECENT, RECENT);
}
const rows = (e: ReturnType<typeof createEnv>) => Object.fromEntries((e.sqlite.prepare(`SELECT id, payload, status FROM webhook_deliveries`).all() as { id: string; payload: string; status: string }[]).map((r) => [r.id, r]));

test('old delivered payloads are emptied and old pings deleted; recent, dead and pending deliveries are untouched', async () => {
	const restore = silence();
	try {
		const e = createEnv(); seed(e);
		assert.deepEqual(await prune(e.env, NOW), { cleared: 1, pings: 1 });
		const r = rows(e);
		assert.equal(r.evt_old!.payload, '', 'payload emptied');
		assert.equal(r.evt_old!.status, 'delivered', 'the row and its status stay');
		assert.equal(r.evt_recent!.payload, '{"x":1}');
		assert.equal(r.evt_dead!.payload, '{"x":1}', 'a dead delivery waits for a person');
		assert.equal(r.evt_pending!.payload, '{"x":1}', 'a pending delivery still has to be sent');
		assert.equal(r.evt_ping_old, undefined);
		assert.ok(r.evt_ping_recent);
		assert.deepEqual(await prune(e.env, NOW), { cleared: 0, pings: 0 }, 'a second run has nothing left to do');
		const feed = await eventFeed(e.env, { sources: ['webhook'], limit: 10 });
		assert.equal(feed.data.find((x) => x.id === 'evt_old')!.body, null, 'the feed shows no body rather than an empty one');
	} finally { restore(); }
});

test('it works in batches, and stops after its rounds; the rest is done on the next run', async () => {
	const restore = silence();
	try {
		const e = createEnv(); seed(e);
		const add = e.sqlite.prepare(`INSERT INTO webhook_deliveries (id, tenant_id, payment_id, type, payload, status, attempts, next_attempt_at, created_at, delivered_at) VALUES (?, 'shop', 'pg', 'payment.completed', '{}', 'delivered', 1, 0, ?, ?)`);
		for (let i = 0; i < 9; i++) add.run(`evt_bulk_${i}`, OLD, OLD);
		assert.equal((await prune(e.env, NOW, { batch: 2, rounds: 3 })).cleared, 6);
		assert.equal((await prune(e.env, NOW, { batch: 2, rounds: 10 })).cleared, 4);
		assert.equal((e.sqlite.prepare(`SELECT COUNT(*) AS n FROM webhook_deliveries WHERE status = 'delivered' AND delivered_at < ? AND payload <> '' AND type <> 'ping'`).get(NOW - KEEP_PAYLOAD_DAYS * DAY) as { n: number }).n, 0);
	} finally { restore(); }
});

test('the database size is reported, and over 80% of the limit an alert goes out', async () => {
	const restore = silence();
	const f = stubFetch();
	try {
		const e = createEnv();
		const real = e.env.DB.prepare.bind(e.env.DB);
		let size = 1024 ** 2;
		(e.env.DB as unknown as { prepare: unknown }).prepare = (sql: string) => {
			const st = real(sql);
			if (sql !== 'SELECT 1') return st;
			return { run: async () => ({ success: true, results: [], meta: { changes: 0, size_after: size } }) };
		};
		assert.deepEqual((await attention(e.env)).database, { bytes: 1024 ** 2, limit: DB_LIMIT_BYTES });
		await prune(e.env, NOW);
		assert.equal(f.alerts().length, 0);
		size = Math.ceil(DB_LIMIT_BYTES * 0.85);
		await prune(e.env, NOW, { checkSize: false });
		assert.equal(f.alerts().length, 0, 'the hourly runs do not alert; only the 03:05 one checks the size');
		await prune(e.env, NOW);
		assert.equal(f.alerts().length, 1);
		assert.match(f.alerts()[0]!.title, /80%/);
		assert.ok(f.calls.every((c) => c.url.startsWith(ALERT_URL)));
	} finally { f.restore(); restore(); }
});

test('without a size from D1 (local, tests) the size is null and nothing alerts', async () => {
	const e = createEnv();
	assert.equal((await attention(e.env)).database.bytes, null);
});
