import { alert } from './alerts.ts';
import { log } from './util.ts';

/**
 * Keeps the database from growing without bound. What is kept forever: payments, their history (payment_events) and the journal
 * (ledger_postings), which are the financial record. Provider callbacks are already capped at the last 1000 (callbacks.ts).
 * What goes, every hour (so a busy day's backlog never outruns it):
 *  - the payload of a webhook delivered more than KEEP_PAYLOAD_DAYS ago (the row stays: id, type, status, attempts, when); the tenant has it,
 *    and the payment and its history say the same thing;
 *  - test pings delivered more than KEEP_PAYLOAD_DAYS ago, entirely.
 * Dead deliveries are never touched: a person retries them. Each run does at most rounds × batch rows (10,000) so it stays well inside
 * D1's limits; whatever is left is done the next hour (up to 240,000 a day).
 */
export const KEEP_PAYLOAD_DAYS = 30;
const DAY = 86_400_000;
/** D1's per-database maximum; the console shows the size against it, and a warning goes out at WARN_SHARE of it. */
export const DB_LIMIT_BYTES = 10 * 1024 ** 3;
const WARN_SHARE = 0.8;

export async function prune(env: Env, now = Date.now(), o: { batch?: number; rounds?: number; checkSize?: boolean } = {}): Promise<{ cleared: number; pings: number }> {
	const batch = o.batch ?? 500, rounds = o.rounds ?? 20, before = now - KEEP_PAYLOAD_DAYS * DAY;
	const out = { cleared: 0, pings: 0 };
	for (let i = 0; i < rounds; i++) {
		const [cleared, pings] = await env.DB.batch([
			env.DB.prepare(`UPDATE webhook_deliveries SET payload = '' WHERE id IN (SELECT id FROM webhook_deliveries WHERE status = 'delivered' AND delivered_at < ? AND type <> 'ping' AND payload <> '' LIMIT ?)`).bind(before, batch),
			env.DB.prepare(`DELETE FROM webhook_deliveries WHERE id IN (SELECT id FROM webhook_deliveries WHERE status = 'delivered' AND delivered_at < ? AND type = 'ping' LIMIT ?)`).bind(before, batch),
		]);
		const c = cleared?.meta.changes ?? 0, p = pings?.meta.changes ?? 0;
		out.cleared += c; out.pings += p;
		if (c < batch && p < batch) break;
	}
	const bytes = await databaseBytes(env);
	if ((o.checkSize ?? true) && bytes !== null && bytes >= DB_LIMIT_BYTES * WARN_SHARE) { // the cron asks once a day, so the alert does not repeat hourly
		await alert(env, { level: 'warning', title: 'The database is over 80% of its size limit', details: { bytes, limit: DB_LIMIT_BYTES } });
	}
	log('retention.run', { ...out, bytes });
	return out;
}

/** The database's size in bytes as D1 reports it with every query, or null where it does not (local dev, tests). */
export async function databaseBytes(env: Env): Promise<number | null> {
	const r = await env.DB.prepare(`SELECT 1`).run();
	const size = (r.meta as { size_after?: number }).size_after;
	return typeof size === 'number' ? size : null;
}
