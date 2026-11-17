/**
 * The books: whose money is in the shared wallets. Payments say what happened; the ledger says who owns what.
 *
 * Every money movement is written as a double-entry posting to `ledger_postings` in D1, the journal (and the outbox): a collection that
 * completed credits its tenant (and is debited again if an operator returns it to the payer), a payout that was sent is held, then paid out or released. One planner decides the postings from a payment's
 * state and the postings it already has, so live transitions, backfills and repeats all end in the same books, never twice.
 *
 * If FORMANCE_BASE_URL is set, a cron sweep copies the journal to a Formance ledger (the posting's reference is the Formance reference, so a
 * retry never books twice). Formance being down never touches payments: postings wait and go later.
 * This first step records only: scripts allow overdrafts, so a tenant paying out more than it collected shows as a negative balance
 * instead of being refused. Enforcing it comes once the books have run clean.
 *
 * Chart of accounts (asset XOF, whole francs), one pool per wallet of the registry (src/wallets.ts), named by country and rail, the wallet id:
 *   tenants:{tenant}:{country}:{rail}:available   what a product owns in the wallet (tenants:shop:CIV:PAWAPAY:available)
 *   tenants:{tenant}:{country}:{rail}:held        payouts sent and not final (processing or unknown)
 *   pool:{country}:{rail}:unallocated             float the studio put in (or fees taken out), owned by no product
 *   @world                                        outside: customers, recipients, the studio's own top-ups
 * So one Formance aggregate-balance pattern answers each question: one wallet `tenants::SEN:PISPI:` + `pool:SEN:PISPI:`, one country
 * `tenants::CIV::` + `pool:CIV::`, one product `tenants:shop:::`, one product in one country `tenants:shop:CIV::`.
 * Formance addresses allow [a-zA-Z0-9_] segments; tenant ids are lowercase slugs, so their dashes become underscores (never ambiguous).
 */
import { alert } from './alerts.ts';
import type { PaymentRow } from './payments.ts';
import type { Providers, WalletBalance } from './providers/types.ts';
import { log, newId } from './util.ts';

export type PostingKind = 'in' | 'hold' | 'out' | 'release' | 'refund' | 'adjust';
export interface Posting { reference: string; payment_id: string | null; tenant_id: string | null; pool: string; kind: PostingKind; source: string; destination: string; amount: number; asset: string; note: string | null; created_at: number }

const seg = (s: string) => s.replace(/-/g, '_');
/** A pool is a wallet id, `<country>:<rail>`. Every payment records its wallet; one made before the registry falls back on its rail and country. */
export const poolOf = (r: Pick<PaymentRow, 'rail' | 'country'> & Partial<Pick<PaymentRow, 'wallet_id'>>) =>
	r.wallet_id ?? `${r.country ?? 'UNKNOWN'}:${r.rail === 'mobile_money' ? 'PAWAPAY' : 'PISPI'}`;
export const tenantAccount = (tenant: string, pool: string, part: 'available' | 'held') => `tenants:${seg(tenant)}:${pool}:${part}`;
export const unallocated = (pool: string) => `pool:${pool}:unallocated`;

/** The postings a payment still needs, given those it has. Pure, so it is the whole policy in one place. */
export function plan(r: Pick<PaymentRow, 'id' | 'tenant_id' | 'kind' | 'status' | 'attempts' | 'amount' | 'currency' | 'rail' | 'country'> & Partial<Pick<PaymentRow, 'return_status' | 'wallet_id'>>, have: ReadonlySet<PostingKind>, now: number): Posting[] {
	const pool = poolOf(r), available = tenantAccount(r.tenant_id, pool, 'available'), held = tenantAccount(r.tenant_id, pool, 'held');
	const p = (kind: PostingKind, source: string, destination: string): Posting => ({ reference: `${r.id}:${kind}`, payment_id: r.id, tenant_id: r.tenant_id, pool, kind, source, destination, amount: r.amount, asset: r.currency || 'XOF', note: null, created_at: now });
	if (r.kind === 'collection') {
		if (r.status !== 'completed') return []; // money that arrived without settling an order (a mismatch) was never booked, so its return books nothing either
		const out = have.has('in') ? [] : [p('in', 'world', available)];
		if (r.return_status === 'returned' && !have.has('refund')) out.push(p('refund', available, 'world')); // sent back to the payer: once, from what the product holds
		return out;
	}
	const holding = have.has('hold') && !have.has('release') && !have.has('out');
	if ((r.status === 'processing' || r.status === 'unknown') && r.attempts > 0 && !have.has('hold') && !have.has('out')) return [p('hold', available, held)];
	if (r.status === 'completed' && !have.has('out')) return [p('out', holding ? held : available, 'world')]; // a late completion after a release pays from available again
	if ((r.status === 'failed' || r.status === 'expired') && holding) return [p('release', held, available)];
	return [];
}

/**
 * A posting is written only if what the planner assumed about the payment's other postings is still true, checked in the same statement.
 * Two syncs of one payment racing (a payout accepted while its callback lands) can then never book both a hold and a payout from available,
 * or release a hold that was already paid out: the loser's insert does nothing, and it plans again from what is really there.
 */
const has = (kind: PostingKind) => `EXISTS (SELECT 1 FROM ledger_postings WHERE payment_id = ?2 AND kind = '${kind}')`;
const holding = `(${has('hold')} AND NOT ${has('release')} AND NOT ${has('out')})`;
const GUARD: Record<string, string> = {
	hold: `NOT ${has('hold')} AND NOT ${has('out')}`,
	'out:held': holding,
	'out:available': `NOT ${holding} AND NOT ${has('out')}`,
	release: holding,
};
const insert = (env: Env, x: Posting) => {
	const guard = GUARD[x.kind === 'out' ? `out:${x.source.endsWith(':held') ? 'held' : 'available'}` : x.kind];
	return env.DB.prepare(`INSERT OR IGNORE INTO ledger_postings (reference, payment_id, tenant_id, pool, kind, source, destination, amount, asset, note, created_at)
		SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11 ${guard ? `WHERE ${guard}` : ''}`)
		.bind(x.reference, x.payment_id, x.tenant_id, x.pool, x.kind, x.source, x.destination, x.amount, x.asset, x.note, x.created_at);
};

/** Brings one payment's postings up to date with its state. Never throws: the books must not stop a payment (a backfill repairs a miss). */
export async function syncLedger(env: Env, r: PaymentRow, now = Date.now()): Promise<void> {
	try {
		for (let round = 0; round < 3; round++) { // a guarded insert that did nothing means another sync got there first: plan again from what it booked
			const { results } = await env.DB.prepare(`SELECT kind FROM ledger_postings WHERE payment_id = ?`).bind(r.id).all<{ kind: PostingKind }>();
			const todo = plan(r, new Set(results.map((x) => x.kind)), now);
			if (!todo.length) return;
			const done = await env.DB.batch(todo.map((x) => insert(env, x)));
			if (done.every((d) => d.meta.changes)) return;
		}
	} catch (e) { console.error(JSON.stringify({ msg: 'ledger.sync_failed', payment: r.id, error: String(e) })); }
}

/** Every payment's postings brought up to date (for history from before the books, or after a miss). Idempotent. */
export async function backfillLedger(env: Env, now = Date.now()): Promise<{ payments: number; added: number }> {
	const before = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ledger_postings`).first<number>('n')) ?? 0;
	let payments = 0, after = '';
	for (;;) {
		// a page of payments, and their postings by id range: two bound values, whatever the page size (D1 allows 100 per query)
		const { results } = await env.DB.prepare(`SELECT * FROM payments WHERE id > ? ORDER BY id LIMIT 100`).bind(after).all<PaymentRow>();
		if (!results.length) break;
		const { results: had } = await env.DB.prepare(`SELECT payment_id, kind FROM ledger_postings WHERE payment_id > ? AND payment_id <= ?`).bind(after, results.at(-1)!.id).all<{ payment_id: string; kind: PostingKind }>();
		const todo = results.flatMap((r) => plan(r, new Set(had.filter((h) => h.payment_id === r.id).map((h) => h.kind)), r.settled_at ?? r.updated_at ?? now));
		if (todo.length) await env.DB.batch(todo.map((x) => insert(env, x)));
		payments += results.length; after = results.at(-1)!.id;
	}
	const added = ((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ledger_postings`).first<number>('n')) ?? 0) - before;
	return { payments, added };
}

/** An operator's correction of a pool: float the studio put in (positive) or fees and losses taken out (negative). */
export async function adjustPool(env: Env, pool: string, amount: number, note: string, actor: string, now = Date.now()): Promise<Posting> {
	const x: Posting = { reference: `adj_${newId('', 8)}`, payment_id: null, tenant_id: null, pool, kind: 'adjust', source: amount > 0 ? 'world' : unallocated(pool), destination: amount > 0 ? unallocated(pool) : 'world',
		amount: Math.abs(amount), asset: 'XOF', note: `${note} (by ${actor})`.slice(0, 300), created_at: now };
	await insert(env, x).run();
	return x;
}

// ---- balances ---------------------------------------------------------------------------------------------------------------------

export interface PoolBooks { pool: string; tenants: { tenant: string; available: number; held: number }[]; unallocated: number; total: number }

/** The journal's balances per pool (computed in D1, so they exist with or without Formance), as of `at` (ms) when given: postings dated up to then. */
export async function journalBalances(env: Env, at: number | null = null): Promise<PoolBooks[]> {
	const upTo = at === null ? '' : 'WHERE created_at <= ?1';
	const q = env.DB.prepare(`SELECT account, SUM(delta) AS balance FROM (
		SELECT destination AS account, amount AS delta FROM ledger_postings ${upTo} UNION ALL SELECT source AS account, -amount AS delta FROM ledger_postings ${upTo}
	) WHERE account != 'world' GROUP BY account`);
	const { results } = await (at === null ? q : q.bind(at)).all<{ account: string; balance: number }>();
	return booksFrom(results.map((r) => [r.account, r.balance]));
}

/** Account balances grouped by pool. Tenant ids come back from the account names (underscores were dashes). */
export function booksFrom(balances: [string, number][]): PoolBooks[] {
	const pools = new Map<string, PoolBooks>();
	const get = (pool: string) => { let b = pools.get(pool); if (!b) pools.set(pool, b = { pool, tenants: [], unallocated: 0, total: 0 }); return b; };
	for (const [account, balance] of balances) {
		let m: RegExpExecArray | null;
		if ((m = /^tenants:([a-z0-9_]+):([A-Z]+:[A-Z]+):(available|held)$/.exec(account))) {
			const b = get(m[2]!), tenant = m[1]!.replace(/_/g, '-');
			let t = b.tenants.find((x) => x.tenant === tenant);
			if (!t) b.tenants.push(t = { tenant, available: 0, held: 0 });
			t[m[3] as 'available' | 'held'] += balance; b.total += balance;
		} else if ((m = /^pool:([A-Z]+:[A-Z]+):unallocated$/.exec(account))) { const b = get(m[1]!); b.unallocated += balance; b.total += balance; }
	}
	for (const b of pools.values()) b.tenants.sort((x, y) => x.tenant.localeCompare(y.tenant));
	return [...pools.values()].sort((x, y) => x.pool.localeCompare(y.pool));
}

// ---- Formance ---------------------------------------------------------------------------------------------------------------------

export const ledgerEnabled = (env: Env) => !!env.FORMANCE_BASE_URL;
/** paygate-v2: the books by wallet (migration 0006). The first ledger, `paygate`, holds the old addresses and is never written again. */
const LEDGER = (env: Env) => env.FORMANCE_LEDGER || 'paygate-v2';
const SWEEP_BATCH = 50;
/** Postings that keep failing are left for a person after this many tries (an alert says so); the rest wait for the next sweep. */
export const MAX_ATTEMPTS = 10;

// the source may go negative (record, don't enforce, in this first step)
const SEND = `vars {
  monetary $amount
  account $source
  account $destination
}
send $amount (
  source = $source allowing unbounded overdraft
  destination = $destination
)`;
// money coming in from outside: Formance refuses @world as a variable source ("can only be used as a variable in the experimental
// interpreter"), so it is written literally; it is unbounded already
const FROM_WORLD = `vars {
  monetary $amount
  account $destination
}
send $amount (
  source = @world
  destination = $destination
)`;

class FormanceError extends Error {
	status: number; code: string | undefined;
	constructor(status: number, code: string | undefined, message: string) { super(message); this.status = status; this.code = code; }
}

let token: { value: string; until: number } | null = null;
/** An OAuth client-credentials token (Formance Cloud), cached until a minute before it expires. None for an open stack. */
async function bearer(env: Env): Promise<Record<string, string>> {
	if (!env.FORMANCE_CLIENT_ID) return {};
	if (token && Date.now() < token.until) return { authorization: `Bearer ${token.value}` };
	const url = new URL(env.FORMANCE_TOKEN_URL || '/api/auth/oauth/token', env.FORMANCE_BASE_URL);
	const res = await fetch(url.href, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(10_000),
		body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.FORMANCE_CLIENT_ID, client_secret: env.FORMANCE_CLIENT_SECRET ?? '' }) });
	if (!res.ok) throw new FormanceError(res.status, 'AUTH', `Formance token request failed (${res.status})`);
	const j = (await res.json()) as { access_token?: string; expires_in?: number };
	if (!j.access_token) throw new FormanceError(res.status, 'AUTH', 'Formance returned no access token');
	token = { value: j.access_token, until: Date.now() + Math.max(60, (j.expires_in ?? 300) - 60) * 1000 };
	return { authorization: `Bearer ${token.value}` };
}
export const resetFormanceToken = () => { token = null; };

async function formance(env: Env, method: string, path: string, body?: unknown): Promise<unknown> {
	const res = await fetch(new URL(`/api/ledger/v2/${encodeURIComponent(LEDGER(env))}${path}`, env.FORMANCE_BASE_URL).href, {
		method, signal: AbortSignal.timeout(10_000),
		headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(await bearer(env)) },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	const j = text ? (() => { try { return JSON.parse(text) } catch { return null } })() : null;
	if (!res.ok) throw new FormanceError(res.status, j?.errorCode, `${j?.errorCode ?? res.status}: ${String(j?.errorMessage ?? text).slice(0, 200)}`);
	return j;
}

/** Sends the oldest unposted postings to Formance. A reference Formance already has counts as posted (a retry after a lost answer). */
export async function postPending(env: Env, now = Date.now()): Promise<{ posted: number; failed: number }> {
	if (!ledgerEnabled(env)) return { posted: 0, failed: 0 };
	const { results } = await env.DB.prepare(`SELECT * FROM ledger_postings WHERE posted_at IS NULL AND attempts < ? AND pool LIKE '%:%' ORDER BY created_at, reference LIMIT ?`).bind(MAX_ATTEMPTS, SWEEP_BATCH).all<Posting & { attempts: number }>();
	let posted = 0, failed = 0, created = false;
	for (const x of results) {
		const tx = {
			reference: x.reference, timestamp: new Date(x.created_at).toISOString(),
			metadata: Object.fromEntries(Object.entries({ kind: x.kind, pool: x.pool, paymentId: x.payment_id, tenant: x.tenant_id, note: x.note }).filter(([, v]) => v != null)) as Record<string, string>,
			script: x.source === 'world'
				? { plain: FROM_WORLD, vars: { amount: `${x.asset} ${x.amount}`, destination: x.destination } }
				: { plain: SEND, vars: { amount: `${x.asset} ${x.amount}`, source: x.source, destination: x.destination } },
		};
		try {
			let id: string | null = null;
			try { id = String(((await formance(env, 'POST', '/transactions', tx)) as { data?: { id?: unknown } } | null)?.data?.id ?? ''); }
			catch (e) {
				if (e instanceof FormanceError && e.code === 'LEDGER_NOT_FOUND' && !created) { // first post to a new ledger: create it, once
					created = true;
					await formance(env, 'POST', '', {}).catch((err) => { if (!(err instanceof FormanceError && err.code === 'LEDGER_ALREADY_EXISTS')) throw err; });
					id = String(((await formance(env, 'POST', '/transactions', tx)) as { data?: { id?: unknown } } | null)?.data?.id ?? '');
				} else if (e instanceof FormanceError && e.code === 'CONFLICT') id = null; // already there
				else throw e;
			}
			await env.DB.prepare(`UPDATE ledger_postings SET posted_at = ?, ledger_tx_id = ?, last_error = NULL WHERE reference = ?`).bind(now, id || null, x.reference).run();
			posted++;
		} catch (e) {
			await env.DB.prepare(`UPDATE ledger_postings SET attempts = attempts + 1, last_error = ? WHERE reference = ?`).bind(String(e instanceof Error ? e.message : e).slice(0, 300), x.reference).run();
			failed++;
			if (e instanceof FormanceError && e.status === 401) token = null; // a revoked or expired token: get a new one next time
			// Formance unreachable, refusing us or rate-limiting: try again next sweep, not row by row (each row would lose a try for nothing)
			if (!(e instanceof FormanceError) || e.status >= 500 || e.status === 401 || e.status === 403 || e.status === 429 || e.code === 'AUTH') break;
		}
	}
	if (posted || failed) log('ledger.sweep', { posted, failed });
	return { posted, failed };
}

/**
 * What Formance holds for an address pattern, in XOF, as of `at` (each posting's own date) when given: one aggregate-balance call, however many
 * accounts match. Empty segments match anything (`tenants::SEN:PISPI:` is every product's money in that wallet). The filter goes in `?query=`,
 * which the ledger reads when there is no body: a Worker cannot send a body with GET.
 */
export async function formanceAggregate(env: Env, patterns: string[], at: number | null = null): Promise<number> {
	const filter = patterns.length === 1 ? { $match: { address: patterns[0] } } : { $or: patterns.map((address) => ({ $match: { address } })) };
	const q = new URLSearchParams({ query: JSON.stringify(filter) });
	if (at !== null) q.set('pit', new Date(at).toISOString());
	const j = (await formance(env, 'GET', `/aggregate/balances?${q}`)) as { data?: Record<string, unknown> } | null;
	return Object.entries(j?.data ?? {}).filter(([asset]) => asset.split('/')[0] === 'XOF').reduce((n, [, v]) => n + Number(v), 0);
}
/** A wallet's money in Formance: every product's accounts in it and its unallocated float. */
export const walletPatterns = (pool: string) => [`tenants::${pool}:`, `pool:${pool}:`];

/** Formance's total per wallet, one aggregate call each (no paging, however many products), as of `at` when given. */
export async function formanceWalletTotals(env: Env, pools: string[], at: number | null = null): Promise<Map<string, number>> {
	const totals = await Promise.all(pools.map(async (pool) => [pool, await formanceAggregate(env, walletPatterns(pool), at)] as const));
	return new Map(totals);
}

/** Gives stuck postings their tries back (after Formance access is fixed): the next sweep sends them again. */
export async function retryStuck(env: Env): Promise<{ reset: number }> {
	const r = await env.DB.prepare(`UPDATE ledger_postings SET attempts = 0, last_error = NULL WHERE posted_at IS NULL AND attempts >= ?`).bind(MAX_ATTEMPTS).run();
	return { reset: r.meta.changes ?? 0 };
}

/** What waits to reach Formance. */
export async function outboxHealth(env: Env) {
	return (await env.DB.prepare(`SELECT COUNT(CASE WHEN posted_at IS NULL THEN 1 END) AS pending, COUNT(CASE WHEN posted_at IS NULL AND attempts >= ? THEN 1 END) AS stuck,
		MIN(CASE WHEN posted_at IS NULL THEN created_at END) AS oldest, COUNT(*) AS total FROM ledger_postings`).bind(MAX_ATTEMPTS).first<{ pending: number; stuck: number; oldest: number | null; total: number }>())
		?? { pending: 0, stuck: 0, oldest: null, total: 0 };
}

// ---- reconciliation ---------------------------------------------------------------------------------------------------------------

export interface BooksRow extends PoolBooks { wallet: number | null; difference: number | null; formance: number | null }
/** A country's wallets added up (every rail): the subtotal row of the books. */
export interface CountryRow { country: string; pools: string[]; total: number; wallet: number | null; difference: number | null; formance: number | null }

/**
 * The books beside the money: per pool, what the journal says each tenant owns, what the provider's wallet really holds, and what
 * Formance has. wallet - total is money the books cannot explain (provider fees, float put in, history from before the books) until an
 * operator books it as an adjustment. Formance differing from the journal means the copy is behind (see the outbox) or was changed.
 */
export async function booksReport(env: Env, providers: Providers, at: number | null = null) {
	const [journal, outbox, registry] = await Promise.all([journalBalances(env, at), outboxHealth(env),
		env.DB.prepare(`SELECT id FROM wallets WHERE status = 'active'`).all<{ id: string }>().then((r) => r.results.map((w) => w.id), () => [] as string[])]);
	let wallets: WalletBalance[] | null = null, walletsError: string | null = null, formance: Map<string, number> | null = null, formanceError: string | null = null;
	// a provider only reports what its wallets hold now: as of a past date there is nothing to compare with (the statement is)
	if (providers.disburse.balances && at === null) { try { wallets = await providers.disburse.balances(); } catch (e) { walletsError = String(e instanceof Error ? e.message : e).slice(0, 200); } }
	const xof = (wallets ?? []).filter((w) => w.currency === 'XOF');
	// one row per wallet: every active wallet of the registry, and any other the journal or the provider knows
	const pools = [...new Set([...registry, ...journal.map((b) => b.pool), ...xof.map((w) => `${w.country}:PAWAPAY`)])].sort();
	if (ledgerEnabled(env)) { try { formance = await formanceWalletTotals(env, pools, at); } catch (e) { formanceError = String(e instanceof Error ? e.message : e).slice(0, 200); } }
	const rows: BooksRow[] = pools.map((pool) => {
		const b = journal.find((x) => x.pool === pool) ?? { pool, tenants: [], unallocated: 0, total: 0 };
		const w = xof.filter((x) => `${x.country}:PAWAPAY` === pool); // pawaPay reports its wallets; PI-SPI reports no balance
		const wallet = w.length ? w.reduce((a, x) => a + x.balance, 0) : null;
		return { ...b, wallet, difference: wallet === null ? null : wallet - b.total, formance: formance ? (formance.get(pool) ?? 0) : null };
	});
	// a subtotal per country, every rail: what the studio holds there
	const sum = (xs: (number | null)[]) => xs.some((x) => x !== null) ? xs.reduce<number>((n, x) => n + (x ?? 0), 0) : null;
	const countries: CountryRow[] = [...new Set(rows.map((r) => r.pool.split(':')[0]!))].sort().map((country) => {
		const in_ = rows.filter((r) => r.pool.split(':')[0] === country);
		return { country, pools: in_.map((r) => r.pool), total: in_.reduce((n, r) => n + r.total, 0), wallet: sum(in_.map((r) => r.wallet)), difference: sum(in_.map((r) => r.difference)), formance: sum(in_.map((r) => r.formance)) };
	});
	return { enabled: ledgerEnabled(env), ledger: ledgerEnabled(env) ? LEDGER(env) : null, at, outbox, walletsError, formanceError, pools: rows, countries };
}

/**
 * One product's money, per wallet and per country, as of `at` when given: from the journal (the source of truth), and Formance's total per
 * country (`tenants:{product}:{country}::`, one aggregate call each) beside it when Formance is set up.
 */
export async function tenantHoldings(env: Env, tenant: string, at: number | null = null) {
	const wallets = (await journalBalances(env, at)).flatMap((b) => b.tenants.filter((t) => t.tenant === tenant).map((t) => ({ wallet: b.pool, available: t.available, held: t.held })));
	const byCountry = new Map<string, { country: string; available: number; held: number; formance: number | null }>();
	for (const w of wallets) {
		const c = w.wallet.split(':')[0]!;
		const row = byCountry.get(c) ?? { country: c, available: 0, held: 0, formance: null };
		row.available += w.available; row.held += w.held; byCountry.set(c, row);
	}
	let formanceError: string | null = null;
	if (ledgerEnabled(env)) {
		try { await Promise.all([...byCountry.values()].map(async (c) => { c.formance = await formanceAggregate(env, [`tenants:${seg(tenant)}:${c.country}::`], at); })); }
		catch (e) { formanceError = String(e instanceof Error ? e.message : e).slice(0, 200); for (const c of byCountry.values()) c.formance = null; }
	}
	return { tenant, at, wallets, countries: [...byCountry.values()].sort((a, b) => a.country.localeCompare(b.country)), formanceError };
}

/** Once a day: tell a person when the books and the money disagree, or postings are stuck on their way to Formance. */
export async function checkBooks(env: Env, providers: Providers): Promise<{ off: string[] }> {
	const r = await booksReport(env, providers);
	const off = r.pools.filter((p) => p.difference !== null && p.difference !== 0).map((p) => p.pool);
	if (off.length) await alert(env, { level: 'warning', title: 'The books and the wallets disagree', details: Object.fromEntries(r.pools.filter((p) => off.includes(p.pool)).map((p) => [p.pool, `wallet ${p.wallet}, books ${p.total}, difference ${p.difference}`])) });
	if (r.outbox.stuck) await alert(env, { level: 'warning', title: 'Ledger postings are stuck on their way to Formance', details: { stuck: r.outbox.stuck, pending: r.outbox.pending } });
	const drift = r.enabled && !r.formanceError && !r.outbox.pending ? r.pools.filter((p) => p.formance !== p.total).map((p) => p.pool) : [];
	if (drift.length) await alert(env, { level: 'warning', title: 'Formance and the journal disagree', details: Object.fromEntries(r.pools.filter((p) => drift.includes(p.pool)).map((p) => [p.pool, `journal ${p.total}, formance ${p.formance}`])) });
	return { off };
}
