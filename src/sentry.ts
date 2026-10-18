import * as Sentry from '@sentry/cloudflare';
import type { ErrorEvent } from '@sentry/cloudflare';
import { on } from './util.ts';

/**
 * Error reporting to Sentry. Off unless SENTRY_DSN is set (a secret), so local runs, tests and branch previews send nothing.
 * Errors only, no tracing. A payment gateway must not leak what passes through it: the SDK is told to collect almost nothing, and every
 * event is scrubbed again before it leaves:
 * no request bodies, cookies or query strings, no auth or signature headers, and API keys, webhook secrets, bearer tokens and
 * phone numbers are masked wherever they appear in messages, exception values, breadcrumbs or extra data.
 */
export function sentryOptions(env: Env): Sentry.CloudflareOptions | undefined {
	if (!env.SENTRY_DSN) return undefined;
	return {
		dsn: env.SENTRY_DSN,
		environment: on(env.LIVE) ? 'production' : `sandbox-${env.PROVIDER_MODE || 'sandbox'}`,
		// the release is the Worker version (the CF_VERSION_METADATA binding), picked up by the SDK
		// collect as little as possible: no bodies, cookies, query strings, user info, query text or local variables; three harmless headers
		dataCollection: {
			userInfo: false, cookies: false, urlQueryParams: false, httpBodies: [],
			httpHeaders: { request: { allow: ['user-agent', 'content-type', 'cf-ray'] }, response: false },
			databaseQueryData: false, stackFrameVariables: false, queues: false,
			graphQL: { document: false, variables: false }, genAI: { inputs: false, outputs: false },
		},
		tracesSampleRate: 0,
		beforeSend: (event) => scrubEvent(event),
		beforeBreadcrumb: (b) => ({ ...b, message: b.message ? mask(b.message) : b.message, data: b.data ? maskDeep(b.data) as typeof b.data : b.data }),
	};
}

const SECRET_HEADERS = /^(authorization|cookie|set-cookie|signature|signature-input|content-digest|paygate-signature|x-api-key|cf-access-.*)$/i;

/** API keys, webhook secrets, bearer tokens, and anything shaped like a phone number (E.164 or a bare MSISDN). */
export function mask(s: string): string {
	return s
		.replace(/pgk_[0-9a-f]{12}_[0-9a-f]{64}/g, 'pgk_[redacted]')
		.replace(/whsec_[0-9a-f]{16,}/g, 'whsec_[redacted]')
		.replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
		.replace(/\+?\b(225|221|226)\d{8,10}\b/g, '[phone]');
}

function maskDeep(v: unknown, depth = 0): unknown {
	if (typeof v === 'string') return mask(v);
	if (depth > 6 || v === null || typeof v !== 'object') return v;
	if (Array.isArray(v)) return v.map((x) => maskDeep(x, depth + 1));
	return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_HEADERS.test(k) ? '[redacted]' : maskDeep(x, depth + 1)]));
}

export function scrubEvent(event: ErrorEvent): ErrorEvent {
	if (event.request) {
		const { data: _data, cookies: _cookies, query_string: _qs, ...rest } = event.request;
		event.request = { ...rest, url: rest.url?.split('?')[0], headers: rest.headers ? maskDeep(rest.headers) as Record<string, string> : undefined };
	}
	if (event.message) event.message = mask(event.message);
	for (const ex of event.exception?.values ?? []) if (ex.value) ex.value = mask(ex.value);
	if (event.extra) event.extra = maskDeep(event.extra) as typeof event.extra;
	if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map((b) => ({ ...b, message: b.message ? mask(b.message) : b.message, data: b.data ? maskDeep(b.data) as typeof b.data : b.data }));
	return event;
}

/** An error the gateway handled (answered 500, or a cron step that failed alone): Sentry never sees these unless told. */
export function reportError(e: unknown, context: { where: string; [k: string]: string | number | undefined }): void {
	if (!Sentry.isEnabled()) return;
	Sentry.withScope((scope) => {
		for (const [k, v] of Object.entries(context)) if (v !== undefined) scope.setTag(k, String(v));
		Sentry.captureException(e);
	});
}

/** An operator alert (unknown payout, wallet empty, webhook dead...) as a Sentry message, grouped by its title. */
export function reportAlert(level: 'critical' | 'warning' | 'info', title: string, details: Record<string, unknown>): void {
	if (!Sentry.isEnabled() || level === 'info') return;
	Sentry.withScope((scope) => {
		scope.setFingerprint(['alert', title]);
		scope.setTag('alert', 'true');
		scope.setExtras(maskDeep(details) as Record<string, unknown>);
		Sentry.captureMessage(mask(`Paygate: ${title}`), level === 'critical' ? 'error' : 'warning');
	});
}
