import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { silence } from './helpers/env.ts';
import { setup, stubFetch, type Call } from './helpers/gateway.ts';
import { clearPispiTokens, type ReceivedPayment } from '../src/providers/pispi.ts';
import { reconcile } from '../src/reconcile.ts';
import { getProviders } from '../src/providers/index.ts';

// two PI-SPI accounts: Côte d'Ivoire under the original secret names, Senegal under its own prefix
const CIV_ALIAS = '9b1b3499-3e50-435b-b757-ac7a83d8aa96';
const SEN_ALIAS = '4d2c8e1f-7a3b-4c5d-9e6f-1a2b3c4d5e6f';
const ENV = {
  PISPI_ENABLED: 'true', PISPI_POLL: 'true', PISPI_RTP: 'false',
  PI_SPI_BUSINESS_API_URL: 'https://pispi.test', PI_SP_API_OAUTH_URL: 'https://auth.pispi.test/token',
  PI_SPI_ACCOUNT_ALIAS: CIV_ALIAS, PI_SPI_PARTICIPANT: 'CIC999', PI_SP_API_CLIENT_ID: 'civ-id', PI_SP_API_CLIENT_SECRET: 'civ-secret', PI_SPI_API_KEY: 'civ-key',
  PI_SPI_SEN_ACCOUNT_ALIAS: SEN_ALIAS, PI_SPI_SEN_PARTICIPANT: 'SNC999', PI_SPI_SEN_CLIENT_ID: 'sen-id', PI_SPI_SEN_CLIENT_SECRET: 'sen-secret', PI_SPI_SEN_API_KEY: 'sen-key',
};

let restore: () => void;
let net: ReturnType<typeof stubFetch>;
/** what each participant's paiements-recus holds */
let received: Record<string, ReceivedPayment[]>;
let senTokenDown = false;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
beforeEach(() => {
  restore = silence(); received = { CIC999: [], SNC999: [] }; senTokenDown = false; clearPispiTokens();
  net = stubFetch((c: Call) => {
    const u = new URL(c.url);
    if (u.host === 'auth.pispi.test') {
      const id = new URLSearchParams(c.body ?? '').get('client_id');
      if (id === 'sen-id' && senTokenDown) return json({ error: 'down' }, 503);
      return json({ access_token: `tok-${id}` });
    }
    const m = /^\/([A-Z0-9]+)\/paiements-recus$/.exec(u.pathname);
    if (u.host === 'pispi.test' && m) return json({ data: (received[m[1]!] ?? []).filter((p) => p.txId === u.searchParams.get('txId')) });
    return undefined;
  });
});
afterEach(() => { net.restore(); restore(); });

const pay = (txId: string, alias: string, end2endId: string): ReceivedPayment => ({ txId, payeAlias: alias, montant: 5000, categorie: '400', statut: 'IRREVOCABLE', end2endId });
const recus = (participant: string) => net.calls.filter((c) => c.url.includes(`/${participant}/paiements-recus`));

/** a gateway with the Senegal account registered and enabled for the product */
async function twoCountries() {
  const g = await setup(ENV);
  const w = await g.admin('POST', '/admin/wallets', { id: 'SEN:PISPI', label: 'PI-SPI Senegal', secretsPrefix: 'PI_SPI_SEN' });
  assert.equal(w.status, 201, JSON.stringify(w.body));
  return g;
}
const enableSen = (g: Awaited<ReturnType<typeof setup>>) => g.admin('PUT', '/admin/tenants/shop/wallets/SEN:PISPI', { collect: true, payout: false });

test('a product with one PI-SPI wallet needs no country; with two it must say which, and the QR is that account\'s', async () => {
  const g = await twoCountries();
  const one = await g.call('POST', '/v1/collections', { reference: 'q-1', amount: 5000, rail: 'pispi_qr' });
  assert.equal(one.status, 201, JSON.stringify(one.body));
  assert.equal(g.row(one.body.id).wallet_id, 'CIV:PISPI', 'its only PI-SPI wallet');
  assert.equal((await g.call('POST', '/v1/collections', { reference: 'q-2', amount: 5000, rail: 'pispi_qr', country: 'SEN' })).body.error.code, 'wallet_not_enabled', 'Senegal is not enabled for it yet');

  await enableSen(g);
  const none = await g.call('POST', '/v1/collections', { reference: 'q-3', amount: 5000, rail: 'pispi_qr' });
  assert.equal(none.status, 400);
  assert.equal(none.body.error.code, 'country_required');
  assert.deepEqual(none.body.error.countries, ['CIV', 'SEN']);
  assert.equal((await g.call('POST', '/v1/collections', { reference: 'q-3', amount: 5000, rail: 'pispi_qr', country: 'FR' })).body.error.code, 'invalid_country');

  const sen = await g.call('POST', '/v1/collections', { reference: 'q-4', amount: 5000, rail: 'pispi_qr', country: 'SN' });
  assert.equal(sen.status, 201, JSON.stringify(sen.body));
  assert.deepEqual([sen.body.qr.alias, sen.body.qr.countryCode], [SEN_ALIAS, 'SN']);
  assert.equal(g.row(sen.body.id).wallet_id, 'SEN:PISPI');
  assert.equal(g.row(sen.body.id).country, 'SEN');
  const civ = await g.call('POST', '/v1/collections', { reference: 'q-5', amount: 5000, rail: 'pispi_qr', country: 'CIV' });
  assert.deepEqual([civ.body.qr.alias, civ.body.qr.countryCode], [CIV_ALIAS, 'CI']);

  // a repeat names the same country, or it is a different request
  assert.equal((await g.call('POST', '/v1/collections', { reference: 'q-4', amount: 5000, rail: 'pispi_qr', country: 'SEN' })).status, 200);
  assert.equal((await g.call('POST', '/v1/collections', { reference: 'q-4', amount: 5000, rail: 'pispi_qr', country: 'CIV' })).body.error.code, 'idempotency_conflict');

  const m = (await g.call('GET', '/v1/methods?rail=pispi_qr&country=SEN')).body;
  assert.deepEqual([m.available, m.wallet], [true, 'SEN:PISPI']);
  assert.equal((await g.call('GET', '/v1/methods?rail=pispi_qr')).body.error.code, 'country_required');
});

test('two accounts never share a token, a poll or a pool: each payment is looked for at its own participant, with its own key, on its own alias', async () => {
  const g = await twoCountries();
  await enableSen(g);
  const civ = (await g.call('POST', '/v1/collections', { reference: 'c-1', amount: 5000, rail: 'pispi_qr', country: 'CIV' })).body.id as string;
  const sen = (await g.call('POST', '/v1/collections', { reference: 's-1', amount: 5000, rail: 'pispi_qr', country: 'SEN' })).body.id as string;

  // the Senegal payment paid to the Côte d'Ivoire alias is not Senegal's
  received.SNC999.push(pay(sen.toUpperCase(), CIV_ALIAS, 'E2E-WRONG-ALIAS'));
  received.CIC999.push(pay(civ.toUpperCase(), CIV_ALIAS, 'E2E-CIV'));
  g.sqlite.prepare('UPDATE payments SET last_checked_at = NULL').run();
  assert.equal((await g.call('GET', `/v1/collections/${civ}`)).body.status, 'completed');
  assert.equal((await g.call('GET', `/v1/collections/${sen}`)).body.status, 'processing', 'money on another account\'s alias settles nothing');

  received.SNC999 = [pay(sen.toUpperCase(), SEN_ALIAS, 'E2E-SEN')];
  g.sqlite.prepare('UPDATE payments SET last_checked_at = NULL').run();
  assert.equal((await g.call('GET', `/v1/collections/${sen}`)).body.status, 'completed');

  assert.ok(recus('CIC999').every((c) => c.headers?.['x-api-key'] === 'civ-key' && c.headers?.authorization === 'Bearer tok-civ-id'), 'Côte d\'Ivoire: its key, its token');
  assert.ok(recus('SNC999').length >= 2 && recus('SNC999').every((c) => c.headers?.['x-api-key'] === 'sen-key' && c.headers?.authorization === 'Bearer tok-sen-id'), 'Senegal: its key, its token');
  assert.ok(!recus('CIC999').some((c) => c.url.includes(sen.toUpperCase())) && !recus('SNC999').some((c) => c.url.includes(civ.toUpperCase())), 'never asked of the other participant');
  const tokens = net.calls.filter((c) => c.url.includes('auth.pispi.test')).map((c) => new URLSearchParams(c.body ?? '').get('client_id'));
  assert.deepEqual([...new Set(tokens)].sort(), ['civ-id', 'sen-id']);

  const pools = g.sqlite.prepare(`SELECT payment_id, pool, destination FROM ledger_postings WHERE kind = 'in' ORDER BY pool`).all() as { payment_id: string; pool: string; destination: string }[];
  assert.deepEqual(pools.map((p) => [p.payment_id, p.pool, p.destination]), [[civ, 'CIV:PISPI', 'tenants:shop:CIV:PISPI:available'], [sen, 'SEN:PISPI', 'tenants:shop:SEN:PISPI:available']]);
});

test('one account failing does not stop the other\'s reconciliation', async () => {
  const g = await twoCountries();
  await enableSen(g);
  const civ = (await g.call('POST', '/v1/collections', { reference: 'c-1', amount: 5000, rail: 'pispi_qr', country: 'CIV' })).body.id as string;
  const sen = (await g.call('POST', '/v1/collections', { reference: 's-1', amount: 5000, rail: 'pispi_qr', country: 'SEN' })).body.id as string;
  received.CIC999.push(pay(civ.toUpperCase(), CIV_ALIAS, 'E2E-CIV'));
  received.SNC999.push(pay(sen.toUpperCase(), SEN_ALIAS, 'E2E-SEN'));
  senTokenDown = true;
  g.sqlite.prepare('UPDATE payments SET last_checked_at = NULL, created_at = created_at - 600000').run();
  await reconcile(g.env, getProviders(g.env), Date.now());
  assert.equal(g.row(civ).status, 'completed');
  assert.equal(g.row(sen).status, 'processing', 'Senegal unreachable: left as it was, asked again later');
});

test('an account whose secrets are missing is not offered, and the Providers page names what is missing (never a value)', async () => {
  const g = await setup({ ...ENV, PI_SPI_SEN_API_KEY: undefined, PI_SPI_SEN_ACCOUNT_ALIAS: undefined });
  await g.admin('POST', '/admin/wallets', { id: 'SEN:PISPI', secretsPrefix: 'PI_SPI_SEN' });
  await enableSen(g);
  const r = await g.call('POST', '/v1/collections', { reference: 's-1', amount: 5000, rail: 'pispi_qr', country: 'SEN' });
  assert.equal(r.body.error.code, 'provider_unavailable');
  assert.match(r.body.error.message, /SEN/);
  const pi = (await g.admin('GET', '/admin/providers')).body.data.find((p: any) => p.id === 'pispi');
  assert.deepEqual(pi.accounts.map((a: any) => [a.wallet, a.participant, a.missing]), [['CIV:PISPI', 'CIC999', []], ['SEN:PISPI', 'SNC999', ['PI_SPI_SEN_ACCOUNT_ALIAS', 'PI_SPI_SEN_API_KEY']]]);
  assert.deepEqual(pi.channels.map((c: any) => [c.country, c.code, c.collect.status]), [['CIV', 'PISPI_QR', 'OPERATIONAL'], ['CIV', 'PISPI_RTP', 'CLOSED'], ['SEN', 'PISPI_QR', 'CLOSED'], ['SEN', 'PISPI_RTP', 'CLOSED']]);
  assert.ok(!['civ-key', 'civ-secret', 'sen-secret', 'civ-id'].some((v) => JSON.stringify(pi).includes(v)), 'no secret value');
});
