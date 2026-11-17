import { ApiError } from './errors.ts';
import type { Kind } from './ids.ts';
import type { Rail } from './providers/types.ts';

/**
 * The wallets registry (migration 0005): every real account money sits in, named `<country>:<rail>` (CIV:PAWAPAY, CIV:PISPI), and which products
 * may collect or pay out through it. A payment records its wallet; a product can only use the wallets enabled for it, and an `off` wallet takes no
 * new payment (those already on their way still settle). The books keep their pool names for now (PRO-37 moves them onto wallet ids).
 */
export interface Wallet { id: string; rail: 'PAWAPAY' | 'PISPI'; country: string; currency: string; label: string | null; status: 'active' | 'off'; secrets_prefix: string | null; created_at: number }

const COUNTRIES = ['CIV', 'SEN', 'BFA'] as const;
const ISO3: Record<string, string> = { CI: 'CIV', SN: 'SEN', BF: 'BFA' };
/** The country of the one PI-SPI account, as PISPI_COUNTRY says it (ISO 3166 alpha-2, default BF), in the registry's alpha-3. */
export const pispiCountry = (env: Pick<Env, 'PISPI_COUNTRY'>) => ISO3[(env.PISPI_COUNTRY || 'BF').toUpperCase()] ?? (env.PISPI_COUNTRY || 'BF').toUpperCase();
const WALLET_ID = /^(CIV|SEN|BFA):(PAWAPAY|PISPI)$/;

/** The wallet a payment goes through: pawaPay in the phone's country, or the PI-SPI account. */
export function walletFor(env: Pick<Env, 'PISPI_COUNTRY'>, rail: Rail, country: string | null): string {
	return rail === 'mobile_money' ? `${country}:PAWAPAY` : `${pispiCountry(env)}:PISPI`;
}

/** Why this product cannot use this wallet in this direction, or null when it can. */
export async function walletRefusal(env: Env, tenantId: string, walletId: string, kind: Kind): Promise<string | null> {
	const r = await env.DB.prepare(`SELECT w.status, tw.collect, tw.payout FROM wallets w LEFT JOIN tenant_wallets tw ON tw.wallet_id = w.id AND tw.tenant_id = ? WHERE w.id = ?`)
		.bind(tenantId, walletId).first<{ status: string; collect: number | null; payout: number | null }>();
	if (!r) return `There is no ${walletId} wallet`;
	if (r.status !== 'active') return `The ${walletId} wallet is switched off`;
	const allowed = kind === 'collection' ? r.collect : r.payout;
	return allowed ? null : `This account cannot ${kind === 'collection' ? 'collect' : 'pay out'} through the ${walletId} wallet. Ask the operator to enable it.`;
}

/** Refuses the payment before anything is recorded or sent when the product may not use the wallet. */
export async function requireWallet(env: Env, tenantId: string, walletId: string, kind: Kind): Promise<void> {
	const why = await walletRefusal(env, tenantId, walletId, kind);
	if (why) throw new ApiError(422, 'wallet_not_enabled', why, { wallet: walletId });
}

export const listWallets = async (env: Env) => (await env.DB.prepare(`SELECT * FROM wallets ORDER BY rail, country`).all<Wallet>()).results;

/** The wallets a product may use, with both directions; for /v1/me and the tenant drawer. */
export async function tenantWallets(env: Env, tenantId: string): Promise<{ id: string; rail: string; country: string; label: string | null; status: string; collect: boolean; payout: boolean }[]> {
	const { results } = await env.DB.prepare(`SELECT w.id, w.rail, w.country, w.label, w.status, COALESCE(tw.collect, 0) AS collect, COALESCE(tw.payout, 0) AS payout
		FROM wallets w LEFT JOIN tenant_wallets tw ON tw.wallet_id = w.id AND tw.tenant_id = ? ORDER BY w.rail, w.country`).bind(tenantId)
		.all<{ id: string; rail: string; country: string; label: string | null; status: string; collect: number; payout: number }>();
	return results.map((w) => ({ ...w, collect: !!w.collect, payout: !!w.payout }));
}

/** A new product starts with every active wallet, both directions (what every product could do before the registry); the operator narrows it. */
export const enableAllWallets = (env: Env, tenantId: string, now: number) =>
	env.DB.prepare(`INSERT OR IGNORE INTO tenant_wallets (tenant_id, wallet_id, collect, payout, created_at) SELECT ?, id, 1, 1, ? FROM wallets WHERE status = 'active'`).bind(tenantId, now).run();

/** Turns a wallet on or off for a product, per direction. Both off removes the row. */
export async function setTenantWallet(env: Env, tenantId: string, walletId: string, body: Record<string, unknown>, now = Date.now()) {
	if (typeof body.collect !== 'boolean' || typeof body.payout !== 'boolean') throw new ApiError(400, 'invalid_request', 'collect and payout are required, true or false');
	if (!(await env.DB.prepare(`SELECT 1 AS x FROM wallets WHERE id = ?`).bind(walletId).first())) throw new ApiError(404, 'not_found', 'No such wallet');
	if (!(await env.DB.prepare(`SELECT 1 AS x FROM tenants WHERE id = ?`).bind(tenantId).first())) throw new ApiError(404, 'not_found', 'No such tenant');
	if (!body.collect && !body.payout) await env.DB.prepare(`DELETE FROM tenant_wallets WHERE tenant_id = ? AND wallet_id = ?`).bind(tenantId, walletId).run();
	else await env.DB.prepare(`INSERT INTO tenant_wallets (tenant_id, wallet_id, collect, payout, created_at) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (tenant_id, wallet_id) DO UPDATE SET collect = excluded.collect, payout = excluded.payout`).bind(tenantId, walletId, body.collect ? 1 : 0, body.payout ? 1 : 0, now).run();
	return tenantWallets(env, tenantId);
}

/** Registers a wallet (a new country, or a second PI-SPI account). It starts enabled for no product. */
export async function createWallet(env: Env, body: Record<string, unknown>, now = Date.now()): Promise<Wallet> {
	const id = typeof body.id === 'string' ? body.id.toUpperCase() : '';
	if (!WALLET_ID.test(id)) throw new ApiError(400, 'invalid_wallet', `id is <country>:<rail>: a country of ${COUNTRIES.join(', ')} and a rail of PAWAPAY or PISPI, e.g. SEN:PISPI`);
	const label = body.label === undefined || body.label === null ? null : typeof body.label === 'string' && body.label.trim().length <= 80 ? body.label.trim() : null;
	const prefix = body.secretsPrefix === undefined || body.secretsPrefix === null ? null : String(body.secretsPrefix);
	if (prefix !== null && !/^[A-Z][A-Z0-9_]{1,40}$/.test(prefix)) throw new ApiError(400, 'invalid_wallet', 'secretsPrefix names secrets: upper case letters, digits and underscores, e.g. PI_SPI_SEN');
	const [country, rail] = id.split(':') as [string, Wallet['rail']];
	const r = await env.DB.prepare(`INSERT OR IGNORE INTO wallets (id, rail, country, label, secrets_prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(id, rail, country, label, prefix, now).run();
	if (!r.meta.changes) throw new ApiError(409, 'wallet_exists', 'This wallet is already registered');
	return (await env.DB.prepare(`SELECT * FROM wallets WHERE id = ?`).bind(id).first<Wallet>())!;
}

/** Switches a wallet on or off for everyone, or renames it. */
export async function updateWallet(env: Env, id: string, body: Record<string, unknown>): Promise<Wallet> {
	const sets: string[] = [], binds: unknown[] = [];
	if (body.status !== undefined) {
		if (body.status !== 'active' && body.status !== 'off') throw new ApiError(400, 'invalid_status', 'status is active or off');
		sets.push('status = ?'); binds.push(body.status);
	}
	if (body.label !== undefined) {
		if (body.label !== null && (typeof body.label !== 'string' || body.label.trim().length > 80)) throw new ApiError(400, 'invalid_wallet', 'label is at most 80 characters');
		sets.push('label = ?'); binds.push(body.label === null ? null : (body.label as string).trim() || null);
	}
	if (!sets.length) throw new ApiError(400, 'invalid_request', 'Nothing to change: status or label');
	const r = await env.DB.prepare(`UPDATE wallets SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, id).run();
	if (!r.meta.changes) throw new ApiError(404, 'not_found', 'No such wallet');
	return (await env.DB.prepare(`SELECT * FROM wallets WHERE id = ?`).bind(id).first<Wallet>())!;
}
