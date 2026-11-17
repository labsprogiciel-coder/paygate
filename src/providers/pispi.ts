/**
 * PI-SPI (the BCEAO instant payment system), Business API. Collections only:
 *  - a DYNAMIC QR code for the gateway's own alias, paid from the customer's bank app, or
 *  - a payment request (RTP, category 500, no confirmation step) that the customer approves in their bank app.
 * The payment is confirmed by PI-SPI's own record of received payments (`GET /<participant>/paiements-recus`, scope paiement.read), never by the
 * customer's word. The participant code (for example BFC999) is part of the path: `/v1/...` is a different, empty namespace.
 * Reading and sending are separate switches: PISPI_POLL reads, PISPI_RTP also sends requests. Neither moves money out.
 * PISPI_RETURNS allows an operator to send a received payment back to its payer (a return of funds): the one call here that moves money out.
 * Every call is made for one account (one country): see PispiAccount.
 */
import { on } from '../util.ts';

type PispiEnv = Pick<Env, 'PISPI_ENABLED' | 'PISPI_POLL' | 'PISPI_RTP' | 'PISPI_RETURNS' | 'PISPI_COUNTRY' | 'PI_SPI_PARTICIPANT' | 'PI_SPI_BUSINESS_API_URL' | 'PI_SP_API_OAUTH_URL' | 'PI_SP_API_CLIENT_ID' | 'PI_SP_API_CLIENT_SECRET' | 'PI_SPI_API_KEY' | 'PI_SPI_ACCOUNT_ALIAS'>;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** What the QR format and the payer's bank allow as the payment reference. */
export const PISPI_REF_MAX = 25;
/** The payer alias a payment request is addressed to: a UUID. */
export const PAYER_ALIAS = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ISO2: Record<string, string> = { CIV: 'CI', SEN: 'SN', BFA: 'BF' };
const ISO3: Record<string, string> = { CI: 'CIV', SN: 'SEN', BF: 'BFA' };
/** The country of the first PI-SPI account, as PISPI_COUNTRY says it (ISO 3166 alpha-2, default BF), in the registry's alpha-3. */
export const pispiCountry = (env: Pick<Env, 'PISPI_COUNTRY'>) => ISO3[(env.PISPI_COUNTRY || 'BF').toUpperCase()] ?? (env.PISPI_COUNTRY || 'BF').toUpperCase();

/**
 * One PI-SPI account: a wallet of the registry (`<country>:PISPI`), with its own alias, participant and credentials. A PI-SPI account collects in
 * one country only, so each country is its own account. Its secrets are named by the wallet's `secrets_prefix`: PI_SPI_SEN gives
 * PI_SPI_SEN_ACCOUNT_ALIAS, PI_SPI_SEN_PARTICIPANT, PI_SPI_SEN_API_KEY, PI_SPI_SEN_CLIENT_ID and PI_SPI_SEN_CLIENT_SECRET (and optionally its own
 * PI_SPI_SEN_BUSINESS_API_URL and PI_SPI_SEN_OAUTH_URL; otherwise the shared ones). The first account, the wallet of PISPI_COUNTRY with no prefix,
 * keeps the original names (PI_SPI_ACCOUNT_ALIAS, PI_SPI_PARTICIPANT, PI_SPI_API_KEY, PI_SP_API_CLIENT_ID, PI_SP_API_CLIENT_SECRET).
 * The switches (PISPI_ENABLED, PISPI_POLL, PISPI_RTP, PISPI_RETURNS) apply to every account.
 */
export interface PispiAccount {
	wallet: string; countryCode: string; prefix: string | null;
	alias: string | null; participant: string; apiKey: string; clientId: string; clientSecret: string; apiUrl: string; oauthUrl: string;
}

export function pispiAccount(env: PispiEnv, wallet: { id: string; secrets_prefix: string | null }): PispiAccount {
	const country = wallet.id.split(':')[0]!;
	const read = (name: string) => { const v = (env as unknown as Record<string, unknown>)[name]; return typeof v === 'string' ? v.trim() : ''; };
	const legacy = !wallet.secrets_prefix && wallet.id === `${pispiCountry(env)}:PISPI`;
	const P = wallet.secrets_prefix;
	const get = (own: string, original: keyof PispiEnv) => P ? read(`${P}_${own}`) : legacy ? read(original) : '';
	const alias = get('ACCOUNT_ALIAS', 'PI_SPI_ACCOUNT_ALIAS');
	return {
		wallet: wallet.id, countryCode: ISO2[country] ?? country, prefix: P,
		alias: alias && UUID_V4.test(alias) ? alias.toLowerCase() : null,
		participant: get('PARTICIPANT', 'PI_SPI_PARTICIPANT'), apiKey: get('API_KEY', 'PI_SPI_API_KEY'),
		clientId: get('CLIENT_ID', 'PI_SP_API_CLIENT_ID'), clientSecret: get('CLIENT_SECRET', 'PI_SP_API_CLIENT_SECRET'),
		apiUrl: (P && read(`${P}_BUSINESS_API_URL`)) || read('PI_SPI_BUSINESS_API_URL'),
		oauthUrl: (P && read(`${P}_OAUTH_URL`)) || read('PI_SP_API_OAUTH_URL'),
	};
}
/** The secrets an account still lacks, by name (never their values): what the console shows an operator. */
export function missingSecrets(a: PispiAccount): string[] {
	const n = (own: string, original: string) => a.prefix ? `${a.prefix}_${own}` : original;
	return [
		!a.alias && n('ACCOUNT_ALIAS', 'PI_SPI_ACCOUNT_ALIAS'), !a.participant && n('PARTICIPANT', 'PI_SPI_PARTICIPANT'), !a.apiKey && n('API_KEY', 'PI_SPI_API_KEY'),
		!a.clientId && n('CLIENT_ID', 'PI_SP_API_CLIENT_ID'), !a.clientSecret && n('CLIENT_SECRET', 'PI_SP_API_CLIENT_SECRET'),
		!a.apiUrl && 'PI_SPI_BUSINESS_API_URL', !a.oauthUrl && 'PI_SP_API_OAUTH_URL',
	].filter((x): x is string => !!x);
}

/** The PI-SPI account of a wallet id, from the registry. A payment from before the registry belongs to the first account. */
export async function loadPispiAccount(env: Env, walletId: string | null): Promise<PispiAccount> {
	const id = walletId ?? `${pispiCountry(env)}:PISPI`;
	const w = await env.DB.prepare(`SELECT id, secrets_prefix FROM wallets WHERE id = ?`).bind(id).first<{ id: string; secrets_prefix: string | null }>();
	return pispiAccount(env, w ?? { id, secrets_prefix: null });
}
/** Every PI-SPI account of the registry, switched on or off. */
export async function pispiAccounts(env: Env): Promise<(PispiAccount & { status: string; label: string | null })[]> {
	const { results } = await env.DB.prepare(`SELECT id, secrets_prefix, status, label FROM wallets WHERE rail = 'PISPI' ORDER BY country`).all<{ id: string; secrets_prefix: string | null; status: string; label: string | null }>();
	return results.map((w) => ({ ...pispiAccount(env, w), status: w.status, label: w.label }));
}

export const pispiEnabled = (env: PispiEnv, a: PispiAccount): boolean => on(env.PISPI_ENABLED) && a.alias !== null;
export const pispiPollEnabled = (env: PispiEnv, a: PispiAccount): boolean =>
	pispiEnabled(env, a) && on(env.PISPI_POLL) && !!(a.participant && a.apiUrl && a.oauthUrl && a.clientId && a.clientSecret && a.apiKey);
export const pispiRtpEnabled = (env: PispiEnv, a: PispiAccount): boolean => pispiPollEnabled(env, a) && on(env.PISPI_RTP);
export const pispiReturnsEnabled = (env: PispiEnv, a: PispiAccount): boolean => pispiPollEnabled(env, a) && on(env.PISPI_RETURNS);

/** The reference the payer's bank shows with the payment, and the txId we match on: our payment id, upper case. */
export const pispiTxId = (paymentId: string) => paymentId.toUpperCase();

export interface PispiQr { alias: string; countryCode: string; qrType: 'DYNAMIC'; referenceLabel: string; amount: number }

export function pispiQr(a: Pick<PispiAccount, 'alias' | 'countryCode'>, p: { id: string; amount: number }): PispiQr | null {
	if (!a.alias) return null;
	return { alias: a.alias, countryCode: a.countryCode, qrType: 'DYNAMIC', referenceLabel: pispiTxId(p.id), amount: p.amount };
}

// an access token lasts 24 hours: kept for 23, per account and scope, per isolate (it is not request data). Accounts never share one.
const tokens = new Map<string, { token: string; until: number }>();
const tokenKey = (a: PispiAccount, scope: string) => `${a.wallet}|${a.clientId}|${scope}`;
async function accessToken(a: PispiAccount, scope: string, now: number): Promise<string> {
	const hit = tokens.get(tokenKey(a, scope));
	if (hit && hit.until > now) return hit.token;
	const res = await fetch(a.oauthUrl, {
		method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ grant_type: 'client_credentials', client_id: a.clientId, client_secret: a.clientSecret, scope }).toString(),
	});
	const j = (await res.json().catch(() => ({}))) as { access_token?: string };
	if (!res.ok || !j.access_token) throw new Error(`PI-SPI token (${a.wallet}): ${res.status}`);
	tokens.set(tokenKey(a, scope), { token: j.access_token, until: now + 23 * 3_600_000 });
	return j.access_token;
}
/** A token revoked early: this account's are dropped, never another's. */
const dropTokens = (a: PispiAccount) => { for (const k of tokens.keys()) if (k.startsWith(`${a.wallet}|`)) tokens.delete(k); };
export const clearPispiTokens = () => tokens.clear();
const base = (a: PispiAccount) => `${a.apiUrl}/${encodeURIComponent(a.participant)}`;

/** PI-SPI's own explanation of an error (its `detail`, else `title`), short, for the logs: a bare status says nothing about what to fix. */
async function reason(res: Response): Promise<string> {
	const j = (await res.json().catch(() => ({}))) as { detail?: unknown; title?: unknown; 'invalid-params'?: { name?: string; reason?: string }[] };
	const text = typeof j.detail === 'string' ? j.detail : typeof j.title === 'string' ? j.title : '';
	const params = Array.isArray(j['invalid-params']) ? j['invalid-params'].map((x) => `${x.name ?? '?'}: ${x.reason ?? '?'}`).join('; ') : '';
	return [text, params].filter(Boolean).join(' | ').slice(0, 300);
}

export interface ReceivedPayment { txId: string; payeurAlias?: string; payeAlias: string; montant: number; categorie: string; statut: string; end2endId: string; dateIrrevocabilite?: string }

/** The received payments carrying this txId. Throws when PI-SPI cannot be reached or answers an error. */
export async function receivedPaymentsFor(a: PispiAccount, txId: string, now = Date.now()): Promise<ReceivedPayment[]> {
	const url = `${base(a)}/paiements-recus?txId=${encodeURIComponent(txId)}`;
	const call = async (token: string) => fetch(url, { headers: { authorization: `Bearer ${token}`, 'x-api-key': a.apiKey } });
	let res = await call(await accessToken(a, 'piz/paiement.read', now));
	if (res.status === 401) { dropTokens(a); res = await call(await accessToken(a, 'piz/paiement.read', now)); } // a token revoked early
	if (!res.ok) throw new Error(`PI-SPI paiements-recus: ${res.status} ${await reason(res)}`.trim());
	const j = (await res.json()) as { data?: ReceivedPayment[] };
	return Array.isArray(j.data) ? j.data : [];
}

export type RequestResult = { state: 'sent'; end2endId: string | null } | { state: 'rejected'; reason: string };

/**
 * Sends the customer a payment request. The payment id is the txId. A duplicate txId (DU03) means an earlier try already got through, so it counts
 * as sent. Throws when PI-SPI cannot be reached or answers an error that is ours to fix (credentials, the payee alias): the caller must not tell
 * the customer it was rejected.
 */
export async function sendPaymentRequest(a: PispiAccount, input: { txId: string; payerAlias: string; amount: number; label: string }, now = Date.now()): Promise<RequestResult> {
	const url = `${base(a)}/demandes-paiements`;
	const body = JSON.stringify({ txId: input.txId, confirmation: false, categorie: '500', payeurAlias: input.payerAlias, payeAlias: a.alias, montant: input.amount, motif: input.label });
	const call = async () => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${await accessToken(a, 'piz/demande_paiement.write', now)}`, 'x-api-key': a.apiKey, 'content-type': 'application/json' }, body });
	let res = await call();
	if (res.status === 401) { dropTokens(a); res = await call(); }
	if (!res.ok) throw new Error(`PI-SPI demandes-paiements: ${res.status} ${await reason(res)}`.trim());
	const j = (await res.json().catch(() => ({}))) as { statut?: string; statutRaison?: string; end2endId?: string };
	if (j.statut === 'REJETE') return j.statutRaison === 'DU03' ? { state: 'sent', end2endId: null } : { state: 'rejected', reason: j.statutRaison ?? 'REJETE' };
	if (j.statut === 'ENVOYE' || j.statut === 'INITIE' || j.statut === 'CONFIRME' || j.statut === 'IRREVOCABLE') return { state: 'sent', end2endId: j.end2endId ?? null };
	throw new Error(`PI-SPI demandes-paiements: unexpected status ${String(j.statut)}`);
}

export type Verdict = { kind: 'none' } | { kind: 'pending' } | { kind: 'paid'; end2endId: string } | { kind: 'mismatch'; reason: string; end2endId: string };

/**
 * What the received payments say about a payment. Paid only when one of them is irrevocable, on our alias, from a dynamic QR (400) or a payment
 * request (500), for exactly the payment's amount (and, for a payment request, from the payer it was sent to). Money that arrived for a different
 * amount or by another route is a mismatch for a person, never a settlement.
 */
export function judge(alias: string | null, p: { id: string; amount: number; rtp: boolean; payerAlias: string }, payments: ReceivedPayment[]): Verdict {
	const category = p.rtp ? '500' : '400';
	const mine = payments.filter((x) => x.txId?.toLowerCase() === p.id.toLowerCase() && x.payeAlias?.toLowerCase() === alias && (!p.rtp || !p.payerAlias || x.payeurAlias?.toLowerCase() === p.payerAlias.toLowerCase()));
	if (!mine.length) return { kind: 'none' };
	const final = mine.filter((x) => x.statut === 'IRREVOCABLE');
	if (!final.length) return mine.some((x) => x.statut === 'REJETE') && !mine.some((x) => x.statut === 'ENVOYE' || x.statut === 'CONFIRME') ? { kind: 'none' } : { kind: 'pending' };
	const exact = final.find((x) => x.categorie === category && x.montant === p.amount);
	if (exact) return { kind: 'paid', end2endId: exact.end2endId };
	const odd = final[0]!;
	return { kind: 'mismatch', end2endId: odd.end2endId, reason: odd.categorie !== category ? `category ${odd.categorie}, expected ${category}` : `${odd.montant} XOF received, ${p.amount} expected` };
}

/** Where a return of funds stands at PI-SPI: `unsent` when PI-SPI has no return for the payment (yet). */
export type ReturnState = { state: 'returned' } | { state: 'initiated' } | { state: 'rejected'; reason: string } | { state: 'unsent' };
const returnState = (j: { retourStatut?: string; retourStatutRaison?: string }): ReturnState =>
	j.retourStatut === 'IRREVOCABLE' ? { state: 'returned' } : j.retourStatut === 'REJETE' ? { state: 'rejected', reason: j.retourStatutRaison ?? 'REJETE' }
		: j.retourStatut ? { state: 'initiated' } : { state: 'unsent' };

/**
 * Sends a received payment back to its payer, in full (PI-SPI takes no amount). Idempotent per end2endId: a return already sent answers with its
 * status, one in progress answers INITIE, and only a return PI-SPI rejected is sent again. Throws when PI-SPI cannot be reached or answers an error;
 * the return may then have been registered or not, so the caller asks again (the same call) rather than assuming either.
 */
export async function returnFunds(a: PispiAccount, end2endId: string, now = Date.now()): Promise<ReturnState> {
	const url = `${base(a)}/paiements/${encodeURIComponent(end2endId)}/retours`;
	const call = async () => fetch(url, { method: 'PUT', headers: { authorization: `Bearer ${await accessToken(a, 'piz/retour_fonds.write', now)}`, 'x-api-key': a.apiKey } });
	let res = await call();
	if (res.status === 401) { dropTokens(a); res = await call(); }
	if (!res.ok) throw new Error(`PI-SPI retours: ${res.status} ${await reason(res)}`.trim());
	return returnState((await res.json().catch(() => ({}))) as { retourStatut?: string; retourStatutRaison?: string });
}

/** Where the return of a received payment stands, read only (never sends anything): GET /paiements/{end2endId}. */
export async function returnStatus(a: PispiAccount, end2endId: string, now = Date.now()): Promise<ReturnState> {
	const url = `${base(a)}/paiements/${encodeURIComponent(end2endId)}`;
	const call = async (token: string) => fetch(url, { headers: { authorization: `Bearer ${token}`, 'x-api-key': a.apiKey } });
	let res = await call(await accessToken(a, 'piz/paiement.read', now));
	if (res.status === 401) { dropTokens(a); res = await call(await accessToken(a, 'piz/paiement.read', now)); }
	if (!res.ok) throw new Error(`PI-SPI paiements: ${res.status} ${await reason(res)}`.trim());
	return returnState((await res.json().catch(() => ({}))) as { retourStatut?: string; retourStatutRaison?: string });
}
