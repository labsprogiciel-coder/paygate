import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clerkFrontendApi } from '../src/auth.ts';
import { handle } from '../src/index.ts';
import { B64, fakeCtx, setup, stubFetch } from './helpers/gateway.ts';
import { createEnv, silence } from './helpers/env.ts';

const FAPI = 'happy-otter-12.clerk.accounts.dev';
const PK = `pk_test_${btoa(`${FAPI}$`)}`;
const ORIGIN = 'https://gw.test';
const b64url = (s: string | Uint8Array) => B64(typeof s === 'string' ? new TextEncoder().encode(s) : s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** A Clerk instance in miniature: an RSA key pair, its PEM public key (what CLERK_JWT_KEY holds), and session tokens signed with it. */
async function clerkIssuer() {
	const kp = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
	const spki = new Uint8Array((await crypto.subtle.exportKey('spki', kp.publicKey)) as ArrayBuffer);
	const pem = `-----BEGIN PUBLIC KEY-----\n${B64(spki).match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----\n`;
	const token = async (claims: Record<string, unknown> = {}) => {
		const now = Math.floor(Date.now() / 1000);
		const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'ins_test' }));
		const body = b64url(JSON.stringify({ sub: 'user_op1', sid: 'sess_1', azp: ORIGIN, iss: `https://${FAPI}`, iat: now - 5, nbf: now - 5, exp: now + 60, ...claims }));
		const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, new TextEncoder().encode(`${head}.${body}`)));
		return `${head}.${body}.${b64url(sig)}`;
	};
	return { pem, token };
}

const clerkVars = (pem: string, over: Record<string, unknown> = {}) => ({ CLERK_PUBLISHABLE_KEY: PK, CLERK_JWT_KEY: pem, CLERK_OPERATOR_IDS: 'user_op1, user_op2', ...over });

test('the Frontend API host is read from the publishable key, and anything else is refused', () => {
	assert.equal(clerkFrontendApi(PK), FAPI);
	assert.equal(clerkFrontendApi(`pk_live_${btoa('clerk.example.com$')}`), 'clerk.example.com');
	assert.equal(clerkFrontendApi(''), null);
	assert.equal(clerkFrontendApi(`pk_test_${btoa('no-dollar.example.com')}`), null);
	assert.equal(clerkFrontendApi(`pk_test_${btoa('"><script>$')}`), null);
	assert.equal(clerkFrontendApi('sk_test_abc'), null);
});

test('a Clerk session of a listed operator opens the operator API, and their user id is the actor in the history', async () => {
	const c = await clerkIssuer();
	const g = await setup(clerkVars(c.pem));
	const token = await c.token();
	assert.equal((await g.call('GET', '/admin/float', undefined, token)).status, 200);

	const net = stubFetch(), quiet = silence(); // the unknown outcome raises an alert
	try {
		const p = await g.call('POST', '/v1/disbursements', { reference: 'payout-clerk', amount: 5000, operator: 'orange', phone: '+2250700005555' });
		assert.equal(p.body.status, 'unknown'); // the sandbox's "5555" is an outcome nobody knows: it needs a person
		const r = await g.call('POST', `/admin/payments/${p.body.id}/resolve`, { outcome: 'failed', note: 'checked with pawaPay' }, token);
		assert.equal(r.status, 200);
		assert.ok(g.events(p.body.id).some((e) => e.actor === 'admin:user_op1' && e.type === 'failed'));
		const seen = (await g.call('GET', `/v1/disbursements/${p.body.id}/events`)).body.data as { actor: string }[];
		assert.ok(seen.some((e) => e.actor === 'operator') && !seen.some((e) => e.actor.includes('user_op1')), 'the tenant never sees who');
	} finally { net.restore(); quiet(); }
});

test('a valid session that is not an operator gets 403 with its user id; a bad, expired or foreign token gets 401', async () => {
	const c = await clerkIssuer();
	const g = await setup(clerkVars(c.pem));
	const not = await g.call('GET', '/admin/float', undefined, await c.token({ sub: 'user_someone' }));
	assert.equal(not.status, 403);
	assert.equal(not.body.error.code, 'not_operator');
	assert.equal(not.body.error.userId, 'user_someone');

	const now = Math.floor(Date.now() / 1000);
	assert.equal((await g.call('GET', '/admin/float', undefined, await c.token({ exp: now - 120 }))).status, 401, 'expired');
	assert.equal((await g.call('GET', '/admin/float', undefined, await c.token({ azp: 'https://evil.test' }))).status, 401, 'issued to another origin');
	const other = await clerkIssuer();
	assert.equal((await g.call('GET', '/admin/float', undefined, await other.token())).status, 401, 'signed by another key');
	assert.equal((await g.call('GET', '/admin/float', undefined, 'a.b.c')).status, 401);
	assert.equal((await g.call('GET', '/v1/me', undefined, await c.token())).status, 401, 'an operator session is not a tenant key');
});

test('nobody is an operator while CLERK_OPERATOR_IDS is empty', async () => {
	const c = await clerkIssuer();
	const g = await setup(clerkVars(c.pem, { CLERK_OPERATOR_IDS: '' }));
	assert.equal((await g.call('GET', '/admin/float', undefined, await c.token())).status, 403);
});

test('the admin key still works next to Clerk; with neither configured the operator API is off', async () => {
	const c = await clerkIssuer();
	const both = await setup(clerkVars(c.pem));
	assert.equal((await both.admin('GET', '/admin/float')).status, 200);

	const clerkOnly = await setup(clerkVars(c.pem, { ADMIN_API_KEY: '' }));
	assert.equal((await clerkOnly.call('GET', '/admin/float', undefined, await c.token())).status, 200);
	assert.equal((await clerkOnly.call('GET', '/admin/float', undefined, 'x'.repeat(30))).status, 401);

	const neither = await setup({ ADMIN_API_KEY: '' });
	assert.equal((await neither.call('GET', '/admin/float', undefined, 'x'.repeat(30))).status, 503);
	const halfClerk = await setup({ ADMIN_API_KEY: '', CLERK_PUBLISHABLE_KEY: PK }); // no secret or JWT key: Clerk is not on
	assert.equal((await halfClerk.call('GET', '/admin/float', undefined, await c.token())).status, 503);
});

test('the console page carries the publishable key and a CSP that lets Clerk load, only when Clerk is on', async () => {
	const html = '<!doctype html><html><head><title>Paygate Console</title></head><body></body></html>';
	const ASSETS = { fetch: async () => new Response(html, { headers: { 'content-type': 'text/html' } }) };
	const page = async (over: Record<string, unknown>) => {
		const e = createEnv({ ASSETS, ...over });
		const res = await handle(new Request(`${ORIGIN}/`), e.env, fakeCtx().ctx);
		return { csp: res.headers.get('content-security-policy')!, body: await res.text() };
	};
	const on = await page(clerkVars('pem'));
	assert.match(on.body, new RegExp(`<meta name="clerk-publishable-key" content="${PK.replace(/[+/=]/g, '\\$&')}">`));
	assert.match(on.body, new RegExp(`<meta name="clerk-frontend-api" content="${FAPI}">`));
	assert.match(on.csp, new RegExp(`script-src 'self' https://${FAPI} `));
	assert.match(on.csp, new RegExp(`connect-src 'self' https://${FAPI};`));

	const off = await page({});
	assert.doesNotMatch(off.body, /clerk/);
	assert.match(off.csp, /script-src 'self';/);
});
