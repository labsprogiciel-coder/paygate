/**
 * The books: whose money is in the shared wallets. Payments say what happened; the ledger says who owns what.
 *
 * Every money movement is written as a double-entry posting to `ledger_postings` in D1, the journal (and the outbox): a collection that
 * completed credits its tenant, a payout that was sent is held, then paid out or released. One planner decides the postings from a payment's
 * state and the postings it already has, so live transitions, backfills and repeats all end in the same books, never twice.
 *
 * If FORMANCE_URL is set, a cron sweep copies the journal to a Formance ledger (the posting's reference is the Formance reference, so a
 * retry never books twice). Formance being down never touches payments: postings wait and go later.
 * This first step records only: scripts allow overdrafts, so a tenant paying out more than it collected shows as a negative balance
 * instead of being refused. Enforcing it comes once the books have run clean.
 *
 * Chart of accounts (asset XOF, whole francs), one pool per wallet: the pawaPay country (CIV, SEN, BFA) or PISPI for the bank account:
 *   tenants:{tenant}:{pool}:available   what a product owns in the pool
 *   tenants:{tenant}:{pool}:held        payouts sent and not final (processing or unknown)
 *   pool:{pool}:unallocated             float the studio put in (or fees taken out), owned by no product
 *   @world                              outside: customers, recipients, the studio's own top-ups
 * Formance addresses allow [a-zA-Z0-9_] segments; tenant ids are lowercase slugs, so their dashes become underscores (never ambiguous).
 */
import { alert } from './alerts.ts';
import type { PaymentRow } from './payments.ts';
import type { Providers, WalletBalance } from './providers/types.ts';
import { log, newId } from './util.ts';

export type PostingKind = 'in' | 'hold' | 'out' | 'release' | 'adjust';
export interface Posting { reference: string; payment_id: string | null; tenant_id: string | null; pool: string; kind: PostingKind; source: string; destination: string; amount: number; asset: string; note: string | null; created_at: number }

const seg = (s: string) => s.replace(/-/g, '_');
export const poolOf = (r: Pick<PaymentRow, 'rail' | 'country'>) => r.rail === 'mobile_money' ? (r.country ?? 'UNKNOWN') : 'PISPI';
export const tenantAccount = (tenant: string, pool: string, part: 'available' | 'held') => `tenants:${seg(tenant)}:${pool}:${part}`;
export const unallocated = (pool: string) => `pool:${pool}:unallocated`;

/** The postings a payment still needs, given those it has. Pure, so it is the whole policy in one place. */
export function plan(r: Pick<PaymentRow, 'id' | 'tenant_id' | 'kind' | 'status' | 'attempts' | 'amount' | 'currency' | 'rail' | 'country'>, have: ReadonlySet<PostingKind>, now: number): Posting[] {
	const pool = poolOf(r), available = tenantAccount(r.tenant_id, pool, 'available'), held = tenantAccount(r.tenant_id, pool, 'held');
	const p = (kind: PostingKind, source: string, destination: string): Posting => ({ reference: `${r.id}:${kind}`, payment_id: r.id, tenant_id: r.tenant_id, pool, kind, source, destination, amount: r.amount, asset: r.currency || 'XOF', note: null, created_at: now });
	if (r.kind === 'collection') return r.status === 'completed' && !have.has('in') ? [p('in', 'world', available)] : [];
	const holding = have.has('hold') && !have.has('release') && !have.has('out');
	if ((r.status === 'processing' || r.status === 'unknown') && r.attempts > 0 && !have.has('hold') && !have.has('out')) return [p('hold', available, held)];
	if (r.status === 'completed' && !have.has('out')) return [p('out', holding ? held : available, 'world')]; // a late completion after a release pays from available again
	if ((r.status === 'failed' || r.status === 'expired') && holding) return [p('release', held, available)];
	return [];
}

const INSERT = `INSERT OR IGNORE INTO ledger_postings (reference, payment_id, tenant_id, pool, kind, source, destination, amount, asset, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const insert = (env: Env, x: Posting) => env.DB.prepare(INSERT).bind(x.reference, x.payment_id, x.tenant_id, x.pool, x.kind, x.source, x.destination, x.amount, x.asset, x.note, x.created_at);

/** Brings one payment's postings up to date with its state. Never throws: the books must not stop a payment (a backfill repairs a miss). */
export async function syncLedger(env: Env, r: PaymentRow, now = Date.now()): Promise<void> {
	try {
		const { results } = await env.DB.prepare(`SELECT kind FROM ledger_postings WHERE payment_id = ?`).bind(r.id).all<{ kind: PostingKind }>();
		const todo = plan(r, new Set(results.map((x) => x.kind)), now);
		if (todo.length) await env.DB.batch(todo.map((x) => insert(env, x)));
	} catch (e) { console.error(JSON.stringify({ msg: 'ledger.sync_failed', payment: r.id, error: String(e) })); }
}

/** Every payment's postings brought up to date (for history from before the books, or after a miss). Idempotent. */
export async function backfillLedger(env: Env, now = Date.now()): Promise<{ payments: number; added: number }> {
	const before = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ledger_postings`).first<number>('n')) ?? 0;
	let payments = 0, after = '';
	for (;;) {
		const { results } = await env.DB.prepare(`SELECT * FROM payments WHERE id > ? ORDER BY id LIMIT 200`).bind(after).all<PaymentRow>();
		if (!results.length) break;
		const { results: had } = await env.DB.prepare(`SELECT payment_id, kind FROM ledger_postings WHERE payment_id IN (${results.map(() => '?').join(',')})`).bind(...results.map((r) => r.id)).all<{ payment_id: string; kind: PostingKind }>();
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

/** The journal's balances per pool (computed in D1, so they exist with or without Formance). */
export async function journalBalances(env: Env): Promise<PoolBooks[]> {
	const { results } = await env.DB.prepare(`SELECT account, SUM(delta) AS balance FROM (
		SELECT destination AS account, amount AS delta FROM ledger_postings UNION ALL SELECT source AS account, -amount AS delta FROM ledger_postings
	) WHERE account != 'world' GROUP BY account`).all<{ account: string; balance: number }>();
	return booksFrom(results.map((r) => [r.account, r.balance]));
}

/** Account balances grouped by pool. Tenant ids come back from the account names (underscores were dashes). */
export function booksFrom(balances: [string, number][]): PoolBooks[] {
	const pools = new Map<string, PoolBooks>();
	const get = (pool: string) => { let b = pools.get(pool); if (!b) pools.set(pool, b = { pool, tenants: [], unallocated: 0, total: 0 }); return b; };
	for (const [account, balance] of balances) {
		let m: RegExpExecArray | null;
		if ((m = /^tenants:([a-z0-9_]+):([A-Z]+):(available|held)$/.exec(account))) {
			const b = get(m[2]!), tenant = m[1]!.replace(/_/g, '-');
			let t = b.tenants.find((x) => x.tenant === tenant);
			if (!t) b.tenants.push(t = { tenant, available: 0, held: 0 });
			t[m[3] as 'available' | 'held'] += balance; b.total += balance;
		} else if ((m = /^pool:([A-Z]+):unallocated$/.exec(account))) { const b = get(m[1]!); b.unallocated += balance; b.total += balance; }
	}
	for (const b of pools.values()) b.tenants.sort((x, y) => x.tenant.localeCompare(y.tenant));
	return [...pools.values()].sort((x, y) => x.pool.localeCompare(y.pool));
}

// ---- Formance ---------------------------------------------------------------------------------------------------------------------

export const ledgerEnabled = (env: Env) => !!env.FORMANCE_URL;
const LEDGER = (env: Env) => env.FORMANCE_LEDGER || 'paygate';
const SWEEP_BATCH = 50;
/** Postings that keep failing are left for a person after this many tries (an alert says so); the rest wait for the next sweep. */
export const MAX_ATTEMPTS = 10;

// the source may go negative (record, don't enforce, in this first step); @world is unbounded already
const SEND = `vars {
  monetary $amount
  account $source
  account $destination
}
send $amount (
  source = $source allowing unbounded overdraft
  destination = $destination
)`;
const FROM_WORLD = SEND.replace(' allowing unbounded overdraft', '');

class FormanceError extends Error {
	status: number; code: string | undefined;
	constructor(status: number, code: string | undefined, message: string) { super(message); this.status = status; this.code = code; }
}

let token: { value: string; until: number } | null = null;
/** An OAuth client-credentials token (Formance Cloud), cached until a minute before it expires. None for an open stack. */
async function bearer(env: Env): Promise<Record<string, string>> {
	if (!env.FORMANCE_CLIENT_ID) return {};
	if (token && Date.now() < token.until) return { authorization: `Bearer ${token.value}` };
	const url = new URL(env.FORMANCE_TOKEN_URL || '/api/auth/oauth/token', env.FORMANCE_URL);
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
	const res = await fetch(new URL(`/api/ledger/v2/${encodeURIComponent(LEDGER(env))}${path}`, env.FORMANCE_URL).href, {
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
	const { results } = await env.DB.prepare(`SELECT * FROM ledger_postings WHERE posted_at IS NULL AND attempts < ? ORDER BY created_at, reference LIMIT ?`).bind(MAX_ATTEMPTS, SWEEP_BATCH).all<Posting & { attempts: number }>();
	let posted = 0, failed = 0, created = false;
	for (const x of results) {
		const tx = {
			reference: x.reference, timestamp: new Date(x.created_at).toISOString(),
			metadata: Object.fromEntries(Object.entries({ kind: x.kind, pool: x.pool, paymentId: x.payment_id, tenant: x.tenant_id, note: x.note }).filter(([, v]) => v != null)) as Record<string, string>,
			script: { plain: x.source === 'world' ? FROM_WORLD : SEND, vars: { amount: `${x.asset} ${x.amount}`, source: x.source, destination: x.destination } },
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
			if (!(e instanceof FormanceError) || e.status >= 500 || e.code === 'AUTH') break; // Formance unreachable or refusing us: try again next sweep, not row by row
		}
	}
	if (posted || failed) log('ledger.sweep', { posted, failed });
	return { posted, failed };
}

/** Formance's balances per pool, read from every account (the ledger is small: one account per tenant and pool). */
export async function formanceBalances(env: Env): Promise<PoolBooks[]> {
	const all: [string, number][] = [];
	let cursor: string | undefined;
	for (let page = 0; page < 50; page++) {
		const q = new URLSearchParams({ expand: 'volumes', pageSize: '100' });
		if (cursor) q.set('cursor', cursor);
		const j = (await formance(env, 'GET', `/accounts?${q}`)) as { cursor?: { data?: { address: string; volumes?: Record<string, { input: number; output: number; balance?: number }> }[]; hasMore?: boolean; next?: string } };
		for (const a of j.cursor?.data ?? []) {
			const v = Object.entries(a.volumes ?? {}).find(([asset]) => asset.split('/')[0] === 'XOF')?.[1];
			if (v) all.push([a.address, Number(v.balance ?? Number(v.input) - Number(v.output))]);
		}
		if (!j.cursor?.hasMore || !j.cursor.next) break;
		cursor = j.cursor.next;
	}
	return booksFrom(all);
}

/** What waits to reach Formance. */
export async function outboxHealth(env: Env) {
	return (await env.DB.prepare(`SELECT COUNT(CASE WHEN posted_at IS NULL THEN 1 END) AS pending, COUNT(CASE WHEN posted_at IS NULL AND attempts >= ? THEN 1 END) AS stuck,
		MIN(CASE WHEN posted_at IS NULL THEN created_at END) AS oldest, COUNT(*) AS total FROM ledger_postings`).bind(MAX_ATTEMPTS).first<{ pending: number; stuck: number; oldest: number | null; total: number }>())
		?? { pending: 0, stuck: 0, oldest: null, total: 0 };
}

// ---- reconciliation ---------------------------------------------------------------------------------------------------------------

export interface BooksRow extends PoolBooks { wallet: number | null; difference: number | null; formance: number | null }

/**
 * The books beside the money: per pool, what the journal says each tenant owns, what the provider's wallet really holds, and what
 * Formance has. wallet - total is money the books cannot explain (provider fees, float put in, history from before the books) until an
 * operator books it as an adjustment. Formance differing from the journal means the copy is behind (see the outbox) or was changed.
 */
export async function booksReport(env: Env, providers: Providers) {
	const [journal, outbox] = await Promise.all([journalBalances(env), outboxHealth(env)]);
	let wallets: WalletBalance[] | null = null, walletsError: string | null = null, formance: PoolBooks[] | null = null, formanceError: string | null = null;
	if (providers.disburse.balances) { try { wallets = await providers.disburse.balances(); } catch (e) { walletsError = String(e instanceof Error ? e.message : e).slice(0, 200); } }
	if (ledgerEnabled(env)) { try { formance = await formanceBalances(env); } catch (e) { formanceError = String(e instanceof Error ? e.message : e).slice(0, 200); } }
	const xof = (wallets ?? []).filter((w) => w.currency === 'XOF');
	const pools = [...new Set([...journal.map((b) => b.pool), ...xof.map((w) => w.country), ...(formance ?? []).map((b) => b.pool)])].sort();
	const rows: BooksRow[] = pools.map((pool) => {
		const b = journal.find((x) => x.pool === pool) ?? { pool, tenants: [], unallocated: 0, total: 0 };
		const w = xof.filter((x) => x.country === pool);
		const wallet = w.length ? w.reduce((a, x) => a + x.balance, 0) : null;
		return { ...b, wallet, difference: wallet === null ? null : wallet - b.total, formance: formance ? (formance.find((x) => x.pool === pool)?.total ?? 0) : null };
	});
	return { enabled: ledgerEnabled(env), ledger: ledgerEnabled(env) ? LEDGER(env) : null, outbox, walletsError, formanceError, pools: rows };
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
