import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/index.ts';
import { mask, sentryOptions } from '../src/sentry.ts';
import { createEnv, silence, stubFetch } from './helpers/env.ts';
import { fakeCtx, setup } from './helpers/gateway.ts';

const DSN = 'https://publickey@o1.ingest.sentry.test/42';
const KEY = `pgk_${'a'.repeat(12)}_${'b'.repeat(64)}`;

test('masking: API keys, webhook secrets, bearer tokens and phone numbers; ids and amounts are left alone', () => {
	assert.equal(mask(`key ${KEY} for +2250700000001 and 221771234567`), 'key pgk_[redacted] for [phone] and [phone]');
	assert.equal(mask('whsec_0123456789abcdef0123 / Authorization: Bearer abc.def.ghi-jkl'), 'whsec_[redacted] / Authorization: Bearer [redacted]');
	assert.equal(mask('payment pg0123456789abcdef01 of 5000 XOF'), 'payment pg0123456789abcdef01 of 5000 XOF');
});

test('off without SENTRY_DSN: no options, nothing sent', () => {
	assert.equal(sentryOptions(createEnv().env), undefined);
});

test('an unexpected error is answered 500 and reported to Sentry, scrubbed, with where it happened', async () => {
	const quiet = silence();
	const net = stubFetch((c) => c.url.includes('sentry.test') ? new Response('{}') : undefined);
	try {
		const e = createEnv({ SENTRY_DSN: DSN, ADMIN_API_KEY: KEY });
		// the database fails with a message that carries a key and a phone number, as a careless error could
		(e.env as any).DB = { prepare() { throw new Error(`D1 exploded near ${KEY} / +2250700000001`); }, batch() { throw new Error('no'); } };
		const { ctx, settle } = fakeCtx();
		const res = await worker.fetch!(new Request('https://gw.test/admin/tenants?secret=x', { headers: { authorization: `Bearer ${KEY}`, cookie: 'a=b' } }) as any, e.env, ctx);
		await settle();
		assert.equal(res.status, 500);
		assert.deepEqual(await res.json(), { error: { code: 'internal', message: 'Something went wrong on our side' } }, 'the caller still sees nothing internal');

		const sent = net.calls.filter((c) => c.url.includes('sentry.test')).map((c) => c.body ?? '').join('\n');
		assert.ok(sent.includes('D1 exploded near'), 'the error reached Sentry');
		assert.match(sent, /"where":"request"/);
		assert.match(sent, /"path":"\/admin\/tenants"/);
		for (const leak of [KEY, '2250700000001', 'Bearer pgk', 'a=b', 'secret=x']) assert.ok(!sent.includes(leak), `must not send ${leak}`);
		assert.ok(sent.includes('pgk_[redacted]') && sent.includes('[phone]'));
	} finally { net.restore(); quiet(); }
});

test('a critical operator alert (a payout whose outcome is unknown) also goes to Sentry, without the customer number', async () => {
	const quiet = silence();
	const net = stubFetch((c) => c.url.includes('sentry.test') ? new Response('{}') : undefined);
	try {
		const g = await setup({ SENTRY_DSN: DSN });
		const { ctx, settle } = fakeCtx();
		const res = await worker.fetch!(new Request('https://gw.test/v1/disbursements', { method: 'POST', headers: { authorization: `Bearer ${g.key}`, 'content-type': 'application/json' },
			body: JSON.stringify({ reference: 'payout-sentry', amount: 5000, operator: 'orange', phone: '+2250700005555' }) }) as any, g.env, ctx);
		await settle();
		assert.equal((await res.json() as any).status, 'unknown');
		const sent = net.calls.filter((c) => c.url.includes('sentry.test')).map((c) => c.body ?? '').join('\n');
		assert.match(sent, /Paygate: Disbursement outcome unknown/);
		assert.match(sent, /"level":"error"/);
		assert.ok(!sent.includes('2250700005555'), 'the customer number never leaves');
	} finally { net.restore(); quiet(); }
});
