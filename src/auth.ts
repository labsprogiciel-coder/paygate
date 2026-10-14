import { verifyToken } from '@clerk/backend';
import { ApiError } from './errors.ts';

/**
 * Operator sign-in with Clerk. On when CLERK_PUBLISHABLE_KEY is set and a way to check session tokens is too
 * (CLERK_JWT_KEY: networkless, or CLERK_SECRET_KEY: Clerk's JWKS, fetched and cached).
 * Being signed in is not enough: only the Clerk user ids listed in CLERK_OPERATOR_IDS are operators. An empty list lets nobody in.
 */
export function clerkEnabled(env: Env): boolean {
	return !!clerkFrontendApi(env.CLERK_PUBLISHABLE_KEY) && !!(env.CLERK_JWT_KEY || env.CLERK_SECRET_KEY);
}

/** The Frontend API host a publishable key names (`pk_test_<base64("host$")>`), or null if it is not one. The console loads Clerk from there. */
export function clerkFrontendApi(publishableKey: string | undefined): string | null {
	const m = /^pk_(?:test|live)_([A-Za-z0-9+/=_-]+)$/.exec(publishableKey ?? '');
	if (!m) return null;
	let host: string;
	try { host = atob(m[1]!.replace(/-/g, '+').replace(/_/g, '/')); } catch { return null; }
	if (!host.endsWith('$')) return null;
	host = host.slice(0, -1);
	return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) ? host.toLowerCase() : null;
}

export const operatorIds = (env: Env): Set<string> => new Set((env.CLERK_OPERATOR_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean));

/** The Clerk user id behind a session token, if it is valid, made for this origin, and belongs to an operator. */
export async function clerkOperator(env: Env, request: Request, token: string): Promise<string> {
	let sub: string | undefined;
	try {
		const payload = await verifyToken(token, {
			jwtKey: env.CLERK_JWT_KEY || undefined,
			secretKey: env.CLERK_SECRET_KEY || undefined,
			// the console is served by this Worker, so its token must have been issued to this origin
			authorizedParties: [new URL(request.url).origin],
		});
		sub = payload.sub;
	} catch {
		throw new ApiError(401, 'unauthorized', 'The session is not valid. Sign in again.');
	}
	if (!sub) throw new ApiError(401, 'unauthorized', 'The session is not valid. Sign in again.');
	if (!operatorIds(env).has(sub)) throw new ApiError(403, 'not_operator', 'This account is not an operator', { userId: sub });
	return sub;
}
