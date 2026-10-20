import { ApiError } from './errors.ts';

/**
 * Per-tenant request budgets on `/v1/*`, so one product with a bug or a leaked key cannot starve the others (or the shared provider quota).
 * Writes (creating payments, test webhooks) and reads have separate budgets: the Workers Rate Limiting bindings WRITE_LIMIT and READ_LIMIT
 * (wrangler.jsonc), keyed on the tenant id. The counters are per Cloudflare location and approximate: a guard against floods, not a quota.
 * Without a binding (tests, previews), or if the limiter itself fails, the request goes through: a limiter outage must never stop payments.
 */
export const RETRY_AFTER_SECONDS = 60;

type LimitEnv = { WRITE_LIMIT?: RateLimit; READ_LIMIT?: RateLimit };

export async function rateLimit(env: LimitEnv, tenantId: string, write: boolean): Promise<void> {
	const limiter = write ? env.WRITE_LIMIT : env.READ_LIMIT;
	if (!limiter) return;
	let ok = true;
	try { ok = (await limiter.limit({ key: tenantId })).success; } catch (e) {
		console.error(JSON.stringify({ msg: 'ratelimit.failed', tenant: tenantId, error: e instanceof Error ? e.message : String(e) }));
	}
	if (!ok) throw new ApiError(429, 'rate_limited', `Too many ${write ? 'payment requests' : 'reads'} from this account; slow down and retry`, { retryAfter: RETRY_AFTER_SECONDS });
}
