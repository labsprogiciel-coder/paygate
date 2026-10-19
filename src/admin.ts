import { clerkEnabled, clerkOperator } from './auth.ts';
import { ApiError } from './errors.ts';
import { createApiKey, createTenant, getTenant, revokeApiKey, rotateWebhookSecret, updateTenant, webhookSecret, type TenantInput } from './tenants.ts';
import { getRow, view, type PaymentRow } from './payments.ts';
import { listDead, retryDelivery } from './webhooks.ts';
import { resolvePayment } from './reconcile.ts';
import { loadFloat } from './float.ts';
import { attention, eventFeed, SOURCES, type Source } from './events.ts';
import { adjustPool, backfillLedger, booksReport } from './ledger.ts';
import type { Providers } from './providers/types.ts';
import { safeEqual, on } from './util.ts';
import { pispiAlias, pispiEnabled, pispiPollEnabled, pispiRtpEnabled } from './providers/pispi.ts';

/**
 * The operator API: tenants, their keys and webhook secrets, payments that need a person, undeliverable events. Never reachable with a tenant key.
 * Two ways in, both `Authorization: Bearer ...`: a Clerk session token from the console (an operator in CLERK_OPERATOR_IDS; recorded as their
 * Clerk user id), or the shared ADMIN_API_KEY for scripts (recorded as `operator`). Returns who it is, for the payment history.
 */
export async function requireAdmin(env: Env, request: Request): Promise<string> {
	const key = env.ADMIN_API_KEY && env.ADMIN_API_KEY.length >= 24 ? env.ADMIN_API_KEY : null;
	const clerk = clerkEnabled(env);
	if (!key && !clerk) throw new ApiError(503, 'admin_disabled', 'Set ADMIN_API_KEY (24 characters at least) or configure Clerk');
	const m = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '');
	if (!m) throw new ApiError(401, 'unauthorized', 'A valid admin key or operator session is required');
	if (key && safeEqual(m[1]!, key)) return 'operator';
	if (clerk && m[1]!.split('.').length === 3) return clerkOperator(env, request, m[1]!);
	throw new ApiError(401, 'unauthorized', 'A valid admin key or operator session is required');
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const body = async (request: Request): Promise<Record<string, unknown>> => {
	try { const v = await request.json(); if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>; } catch { /* below */ }
	throw new ApiError(400, 'invalid_request', 'A JSON object is required');
};

/** What the operator sees of a payment: the tenant's view plus the detail a tenant never gets. */
const adminView = (env: Env, r: PaymentRow) => ({ ...view(env, r), tenant: r.tenant_id, provider: r.provider, country: r.country, providerId: r.provider_id, providerRef: r.provider_ref, failureDetail: r.failure_detail, attempts: r.attempts, version: r.version });

export async function adminApi(env: Env, request: Request, path: string, providers: Providers): Promise<Response | null> {
	const admin = await requireAdmin(env, request);
	const url = new URL(request.url);
	const m = request.method;
	let g: RegExpExecArray | null;

	if (path === '/admin/tenants' && m === 'POST') return json(await createTenant(env, (await body(request)) as unknown as TenantInput), 201);
	if (path === '/admin/tenants' && m === 'GET') return json({ data: (await env.DB.prepare(`SELECT * FROM tenants ORDER BY created_at`).all()).results });
	if ((g = /^\/admin\/tenants\/([a-z0-9-]+)$/.exec(path))) {
		if (m === 'GET') { const t = await getTenant(env, g[1]!); if (!t) throw new ApiError(404, 'not_found', 'No such tenant'); return json(t); }
		if (m === 'PATCH') return json(await updateTenant(env, g[1]!, await body(request)));
	}
	if ((g = /^\/admin\/tenants\/([a-z0-9-]+)\/keys$/.exec(path))) {
		if (m === 'POST') { const b: Record<string, unknown> = await body(request).catch(() => ({})); return json(await createApiKey(env, g[1]!, typeof b.label === 'string' ? b.label : null), 201); } // the key is shown once
		if (m === 'GET') return json({ data: (await env.DB.prepare(`SELECT id, label, created_at, last_used_at, revoked_at FROM api_keys WHERE tenant_id = ? ORDER BY created_at`).bind(g[1]!).all()).results });
	}
	if ((g = /^\/admin\/tenants\/([a-z0-9-]+)\/keys\/([0-9a-f]{12})$/.exec(path)) && m === 'DELETE') {
		if (!(await revokeApiKey(env, g[1]!, g[2]!))) throw new ApiError(404, 'not_found', 'No such active key');
		return json({ revoked: true });
	}
	if ((g = /^\/admin\/tenants\/([a-z0-9-]+)\/webhook-secret$/.exec(path))) {
		const t = await getTenant(env, g[1]!);
		if (!t) throw new ApiError(404, 'not_found', 'No such tenant');
		if (m === 'GET') return json({ secret: await webhookSecret(env, t), version: t.webhook_version });
		if (m === 'POST') return json(await rotateWebhookSecret(env, t.id)); // rotate
	}
	if (path === '/admin/ledger' && m === 'GET') return json(await booksReport(env, providers));
	if (path === '/admin/ledger/backfill' && m === 'POST') return json(await backfillLedger(env));
	if (path === '/admin/ledger/adjustments' && m === 'POST') {
		const b = await body(request);
		if (typeof b.pool !== 'string' || !/^(CIV|SEN|BFA|PISPI)$/.test(b.pool)) throw new ApiError(400, 'invalid_pool', 'pool is CIV, SEN, BFA or PISPI');
		if (typeof b.amount !== 'number' || !Number.isInteger(b.amount) || b.amount === 0 || Math.abs(b.amount) > 1_000_000_000) throw new ApiError(400, 'invalid_amount', 'amount is a whole number of XOF, positive for float put in, negative for fees or losses taken out');
		if (typeof b.note !== 'string' || !b.note.trim()) throw new ApiError(400, 'invalid_note', 'note is required: say what the money is');
		return json(await adjustPool(env, b.pool, b.amount, b.note.trim(), admin), 201);
	}
	if (path === '/admin/payments/stats' && m === 'GET') {
		// the payments page's headline numbers, for the same tenant and direction filters (not status: these ARE the breakdown by status).
		// Settled figures cover the last 24 hours; what is still open (processing, unknown) counts whatever its age, since it all still needs to end.
		const where: string[] = [], binds: unknown[] = [];
		for (const [param, col] of [['tenant', 'tenant_id'], ['kind', 'kind']] as const) { const v = url.searchParams.get(param); if (v) { where.push(`${col} = ?`); binds.push(v); } }
		const since = Date.now() - 86_400_000;
		const r = await env.DB.prepare(`SELECT
			COUNT(CASE WHEN status = 'completed' AND created_at >= ?1 THEN 1 END) AS completed_n,
			COALESCE(SUM(CASE WHEN status = 'completed' AND created_at >= ?1 THEN amount END), 0) AS completed_amount,
			COUNT(CASE WHEN status IN ('completed', 'failed', 'expired') AND created_at >= ?1 THEN 1 END) AS settled_n,
			COUNT(CASE WHEN status = 'processing' THEN 1 END) AS processing_n,
			COALESCE(SUM(CASE WHEN status = 'processing' THEN amount END), 0) AS processing_amount,
			COUNT(CASE WHEN status = 'unknown' THEN 1 END) AS unknown_n,
			COALESCE(SUM(CASE WHEN status = 'unknown' THEN amount END), 0) AS unknown_amount
			FROM payments ${where.length ? 'WHERE ' + where.map((w, i) => w.replace('?', `?${i + 2}`)).join(' AND ') : ''}`).bind(since, ...binds)
			.first<Record<string, number>>();
		const n = (k: string) => Number(r?.[k] ?? 0);
		return json({
			since,
			completed: { n: n('completed_n'), amount: n('completed_amount') },
			settled: n('settled_n'),
			successRate: n('settled_n') ? Math.round((n('completed_n') / n('settled_n')) * 100) : null,
			processing: { n: n('processing_n'), amount: n('processing_amount') },
			unknown: { n: n('unknown_n'), amount: n('unknown_amount') },
		});
	}
	if (path === '/admin/payments' && m === 'GET') {
		// newest first, a page at a time: `before` is the last row's `<createdAt>:<id>` (the response's `next`), so rows sharing a timestamp are never skipped
		const where: string[] = [], binds: unknown[] = [];
		for (const [param, col] of [['status', 'status'], ['tenant', 'tenant_id'], ['kind', 'kind']] as const) { const v = url.searchParams.get(param); if (v) { where.push(`${col} = ?`); binds.push(v); } }
		const filter = where.length ? 'WHERE ' + where.join(' AND ') : '', filterBinds = [...binds];
		const limit = Math.min(Math.max(Math.floor(Number(url.searchParams.get('limit')) || 50), 1), 100);
		const c = /^(\d{1,16}):(pg[0-9a-f]{18})$/.exec(url.searchParams.get('before') ?? '');
		if (c) { where.push('(created_at < ? OR (created_at = ? AND id < ?))'); binds.push(Number(c[1]), Number(c[1]), c[2]); }
		const [{ results }, total] = await Promise.all([
			env.DB.prepare(`SELECT * FROM payments ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, id DESC LIMIT ?`).bind(...binds, limit + 1).all<PaymentRow>(),
			env.DB.prepare(`SELECT COUNT(*) AS n FROM payments ${filter}`).bind(...filterBinds).first<number>('n'),
		]);
		const page = results.slice(0, limit), last = page.at(-1);
		return json({ data: page.map((r) => adminView(env, r)), total: total ?? 0, next: results.length > limit && last ? `${last.created_at}:${last.id}` : null });
	}
	if ((g = /^\/admin\/payments\/(pg[0-9a-f]{18})$/.exec(path)) && m === 'GET') {
		const r = await getRow(env, g[1]!);
		if (!r) throw new ApiError(404, 'not_found', 'No such payment');
		const events = (await env.DB.prepare(`SELECT type, actor, detail, created_at FROM payment_events WHERE payment_id = ? ORDER BY id`).bind(r.id).all()).results;
		return json({ ...adminView(env, r), events });
	}
	if ((g = /^\/admin\/payments\/(pg[0-9a-f]{18})\/resolve$/.exec(path)) && m === 'POST') {
		const b = await body(request);
		if ((b.outcome !== 'completed' && b.outcome !== 'failed') || typeof b.note !== 'string' || !b.note.trim()) throw new ApiError(400, 'invalid_request', 'outcome (completed|failed) and note are required');
		const r = await resolvePayment(env, g[1]!, b.outcome, b.note.trim().slice(0, 300), admin);
		if (!r) throw new ApiError(409, 'not_resolvable', 'The payment does not exist or its status cannot move to that outcome');
		return json(adminView(env, r));
	}
	if (path === '/admin/webhooks/dead' && m === 'GET') return json({ data: await listDead(env) });
	if ((g = /^\/admin\/webhooks\/([A-Za-z0-9_]+)\/retry$/.exec(path)) && m === 'POST') {
		if (!(await retryDelivery(env, g[1]!))) throw new ApiError(404, 'not_found', 'No such undelivered event');
		return json({ queued: true });
	}
	if (path === '/admin/float' && m === 'GET') return json(await loadFloat(env, providers));
	if (path === '/admin/providers' && m === 'GET') {
		// every PSP with its channels (what each operator can do on the account now) and the accounts money is paid from; plus the last 24 hours
		const since = Date.now() - 86_400_000;
		const [{ results }, channels, float] = await Promise.all([
			env.DB.prepare(`SELECT provider, rail, kind, status, COUNT(*) AS n, SUM(amount) AS amount FROM payments WHERE created_at >= ? GROUP BY provider, rail, kind, status`).bind(since).all(),
			providers.channels().then((data) => ({ data, error: null }), (e: unknown) => ({ data: null, error: e instanceof Error ? e.message : String(e) })),
			loadFloat(env, providers).then((f) => ({ f, error: null }), (e: unknown) => ({ f: null, error: e instanceof Error ? e.message : String(e) })),
		]);
		const sandbox = providers.mode === 'sandbox';
		const iso3 = ({ BF: 'BFA', CI: 'CIV', SN: 'SEN' } as Record<string, string>)[env.PISPI_COUNTRY || 'BF'] ?? (env.PISPI_COUNTRY || 'BF');
		const alias = pispiAlias(env), pispiOn = pispiEnabled(env);
		const rail = (open: boolean) => ({ status: open ? 'OPERATIONAL' : 'CLOSED', min: null, max: null });
		const list = [
			{ id: sandbox ? 'sandbox' : 'pawapay', name: sandbox ? 'Sandbox (simulated)' : 'pawaPay', role: 'Mobile money (MNO aggregator)', rails: ['mobile_money'], active: true,
				environment: sandbox ? 'Simulated' : on(env.LIVE) ? 'Live' : 'Sandbox', endpoint: sandbox ? null : env.PAWAPAY_BASE_URL,
				notes: [sandbox ? 'No money moves' : env.PAWAPAY_BASE_URL, on(env.LIVE) ? 'LIVE' : 'not live'],
				channels: channels.data, channelsError: channels.error,
				// one payout wallet per country: a payout is paid from the wallet of the recipient's country
				accounts: (float.f?.rows ?? []).map((r) => ({ kind: 'wallet', label: `${r.country} payout wallet`, country: r.country, currency: r.currency, balance: r.balance, status: r.status, reasons: r.reasons,
					committed: r.committed, committedCount: r.committedCount, coverDays: r.coverDays, out24h: r.out24h, in24h: r.in24h })),
				accountsNote: sandbox ? 'The sandbox has no wallets: nothing is paid out.' : float.error ? `Wallet balances could not be read: ${float.error}` : null },
			{ id: 'pispi', name: 'PI-SPI (BCEAO)', role: 'Instant bank payments', rails: ['pispi_qr', 'pispi_rtp'], active: pispiOn,
				environment: /simulateur|sandbox/i.test(env.PI_SPI_BUSINESS_API_URL || '') ? 'Simulator' : pispiOn ? 'Live' : 'Off', endpoint: env.PI_SPI_BUSINESS_API_URL || null,
				notes: pispiOn ? [`QR ${pispiPollEnabled(env) ? 'auto-confirmed (polling)' : 'confirmed by an operator'}`, `payment requests ${pispiRtpEnabled(env) ? 'on' : 'off'}`] : [alias === null && on(env.PISPI_ENABLED) ? 'PI_SPI_ACCOUNT_ALIAS is not set' : 'disabled'],
				channels: [
					{ country: iso3, operator: 'bank', code: 'PISPI_QR', collect: rail(pispiOn), payout: null },
					{ country: iso3, operator: 'bank', code: 'PISPI_RTP', collect: rail(pispiRtpEnabled(env)), payout: null },
				], channelsError: null,
				accounts: alias ? [{ kind: 'alias', label: 'Receiving alias', country: iso3, currency: 'XOF', value: alias.length > 14 ? `${alias.slice(0, 8)}…${alias.slice(-4)}` : alias, participant: env.PI_SPI_PARTICIPANT || null }] : [],
				accountsNote: alias ? 'Customers pay into this alias; PI-SPI reports no balance and pays out nothing here.' : 'No receiving alias: set PI_SPI_ACCOUNT_ALIAS.' },
		];
		return json({ data: list, last24h: results, floor: Number(env.FLOAT_FLOOR_XOF) });
	}
	if (path === '/admin/events' && m === 'GET') {
		const sources = (url.searchParams.get('source') ?? '').split(',').filter((s): s is Source => (SOURCES as readonly string[]).includes(s));
		return json(await eventFeed(env, { sources, problems: url.searchParams.get('problems') === '1', tenant: url.searchParams.get('tenant'), payment: url.searchParams.get('payment'),
			before: url.searchParams.get('before'), limit: Number(url.searchParams.get('limit')) || 50 }));
	}
	if (path === '/admin/attention' && m === 'GET') return json(await attention(env));
	if (path === '/admin/provider-events' && m === 'GET') return json({ data: (await env.DB.prepare(`SELECT id, provider, path, accepted, body, received_at FROM provider_events ORDER BY id DESC LIMIT 100`).all()).results });
	return null;
}
