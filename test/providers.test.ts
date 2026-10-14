import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { pawapayStub, setup, stubFetch } from './helpers/gateway.ts';
import { silence } from './helpers/env.ts';

let restore: () => void;
let net: ReturnType<typeof stubFetch>;
const state: { balances?: unknown } = {};
beforeEach(() => { restore = silence(); state.balances = undefined; net = stubFetch((c) => pawapayStub(state)(c)); });
afterEach(() => { net.restore(); restore(); });

const PISPI = { PISPI_ENABLED: 'true', PI_SPI_ACCOUNT_ALIAS: '3fa85f64-5717-4562-b3fc-2c963f66afa6', PI_SPI_PARTICIPANT: 'CIC999', PISPI_COUNTRY: 'CI' };

test('sandbox: every supported channel is open both ways, and there are no payout wallets', async () => {
	const g = await setup();
	const r = await g.admin('GET', '/admin/providers');
	assert.equal(r.status, 200);
	const mm = r.body.data.find((p: any) => p.id === 'sandbox');
	assert.equal(mm.environment, 'Simulated');
	assert.deepEqual(mm.channels.map((c: any) => c.code), ['ORANGE_CIV', 'WAVE_CIV', 'ORANGE_SEN', 'WAVE_SEN', 'ORANGE_BFA', 'MOOV_BFA']);
	assert.ok(mm.channels.every((c: any) => c.collect.status === 'OPERATIONAL' && c.payout.status === 'OPERATIONAL'));
	assert.deepEqual(mm.accounts, []);
	assert.match(mm.accountsNote, /no wallets/);
});

test('pawaPay: channels come from the account configuration, missing ones say so; one payout wallet per country', async () => {
	state.balances = { balances: [{ country: 'CIV', currency: 'XOF', balance: '3500000' }, { country: 'SEN', currency: 'XOF', balance: '100' }] };
	const g = await setup({ PROVIDER_MODE: 'pawapay' });
	const mm = (await g.admin('GET', '/admin/providers')).body.data.find((p: any) => p.id === 'pawapay');
	assert.equal(mm.environment, 'Sandbox');
	const orangeCiv = mm.channels.find((c: any) => c.code === 'ORANGE_CIV');
	assert.deepEqual(orangeCiv.collect, { status: 'OPERATIONAL', min: 100, max: 1000000 });
	assert.deepEqual(orangeCiv.payout, { status: 'OPERATIONAL', min: 100, max: 1000000 });
	assert.deepEqual(mm.channels.find((c: any) => c.code === 'WAVE_SEN').collect, null, 'not on the account');
	assert.deepEqual(mm.accounts.map((a: any) => [a.country, a.balance, a.status]), [['CIV', 3500000, 'ok'], ['SEN', 100, 'low'], ['BFA', null, 'critical']]);
	assert.equal(mm.accountsNote, null);
});

test('pawaPay unreachable: the page still answers, with the reason', async () => {
	net.restore();
	net = stubFetch((c) => new URL(c.url).host.endsWith('pawapay.io') ? new Response('down', { status: 503 }) : undefined);
	const g = await setup({ PROVIDER_MODE: 'pawapay' });
	const r = await g.admin('GET', '/admin/providers');
	assert.equal(r.status, 200);
	const mm = r.body.data.find((p: any) => p.id === 'pawapay');
	assert.equal(mm.channels, null);
	assert.match(mm.channelsError, /configuration/);
	assert.match(mm.accountsNote, /could not be read/);
});

test('PI-SPI: QR and payment-request rails, and the receiving alias shown masked with its participant', async () => {
	const g = await setup(PISPI);
	const pi = (await g.admin('GET', '/admin/providers')).body.data.find((p: any) => p.id === 'pispi');
	assert.equal(pi.active, true);
	assert.deepEqual(pi.channels.map((c: any) => [c.country, c.code, c.collect.status, c.payout]), [['CIV', 'PISPI_QR', 'OPERATIONAL', null], ['CIV', 'PISPI_RTP', 'CLOSED', null]]);
	assert.deepEqual(pi.accounts, [{ kind: 'alias', label: 'Receiving alias', country: 'CIV', currency: 'XOF', value: '3fa85f64…afa6', participant: 'CIC999' }]);
	assert.ok(!JSON.stringify(pi).includes('5717-4562'), 'the full alias is not sent');
});
