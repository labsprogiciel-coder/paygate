/**
 * One feed of everything that happened, newest first, for the operator console: payment status changes, provider callbacks in, webhooks out.
 * Each source is read with its own query and the three are merged here. Order is (time, id) descending, and the cursor is the last item's `<at>:<id>`,
 * so events sharing a timestamp are never skipped or repeated across pages.
 */
import { databaseBytes, DB_LIMIT_BYTES } from './retention.ts';

export type Source = 'payment' | 'callback' | 'webhook';
export const SOURCES: readonly Source[] = ['payment', 'callback', 'webhook'];

export interface FeedItem {
	source: Source;
	id: string; // unique across sources; numeric ids are zero-padded so text order is time order
	at: number;
	type: string; // payment: the event (completed, failed, ...); callback: the path; webhook: the event type
	status: string; // payment: the event; callback: accepted | rejected; webhook: pending | delivered | dead
	problem: boolean; // something a person should look at
	tenant: string | null;
	paymentId: string | null;
	actor: string | null;
	detail: string | null; // a short note: the event detail, or the last delivery error
	attempts: number | null;
	body: string | null; // the callback body or the webhook payload, as stored
	kind?: string; amount?: number; provider?: string; rail?: string; operator?: string | null;
}

export interface FeedQuery { sources?: Source[]; problems?: boolean; tenant?: string | null; payment?: string | null; before?: string | null; limit?: number }

/** Payment events a person should look at. */
const PAYMENT_PROBLEMS = ['failed', 'unknown', 'mismatch', 'late_completion'];

export async function eventFeed(env: Env, q: FeedQuery = {}): Promise<{ data: FeedItem[]; next: string | null }> {
	const limit = Math.min(Math.max(Math.floor(q.limit ?? 50), 1), 200);
	const m = /^(\d{1,16}):([A-Za-z0-9_]{1,64})$/.exec(q.before ?? '');
	const [at, id] = m ? [Number(m[1]), m[2]!] : [Number.MAX_SAFE_INTEGER, ''];
	/** older than the cursor in (time, feed id) order; `t` and `fid` are the source's columns */
	const older = (t: string, fid: string) => ({ sql: `(${t} < ? OR (${t} = ? AND ${fid} < ?))`, binds: [at, at, id] });
	const want = new Set(q.sources?.length ? q.sources : SOURCES);
	// a provider callback belongs to no tenant or payment until it is matched, so those filters leave callbacks out
	if (q.tenant || q.payment) want.delete('callback');
	const take = limit + 1;
	const runs: Promise<FeedItem[]>[] = [];

	if (want.has('payment')) {
		const fid = `printf('pe_%012d', e.id)`, c = older('e.created_at', fid);
		const where = [c.sql], binds: unknown[] = [...c.binds];
		if (q.tenant) { where.push('p.tenant_id = ?'); binds.push(q.tenant); }
		if (q.payment) { where.push('e.payment_id = ?'); binds.push(q.payment); }
		if (q.problems) where.push(`e.type IN (${PAYMENT_PROBLEMS.map(() => '?').join(', ')})`), binds.push(...PAYMENT_PROBLEMS);
		runs.push(env.DB.prepare(`SELECT ${fid} AS fid, e.payment_id, e.type, e.actor, e.detail, e.created_at, p.tenant_id, p.kind, p.amount, p.provider, p.rail, p.operator
			FROM payment_events e JOIN payments p ON p.id = e.payment_id WHERE ${where.join(' AND ')} ORDER BY e.created_at DESC, ${fid} DESC LIMIT ?`).bind(...binds, take)
			.all<{ fid: string; payment_id: string; type: string; actor: string; detail: string | null; created_at: number; tenant_id: string; kind: string; amount: number; provider: string; rail: string; operator: string | null }>()
			.then(({ results }) => results.map((r) => ({
				source: 'payment' as const, id: r.fid, at: r.created_at, type: r.type, status: r.type, problem: PAYMENT_PROBLEMS.includes(r.type),
				tenant: r.tenant_id, paymentId: r.payment_id, actor: r.actor, detail: r.detail, attempts: null, body: null, kind: r.kind, amount: r.amount, provider: r.provider, rail: r.rail, operator: r.operator,
			}))));
	}
	if (want.has('callback')) {
		const fid = `printf('cb_%012d', id)`, c = older('received_at', fid);
		runs.push(env.DB.prepare(`SELECT ${fid} AS fid, provider, path, accepted, body, received_at FROM provider_events WHERE ${c.sql} ${q.problems ? 'AND accepted = 0' : ''} ORDER BY received_at DESC, ${fid} DESC LIMIT ?`).bind(...c.binds, take)
			.all<{ fid: string; provider: string; path: string; accepted: number; body: string; received_at: number }>()
			.then(({ results }) => results.map((r) => ({
				source: 'callback' as const, id: r.fid, at: r.received_at, type: r.path, status: r.accepted ? 'accepted' : 'rejected', problem: !r.accepted,
				tenant: null, paymentId: null, actor: r.provider, detail: null, attempts: null, body: r.body, provider: r.provider,
			}))));
	}
	if (want.has('webhook')) {
		const c = older('created_at', 'id');
		const where = [c.sql], binds: unknown[] = [...c.binds];
		if (q.tenant) { where.push('tenant_id = ?'); binds.push(q.tenant); }
		if (q.payment) { where.push('payment_id = ?'); binds.push(q.payment); }
		if (q.problems) where.push(`status = 'dead'`);
		runs.push(env.DB.prepare(`SELECT id, tenant_id, payment_id, type, payload, status, attempts, last_status, last_error, created_at FROM webhook_deliveries WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`).bind(...binds, take)
			.all<{ id: string; tenant_id: string; payment_id: string; type: string; payload: string; status: string; attempts: number; last_status: number | null; last_error: string | null; created_at: number }>()
			.then(({ results }) => results.map((r) => ({
				source: 'webhook' as const, id: r.id, at: r.created_at, type: r.type, status: r.status, problem: r.status === 'dead',
				tenant: r.tenant_id, paymentId: r.payment_id || null, actor: null, detail: r.last_error ?? (r.last_status ? `HTTP ${r.last_status}` : null), attempts: r.attempts, body: r.payload || null, // emptied after KEEP_PAYLOAD_DAYS (retention.ts)
			}))));
	}

	// the same order as the queries: time, then the feed id compared as SQLite compares text (byte order, which is code-unit order for these ASCII ids)
	const all = (await Promise.all(runs)).flat().sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
	const data = all.slice(0, limit);
	return { data, next: all.length > limit ? `${data.at(-1)!.at}:${data.at(-1)!.id}` : null };
}

/** How many things need a person right now, for the console's badges and the overview. */
export async function attention(env: Env, now = Date.now()) {
	const r = await env.DB.prepare(`SELECT
		(SELECT COUNT(*) FROM payments WHERE status = 'unknown') AS unknown,
		(SELECT COUNT(*) FROM webhook_deliveries WHERE status = 'dead') AS dead,
		(SELECT COUNT(*) FROM provider_events WHERE accepted = 0 AND received_at >= ?) AS rejected`).bind(now - 86_400_000).first<{ unknown: number; dead: number; rejected: number }>();
	return { unknown: r?.unknown ?? 0, deadWebhooks: r?.dead ?? 0, rejectedCallbacks24h: r?.rejected ?? 0, database: { bytes: await databaseBytes(env), limit: DB_LIMIT_BYTES } };
}
