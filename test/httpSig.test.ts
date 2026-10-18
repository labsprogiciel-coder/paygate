import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callbackRejection, ecdsaRaw } from '../src/providers/httpSig.ts';
import { derSignature, signedCallbackRequest, signer } from './helpers/gateway.ts';

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

test("pawaPay's documented signatures are DER and become raw r‖s of the curve's size", () => {
	// from https://docs.pawapay.io/v2/docs/signatures (a callback and an API response)
	for (const s of ['MEQCIHFvGCUgyxmmowMufO4Yk20pBs3JHRax81si2QZVi9ByAiBPpg1WBhQjZ6fmi3a/gKcWiQ73Qm9Ol35On3c4K/flew==', 'MEUCIFPakg6tQqN33NueVBPCKK4/GJ7BmHqux2yNQqWOEfmRAiEA43SOGd4JvlX2DWuh1oe0nP+/J8POSfr24SwXw2aRHRs=']) {
		const der = b64(s);
		assert.equal(der[0], 0x30);
		assert.equal(ecdsaRaw(der, 32).length, 64);
	}
});

test('DER and raw round-trip, including integers that need a leading zero or are short', () => {
	for (const size of [32, 48]) {
		for (const [r0, s0] of [[0xff, 0x01], [0x00, 0x80], [0x7f, 0x00]]) {
			const raw = new Uint8Array(2 * size).map((_, i) => (i * 37 + 11) & 0xff);
			raw[0] = r0!; raw[size] = s0!;
			assert.deepEqual(ecdsaRaw(derSignature(raw), size), raw);
			assert.deepEqual(ecdsaRaw(raw, size), raw, 'raw is left as it is');
		}
	}
	const junk = new Uint8Array([0x30, 0x03, 0x02, 0x01]);
	assert.deepEqual(ecdsaRaw(junk, 32), junk, 'malformed DER is not "repaired": it just fails to verify');
});

test('a callback verifies whether signed DER (as pawaPay does) or raw, and a refusal says why', async () => {
	const { kp, pem } = await signer();
	const key = async (): Promise<string | null> => pem;
	const body = '{"payoutId":"p","status":"COMPLETED"}';
	const check = async (r: Request, getKey = key) => callbackRejection({ method: r.method, url: new URL(r.url), headers: r.headers, body: await r.text() }, getKey);
	assert.equal(await check(await signedCallbackRequest(body, kp, '/callbacks/pawapay/payouts')), null, 'DER');
	assert.equal(await check(await signedCallbackRequest(body, kp, '/callbacks/pawapay/payouts', { raw: true })), null, 'raw');
	assert.match((await check(await signedCallbackRequest(body, kp, '/callbacks/pawapay/payouts', { created: 1 })))!, /stale/);
	assert.match((await check(await signedCallbackRequest(body, kp, '/callbacks/pawapay/payouts'), async () => null))!, /no public key/);
	const other = await signer();
	assert.equal(await check(await signedCallbackRequest(body, other.kp, '/callbacks/pawapay/payouts')), 'signature does not verify');
});
