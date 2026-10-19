import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backfillLedger, booksFrom, booksReport, checkBooks, journalBalances, plan, postPending, resetFormanceToken, syncLedger, type PostingKind } from '../src/ledger.ts';
import type { Providers } from '../src/providers/types.ts';
import { COLLECT, PAYOUT, setup } from './helpers/gateway.ts';
import { silence, stubFetch, type Call } from './helpers/env.ts';

const row = (over: Record<string, unknown> = {}) => ({ id: 'pg000000000000000001', tenant_id: 'claude-test', kind: 'disbursement', status: 'processing', attempts: 1, amount: 1000, currency: 'XOF', rail: 'mobile_money', country: 'CIV', ...over }) as any;
const kinds = (r: any, have: PostingKind[] = []) => plan(r, new Set(have), 0).map((p) => `${p.kind} ${p.source} -> ${p.destination}`);

test('the planner: one posting per step of a payment, whatever has already been booked', () => {
	const avail = 'tenants:claude_test:CIV:available', held = 'tenants:claude_test:CIV:held';
	assert.deepEqual(kinds(row({ kind: 'collection', status: 'completed' })), [`in world -> ${avail}`]);
	assert.deepEqual(kinds(row({ kind: 'collection', status: 'completed' }), ['in']), [], 'booked once');
	assert.deepEqual(kinds(row({ kind: 'collection', status: 'failed' })), []);
	assert.deepEqual(kinds(row({ attempts: 0 })), [], 'a payout not sent yet holds nothing');
	assert.deepEqual(kinds(row()), [`hold ${avail} -> ${held}`]);
	assert.deepEqual(kinds(row({ status: 'unknown' })), [`hold ${avail} -> ${held}`], 'an unknown outcome stays held');
	assert.deepEqual(kinds(row({ status: 'completed' }), ['hold']), [`out ${held} -> world`]);
	assert.deepEqual(kinds(row({ status: 'completed' })), [`out ${avail} -> world`], 'completed at once: paid from available');
	assert.deepEqual(kinds(row({ status: 'failed' }), ['hold']), [`release ${held} -> ${avail}`]);
	assert.deepEqual(kinds(row({ status: 'failed' })), [], 'refused before it was sent: nothing to release');
	assert.deepEqual(kinds(row({ status: 'completed' }), ['hold', 'release']), [`out ${avail} -> world`], 'a late completion after a release pays from available');
	assert.deepEqual(kinds(row({ status: 'completed' }), ['hold', 'out']), []);
	assert.deepEqual(plan(row({ kind: 'collection', status: 'completed', rail: 'pispi_qr', country: null }), new Set(), 0)[0]!.destination, 'tenants:claude_test:PISPI:available', 'PI-SPI money is its own pool');
});

test('live payments book themselves: collections credit the tenant, payouts hold then pay out or release', async () => {
	const quiet = silence();
	try {
		const g = await setup();
		const c = await g.call('POST', '/v1/collections', COLLECT);
		await g.call('GET', `/v1/collections/${c.body.id}`); // the sandbox completes it on the first check
		await g.call('POST', '/v1/disbursements', { ...PAYOUT, amount: 2000 }); // completes at once
		const pending = await g.call('POST', '/v1/disbursements', { ...PAYOUT, reference: 'payout-held', amount: 700, phone: '+2250700009999' }); // stays processing
		const unknown = await g.call('POST', '/v1/disbursements', { ...PAYOUT, reference: 'payout-unknown', amount: 300, phone: '+2250700005555' }); // network error
		const ledger = () => g.sqlite.prepare('SELECT reference, kind, source, destination, amount FROM ledger_postings ORDER BY created_at, reference').all() as any[];
		assert.deepEqual(ledger().map((x) => x.kind).sort(), ['hold', 'hold', 'in', 'out']);
		let [b] = await journalBalances(g.env);
		assert.deepEqual(b, { pool: 'CIV', tenants: [{ tenant: 'shop', available: COLLECT.amount - 2000 - 700 - 300, held: 1000 }], unallocated: 0, total: COLLECT.amount - 2000 });

		await g.admin('POST', `/admin/payments/${pending.body.id}/resolve`, { outcome: 'failed', note: 'checked: not sent' });
		await g.admin('POST', `/admin/payments/${unknown.body.id}/resolve`, { outcome: 'completed', note: 'seen in the dashboard' });
		[b] = await journalBalances(g.env);
		assert.deepEqual(b!.tenants[0], { tenant: 'shop', available: COLLECT.amount - 2000 - 300, held: 0 });
		assert.equal(ledger().length, 6, 'one more release, one more payout');

		// the books are history-proof: wiped and rebuilt from the payments, they come out the same, and a second run adds nothing
		g.sqlite.prepare('DELETE FROM ledger_postings').run();
		const re = await backfillLedger(g.env);
		assert.equal(re.payments, 4);
		const [again] = await journalBalances(g.env);
		assert.deepEqual(again!.tenants[0], { tenant: 'shop', available: COLLECT.amount - 2000 - 300, held: 0 });
		assert.equal((await backfillLedger(g.env)).added, 0);
	} finally { quiet(); }
});

/** A Formance stack: tokens, transactions (refusing a reference it has), accounts, a ledger that may not exist yet. */
function formance(state: { exists?: boolean; down?: boolean; accounts?: { address: string; volumes: Record<string, { input: number; output: number }> }[][] } = {}) {
	const txs: any[] = [], calls: Call[] = [];
	let exists = state.exists ?? true;
	const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
	const handler = (c: Call) => {
		const u = new URL(c.url);
		if (u.host !== 'formance.test') return undefined;
		calls.push(c);
		if (u.pathname === '/api/auth/oauth/token') return json({ access_token: 'tok', expires_in: 3600 });
		if (c.headers.authorization !== 'Bearer tok') return json({ errorCode: 'AUTH', errorMessage: 'no' }, 401);
		if (state.down) return json({ errorCode: 'INTERNAL', errorMessage: 'down' }, 503);
		if (u.pathname === '/api/ledger/v2/paygate' && c.method === 'POST') { exists = true; return new Response(null, { status: 204 }); }
		if (!exists) return json({ errorCode: 'LEDGER_NOT_FOUND', errorMessage: 'no ledger' }, 404);
		if (u.pathname === '/api/ledger/v2/paygate/transactions' && c.method === 'POST') {
			const tx = JSON.parse(c.body!);
			if (txs.some((t) => t.reference === tx.reference)) return json({ errorCode: 'CONFLICT', errorMessage: 'reference exists' }, 400);
			txs.push(tx); return json({ data: { id: txs.length } });
		}
		if (u.pathname === '/api/ledger/v2/paygate/accounts') {
			const pages = state.accounts ?? [[]], i = Number(u.searchParams.get('cursor') ?? 0);
			return json({ cursor: { data: pages[i] ?? [], hasMore: i + 1 < pages.length, next: String(i + 1) } });
		}
		return json({ errorCode: 'NOT_FOUND', errorMessage: u.pathname }, 404);
	};
	return { handler, txs, calls };
}
const ON = { FORMANCE_URL: 'https://formance.test', FORMANCE_CLIENT_ID: 'id', FORMANCE_CLIENT_SECRET: 'secret' };

test('the sweep copies the journal to Formance once: the posting is the reference, a repeat is not booked twice', async () => {
	const quiet = silence();
	try {
		resetFormanceToken();
		const g = await setup(ON);
		const f = formance({ exists: false });
		const net = stubFetch(f.handler);
		try {
			await g.call('POST', '/v1/disbursements', PAYOUT);
			const r = await postPending(g.env);
			assert.deepEqual(r, { posted: 1, failed: 0 });
			assert.equal(f.txs.length, 1, 'the ledger was created on the first post, then the posting went in');
			const tx = f.txs[0];
			assert.match(tx.reference, /^pg[0-9a-f]{18}:out$/);
			assert.deepEqual(tx.script.vars, { amount: `XOF ${PAYOUT.amount}`, source: 'tenants:shop:CIV:available', destination: 'world' });
			assert.match(tx.script.plain, /allowing unbounded overdraft/, 'this first step records, it does not refuse');
			assert.equal(tx.metadata.tenant, 'shop');

			g.sqlite.prepare('UPDATE ledger_postings SET posted_at = NULL').run(); // as if Formance's answer was lost
			assert.deepEqual(await postPending(g.env), { posted: 1, failed: 0 }, 'CONFLICT counts as posted');
			assert.equal(f.txs.length, 1);
			assert.deepEqual(await postPending(g.env), { posted: 0, failed: 0 }, 'nothing left');
		} finally { net.restore(); }
	} finally { quiet(); }
});

test('Formance down: postings wait (the payment is untouched), and go later', async () => {
	const quiet = silence();
	try {
		resetFormanceToken();
		const g = await setup(ON);
		const state = { down: true };
		const f = formance(state);
		const net = stubFetch(f.handler);
		try {
			const p = await g.call('POST', '/v1/disbursements', PAYOUT);
			assert.equal(p.body.status, 'completed', 'payments never wait for the books');
			await g.call('POST', '/v1/disbursements', { ...PAYOUT, reference: 'payout-2' });
			assert.deepEqual(await postPending(g.env), { posted: 0, failed: 1 }, 'one try, then the sweep stops: no hammering');
			assert.equal((g.sqlite.prepare('SELECT COUNT(*) AS n FROM ledger_postings WHERE posted_at IS NULL').get() as any).n, 2);
			state.down = false;
			assert.deepEqual(await postPending(g.env), { posted: 2, failed: 0 });
		} finally { net.restore(); }
	} finally { quiet(); }
});

test('no Formance configured: the journal is still kept and nothing is sent', async () => {
	const quiet = silence();
	try {
		const g = await setup();
		const net = stubFetch(() => undefined);
		try {
			await g.call('POST', '/v1/disbursements', PAYOUT);
			assert.deepEqual(await postPending(g.env), { posted: 0, failed: 0 });
			assert.equal((g.sqlite.prepare('SELECT COUNT(*) AS n FROM ledger_postings').get() as any).n, 1);
			assert.ok(!net.calls.length);
		} finally { net.restore(); }
	} finally { quiet(); }
});

test('reconciliation: the books beside the wallet and beside Formance, and adjustments explain the difference', async () => {
	const quiet = silence();
	try {
		resetFormanceToken();
		const g = await setup(ON);
		const vol = (input: number, output: number) => ({ XOF: { input, output } });
		const f = formance({ accounts: [[{ address: 'world', volumes: vol(0, 5000) }], [{ address: 'tenants:shop:CIV:available', volumes: vol(5000, 0) }]] });
		const net = stubFetch(f.handler);
		try {
			const c = await g.call('POST', '/v1/collections', COLLECT);
			await g.call('GET', `/v1/collections/${c.body.id}`);
			const providers = { disburse: { balances: async () => [{ country: 'CIV', currency: 'XOF', balance: COLLECT.amount + 80_000 }, { country: 'SEN', currency: 'XOF', balance: 10_000 }] } } as unknown as Providers;
			let r = await booksReport(g.env, providers);
			const civ = r.pools.find((p) => p.pool === 'CIV')!;
			assert.deepEqual([civ.total, civ.wallet, civ.difference, civ.formance], [COLLECT.amount, COLLECT.amount + 80_000, 80_000, 5000], 'Formance read across both pages');
			assert.deepEqual(r.pools.map((p) => p.pool), ['CIV', 'SEN'], 'a wallet with no postings still shows');

			// the studio's float is booked as unallocated money; then the books explain the wallet
			const bad = await g.admin('POST', '/admin/ledger/adjustments', { pool: 'CIV', amount: 80_000 });
			assert.equal(bad.body.error.code, 'invalid_note');
			assert.equal((await g.admin('POST', '/admin/ledger/adjustments', { pool: 'XYZ', amount: 1, note: 'x' })).body.error.code, 'invalid_pool');
			const adj = await g.admin('POST', '/admin/ledger/adjustments', { pool: 'CIV', amount: 80_000, note: 'opening float' });
			assert.equal(adj.status, 201);
			assert.match(adj.body.note, /opening float \(by operator\)/);
			r = await booksReport(g.env, providers);
			assert.deepEqual(r.pools.find((p) => p.pool === 'CIV')!.difference, 0);
			assert.equal(r.pools.find((p) => p.pool === 'CIV')!.unallocated, 80_000);

			const alerts = () => net.calls.filter((x) => x.url.includes('alerts.test')).map((x) => x.body ?? '');
			await checkBooks(g.env, providers);
			assert.ok(alerts().some((a) => a.includes('The books and the wallets disagree') && a.includes('SEN')), 'SEN holds money nobody booked');
			assert.equal((await g.call('GET', '/admin/ledger')).status, 401, 'a tenant key cannot read the books');
			assert.equal((await g.admin('GET', '/admin/ledger')).status, 200);
		} finally { net.restore(); }
	} finally { quiet(); }
});

test('account names round-trip tenant ids with dashes', () => {
	assert.deepEqual(booksFrom([['tenants:claude_test:BFA:available', 900], ['tenants:claude_test:BFA:held', 100], ['pool:BFA:unallocated', 5], ['world', -1005]]),
		[{ pool: 'BFA', tenants: [{ tenant: 'claude-test', available: 900, held: 100 }], unallocated: 5, total: 1005 }]);
});

test('rebuilding the books from many payments stays within D1 limits (at most 100 bound values per query)', async () => {
	const quiet = silence();
	try {
		const g = await setup();
		const insert = g.sqlite.prepare(`INSERT INTO payments (id, tenant_id, kind, reference, rail, operator, country, counterparty, amount, status, provider, request_hash, created_at, updated_at)
			VALUES (?, 'shop', 'collection', ?, 'mobile_money', 'orange', 'CIV', '+2250700000001', 100, 'completed', 'sandbox', 'h', 1, 1)`);
		for (let i = 0; i < 120; i++) insert.run(`pg${String(i).padStart(18, '0')}`, `bulk-${i}`);
		const r = await g.admin('POST', '/admin/ledger/backfill');
		assert.equal(r.status, 200, JSON.stringify(r.body));
		assert.deepEqual(r.body, { payments: 120, added: 120 });
	} finally { quiet(); }
});

test('two syncs of one payout racing (accepted, and its callback already completed) never book a hold and a payout from available', async () => {
	const quiet = silence();
	try {
		const g = await setup();
		const p = await g.call('POST', '/v1/disbursements', PAYOUT); // completes at once in the sandbox
		g.sqlite.prepare('DELETE FROM ledger_postings').run();
		const done = g.row(p.body.id);
		const stale = { ...done, status: 'processing' }; // what startDisbursement held before the callback landed
		await Promise.all([syncLedger(g.env, stale as any), syncLedger(g.env, done as any)]); // both read "nothing booked" before either writes
		const rows = g.sqlite.prepare('SELECT kind, source FROM ledger_postings ORDER BY kind').all() as any[];
		const [b] = await journalBalances(g.env);
		assert.deepEqual(b!.tenants[0], { tenant: 'shop', available: -PAYOUT.amount, held: 0 }, `paid out once, nothing stuck in held: ${JSON.stringify(rows)}`);
	} finally { quiet(); }
});

test('Formance refusing us (401, 403, 429) stops the sweep without spending every row\'s tries; a 401 drops the token; stuck postings can be retried', async () => {
	const quiet = silence();
	try {
		resetFormanceToken();
		const g = await setup(ON);
		let status = 401, tokens = 0;
		const net = stubFetch((c) => {
			const u = new URL(c.url);
			if (u.host !== 'formance.test') return undefined;
			if (u.pathname === '/api/auth/oauth/token') { tokens++; return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 })); }
			if (status !== 200) return new Response(JSON.stringify({ errorMessage: 'no' }), { status });
			return new Response(JSON.stringify({ data: { id: 1 } }));
		});
		try {
			for (let i = 0; i < 3; i++) await g.call('POST', '/v1/disbursements', { ...PAYOUT, reference: `payout-${i}` });
			for (const s of [401, 403, 429]) { status = s; assert.deepEqual(await postPending(g.env), { posted: 0, failed: 1 }, `${s}: one try, then stop`); }
			assert.equal(tokens, 2, 'the token was fetched again after the 401');
			g.sqlite.prepare('UPDATE ledger_postings SET attempts = 10').run(); // as if stuck
			status = 200;
			assert.deepEqual(await postPending(g.env), { posted: 0, failed: 0 }, 'stuck postings are not retried on their own');
			const r = await g.admin('POST', '/admin/ledger/retry');
			assert.deepEqual(r.body, { reset: 3 });
			assert.deepEqual(await postPending(g.env), { posted: 3, failed: 0 });
		} finally { net.restore(); }
	} finally { quiet(); }
});
