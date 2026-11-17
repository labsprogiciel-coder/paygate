import { alert } from './alerts.ts';
import { ApiError } from './errors.ts';
import { syncLedger } from './ledger.ts';
import { getRow, outbox, view, type PaymentRow, type ReturnStatus } from './payments.ts';
import { pispiReturnsEnabled, returnFunds, returnStatus, type ReturnState } from './providers/pispi.ts';
import { log } from './util.ts';

/**
 * Returns of funds: an operator sends a received PI-SPI payment back to its payer, in full (PUT /paiements/{end2endId}/retours). Products cannot
 * start one; they are told by a `payment.refunded` webhook once it is irrevocable.
 *
 *   (none | rejected) --request--> requested --PI-SPI has it--> initiated --> returned | rejected
 *
 * Every step is a conditional update from the status the caller saw, so two callers can never both send a return or both report it.
 * `requested` means PI-SPI may not have the return yet (the call failed or was not made): it is safe to send again, because PI-SPI answers
 * a repeat with the return it already has. `initiated` is only ever read (GET), never sent again, because PI-SPI re-sends a return it rejected.
 * What can be returned: a completed PI-SPI collection (its own settlement), or a payment that arrived for it but did not match it (wrong amount
 * or route), which settled nothing. Only the first moves the books: what the product held is paid back out (one `refund` posting).
 */
const CHECK_EVERY_MS = 60_000;

/** The received payment that would be sent back, or why this payment cannot be returned. */
export async function returnable(env: Env, r: PaymentRow): Promise<{ ok: true; end2endId: string } | { ok: false; reason: string }> {
	if (r.provider !== 'pispi' || r.kind !== 'collection') return { ok: false, reason: 'Only PI-SPI collections can be returned' };
	if (!pispiReturnsEnabled(env)) return { ok: false, reason: 'Returns are switched off (PISPI_RETURNS)' };
	if (r.return_status && r.return_status !== 'rejected') return { ok: false, reason: r.return_status === 'returned' ? 'Already returned' : 'A return is already on its way' };
	if (r.status === 'completed') {
		if (!r.provider_ref || r.provider_ref.startsWith('manual')) return { ok: false, reason: 'Completed by hand: no PI-SPI payment to send back' };
		return { ok: true, end2endId: r.provider_ref };
	}
	const m = await env.DB.prepare(`SELECT detail FROM payment_events WHERE payment_id = ? AND type = 'mismatch' ORDER BY id DESC LIMIT 1`).bind(r.id).first<{ detail: string }>();
	const e2e = m?.detail ? /^(\S+): /.exec(m.detail)?.[1] : undefined;
	return e2e ? { ok: true, end2endId: e2e } : { ok: false, reason: 'Nothing was received for this payment' };
}

/** An operator asks for a payment to be sent back. Returns the payment as it then stands. */
export async function requestReturn(env: Env, id: string, reason: string, adminName: string, now = Date.now()): Promise<PaymentRow> {
	const row = await getRow(env, id);
	if (!row) throw new ApiError(404, 'not_found', 'No such payment');
	const ok = await returnable(env, row);
	if (!ok.ok) throw new ApiError(409, 'not_returnable', ok.reason);
	const taken = await env.DB.prepare(`SELECT id FROM payments WHERE return_ref = ? AND id <> ?`).bind(ok.end2endId, row.id).first();
	if (taken) throw new ApiError(409, 'not_returnable', 'This PI-SPI payment is already being returned for another payment');
	const claim = await env.DB.prepare(`UPDATE payments SET return_status = 'requested', return_ref = ?, return_reason = ?, return_detail = NULL, return_requested_at = ?, return_checked_at = NULL, updated_at = ?
		WHERE id = ? AND (return_status IS NULL OR return_status = 'rejected')`).bind(ok.end2endId, reason, now, now, row.id).run();
	if (!claim.meta.changes) throw new ApiError(409, 'not_returnable', 'A return is already on its way');
	await event(env, row.id, 'return_requested', `admin:${adminName}`, `${ok.end2endId}: ${reason}`, now);
	log('payment.return_requested', { id: row.id, tenant: row.tenant_id, amount: row.amount });
	return advance(env, (await getRow(env, row.id))!, now);
}

/** Moves one return on: sends it (requested) or reads where it stands (initiated). PI-SPI unreachable changes nothing; the next check asks again. */
export async function advance(env: Env, r: PaymentRow, now = Date.now()): Promise<PaymentRow> {
	if (!r.return_ref || (r.return_status !== 'requested' && r.return_status !== 'initiated')) return r;
	await env.DB.prepare(`UPDATE payments SET return_checked_at = ? WHERE id = ?`).bind(now, r.id).run();
	let s: ReturnState;
	try { s = r.return_status === 'requested' ? await returnFunds(env, r.return_ref, now) : await returnStatus(env, r.return_ref, now); }
	catch (e) { log('payment.return_unreachable', { id: r.id, error: e instanceof Error ? e.message : String(e) }); return r; }
	if (s.state === 'unsent') return r.return_status === 'initiated' ? move(env, r, 'requested', null, now) : r; // PI-SPI lost it: send it again
	if (s.state === 'initiated') return move(env, r, 'initiated', null, now);
	return move(env, r, s.state, s.state === 'rejected' ? `PI-SPI ${s.reason}` : null, now);
}

/** One conditional step, with its history entry, the product's webhook (when returned) and the books, in that order. */
async function move(env: Env, r: PaymentRow, to: ReturnStatus, detail: string | null, now: number): Promise<PaymentRow> {
	if (r.return_status === to) return r;
	const returned = to === 'returned';
	const next: PaymentRow = { ...r, return_status: to, return_detail: detail, returned_at: returned ? now : null, updated_at: now };
	const type = to === 'returned' ? 'returned' : to === 'rejected' ? 'return_rejected' : to === 'initiated' ? 'return_initiated' : 'return_resent';
	const results = await env.DB.batch([
		env.DB.prepare(`UPDATE payments SET return_status = ?, return_detail = ?, returned_at = ?, updated_at = ? WHERE id = ? AND return_status = ?`).bind(to, detail, next.returned_at, now, r.id, r.return_status),
		// written only if the update above happened (same batch, so same transaction): a caller that lost the race records nothing
		env.DB.prepare(`INSERT INTO payment_events (payment_id, version, type, actor, detail, created_at) SELECT ?1, NULL, ?2, 'provider', ?3, ?4
			WHERE EXISTS (SELECT 1 FROM payments WHERE id = ?1 AND return_status = ?5 AND updated_at = ?4)`).bind(r.id, type, detail ?? r.return_ref, now, to),
		...(returned ? [outbox(env, r.tenant_id, `evt_${r.id}_refund`, r.id, 'payment.refunded', view(env, next), {}, now,
			{ sql: `EXISTS (SELECT 1 FROM payments WHERE id = ? AND return_status = 'returned' AND updated_at = ?)`, binds: [r.id, now] })] : []),
	]);
	if (!results[0]!.meta.changes) return (await getRow(env, r.id)) ?? r; // another check moved it first
	log('payment.return', { id: r.id, tenant: r.tenant_id, from: r.return_status, to });
	if (returned) await syncLedger(env, next, now);
	if (to === 'rejected') await alert(env, { level: 'warning', title: 'PI-SPI rejected a return of funds: the payer has not been paid back', details: { payment: r.id, tenant: r.tenant_id, amount: r.amount, endToEndId: r.return_ref, reason: detail } });
	return next;
}

/** The cron: every return still on its way, looked at once a minute at most. */
export async function reconcileReturns(env: Env, now = Date.now()): Promise<{ checked: number }> {
	if (!pispiReturnsEnabled(env)) return { checked: 0 };
	const { results } = await env.DB.prepare(`SELECT * FROM payments WHERE return_status IN ('requested', 'initiated') AND (return_checked_at IS NULL OR return_checked_at < ?) ORDER BY COALESCE(return_checked_at, 0) LIMIT 10`).bind(now - CHECK_EVERY_MS).all<PaymentRow>();
	for (const r of results) await advance(env, r, now);
	return { checked: results.length };
}

const event = (env: Env, id: string, type: string, actor: string, detail: string | null, now: number) =>
	env.DB.prepare(`INSERT INTO payment_events (payment_id, version, type, actor, detail, created_at) VALUES (?, NULL, ?, ?, ?, ?)`).bind(id, type, actor, detail, now).run();
