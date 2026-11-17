import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { silence } from './helpers/env.ts';
import { setup, stubFetch, type Call } from './helpers/gateway.ts';
import { clearPispiTokens, type ReceivedPayment } from '../src/providers/pispi.ts';
import { reconcileReturns } from '../src/returns.ts';

const ALIAS = '9b1b3499-3e50-435b-b757-ac7a83d8aa96';
const PISPI = {
  PISPI_ENABLED: 'true', PISPI_POLL: 'true', PISPI_RTP: 'false', PISPI_RETURNS: 'true', PI_SPI_ACCOUNT_ALIAS: ALIAS, PI_SPI_PARTICIPANT: 'BFC999',
  PI_SPI_BUSINESS_API_URL: 'https://pispi.test', PI_SP_API_OAUTH_URL: 'https://auth.pispi.test/token', PI_SP_API_CLIENT_ID: 'id', PI_SP_API_CLIENT_SECRET: 'secret', PI_SPI_API_KEY: 'key',
};
const MINUTE = 60_000;

let restore: () => void;
let net: ReturnType<typeof stubFetch>;
let received: ReceivedPayment[];
/** what PI-SPI answers to PUT .../retours and GET .../paiements/{end2endId}: a retourStatut, a raw Response, or a thrown error */
let putAnswer: () => Response;
let getAnswer: () => Response;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const retour = (retourStatut?: string, retourStatutRaison?: string) => () => json({ statut: 'IRREVOCABLE', end2endId: 'E2E-A', ...(retourStatut ? { retourStatut, retourStatutRaison } : {}) });

beforeEach(() => {
  restore = silence(); received = []; clearPispiTokens();
  putAnswer = retour('INITIE'); getAnswer = retour('INITIE');
  net = stubFetch((c: Call) => {
    const u = new URL(c.url);
    if (u.host === 'auth.pispi.test') return json({ access_token: `tok-${new URLSearchParams(c.body ?? '').get('scope')}` });
    if (u.host !== 'pispi.test') return undefined;
    if (u.pathname.endsWith('/paiements-recus')) return json({ data: received.filter((p) => p.txId === u.searchParams.get('txId')) });
    if (u.pathname.endsWith('/retours') && c.method === 'PUT') return putAnswer();
    if (/\/paiements\/[^/]+$/.test(u.pathname) && c.method === 'GET') return getAnswer();
    return undefined;
  });
});
afterEach(() => { net.restore(); restore(); });

const pay = (over: Partial<ReceivedPayment>): ReceivedPayment => ({ txId: 'PGX', payeAlias: ALIAS, montant: 5000, categorie: '400', statut: 'IRREVOCABLE', end2endId: 'E2E-A', ...over });
const retourCalls = () => net.calls.filter((c) => c.url.includes('/retours'));

/** a QR collection of 5000 XOF, completed by the received payment E2E-A */
async function completed(g: Awaited<ReturnType<typeof setup>>, ref = 'q-1') {
  const a = await g.call('POST', '/v1/collections', { reference: ref, amount: 5000, rail: 'pispi_qr' });
  received.push(pay({ txId: a.body.id.toUpperCase() }));
  g.sqlite.prepare('UPDATE payments SET last_checked_at = NULL').run();
  assert.equal((await g.call('GET', `/v1/collections/${a.body.id}`)).body.status, 'completed');
  return a.body.id as string;
}
const postings = (g: Awaited<ReturnType<typeof setup>>, id: string) =>
  (g.sqlite.prepare('SELECT kind, source, destination, amount FROM ledger_postings WHERE payment_id = ? ORDER BY created_at, kind').all(id) as { kind: string; source: string; destination: string; amount: number }[]);

test('an operator returns a completed PI-SPI payment: sent once to PI-SPI, followed until irrevocable, booked once, and the product is told', async () => {
  const g = await setup(PISPI, { webhookUrl: 'https://shop.test/hook' });
  const id = await completed(g);
  const before = await g.admin('GET', `/admin/payments/${id}`);
  assert.deepEqual(before.body.returnable, { ok: true, end2endId: 'E2E-A' });

  const r = await g.admin('POST', `/admin/payments/${id}/return`, { reason: 'Customer cancelled the order' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.returnStatus, 'initiated');
  const put = retourCalls();
  assert.equal(put.length, 1);
  assert.equal(new URL(put[0]!.url).pathname, '/BFC999/paiements/E2E-A/retours', 'the participant path, like the other PI-SPI calls');
  assert.equal(put[0]!.method, 'PUT');
  assert.ok(net.calls.some((c) => c.url.includes('auth.pispi.test') && new URLSearchParams(c.body ?? '').get('scope') === 'piz/retour_fonds.write'));
  assert.equal(postings(g, id).filter((p) => p.kind === 'refund').length, 0, 'nothing is booked until PI-SPI says it is irrevocable');

  // a second request while it is on its way is refused, and nothing is sent again
  assert.equal((await g.admin('POST', `/admin/payments/${id}/return`, { reason: 'again' })).body.error.code, 'not_returnable');
  assert.equal(retourCalls().length, 1);

  // the cron only reads (GET) a return in progress, never sends it again
  const t0 = Date.now();
  await reconcileReturns(g.env, t0 + MINUTE * 2);
  assert.equal(retourCalls().length, 1, 'an initiated return is read, not re-sent (PI-SPI re-sends a rejected one)');
  assert.equal(g.row(id).return_status, 'initiated');
  getAnswer = retour('IRREVOCABLE');
  await reconcileReturns(g.env, t0 + MINUTE * 4);
  await reconcileReturns(g.env, t0 + MINUTE * 6); // a repeat changes nothing
  const row = g.row(id);
  assert.equal(row.return_status, 'returned');
  assert.equal(row.status, 'completed', 'the payment itself stays completed: the money did arrive');

  assert.deepEqual(postings(g, id).map((p) => [p.kind, p.source, p.destination, p.amount]), [
    ['in', 'world', 'tenants:shop:PISPI:available', 5000],
    ['refund', 'tenants:shop:PISPI:available', 'world', 5000],
  ], 'one refund posting: what the product held goes back out');

  const hooks = g.sqlite.prepare(`SELECT type, payload FROM webhook_deliveries WHERE type = 'payment.refunded'`).all() as { type: string; payload: string }[];
  assert.equal(hooks.length, 1, 'the product is told once');
  assert.equal(JSON.parse(hooks[0]!.payload).data.refund.status, 'refunded');
  const tenantView = (await g.call('GET', `/v1/collections/${id}`)).body;
  assert.equal(tenantView.refund.status, 'refunded');
  assert.ok(tenantView.refund.refundedAt);
  assert.deepEqual(g.events(id).map((e) => e.type).filter((t) => t.startsWith('return') || t === 'returned'), ['return_requested', 'return_initiated', 'returned']);
  assert.equal((await g.admin('GET', `/admin/payments/${id}`)).body.returnable.reason, 'Already returned');
});

test('PI-SPI unreachable: the return stays requested and the cron sends it again (safe: PI-SPI answers a repeat with the return it has)', async () => {
  const g = await setup(PISPI);
  const id = await completed(g);
  putAnswer = () => json({ title: 'Service Unavailable' }, 503);
  const r = await g.admin('POST', `/admin/payments/${id}/return`, { reason: 'Duplicate payment' });
  assert.equal(r.body.returnStatus, 'requested', 'not assumed sent, not assumed failed');
  putAnswer = retour('IRREVOCABLE');
  await reconcileReturns(g.env, Date.now() + 2 * MINUTE);
  assert.equal(retourCalls().length, 2);
  assert.equal(g.row(id).return_status, 'returned');
  assert.equal(postings(g, id).filter((p) => p.kind === 'refund').length, 1);
});

test('a rejected return alerts, books nothing, and can be requested again', async () => {
  const g = await setup(PISPI);
  const id = await completed(g);
  putAnswer = retour('REJETE', 'AC04');
  const r = await g.admin('POST', `/admin/payments/${id}/return`, { reason: 'Customer asked' });
  assert.equal(r.body.returnStatus, 'rejected');
  assert.equal(r.body.returnDetail, 'PI-SPI AC04');
  assert.ok(net.alerts().some((a) => /rejected a return/.test(a.title)));
  assert.equal(postings(g, id).filter((p) => p.kind === 'refund').length, 0);
  assert.equal((await g.call('GET', `/v1/collections/${id}`)).body.refund.status, 'failed');

  putAnswer = retour('IRREVOCABLE');
  const again = await g.admin('POST', `/admin/payments/${id}/return`, { reason: 'Customer asked, second try' });
  assert.equal(again.body.returnStatus, 'returned');
  assert.equal(postings(g, id).filter((p) => p.kind === 'refund').length, 1);
});

test('a payment that arrived for the wrong amount can be sent back: it was never booked, so its return books nothing', async () => {
  const g = await setup(PISPI);
  const a = await g.call('POST', '/v1/collections', { reference: 'q-1', amount: 5000, rail: 'pispi_qr' });
  received.push(pay({ txId: a.body.id.toUpperCase(), montant: 4000, end2endId: 'E2E-WRONG' }));
  g.sqlite.prepare('UPDATE payments SET last_checked_at = NULL').run();
  await g.call('GET', `/v1/collections/${a.body.id}`);
  assert.equal(g.row(a.body.id).status, 'processing');
  assert.deepEqual((await g.admin('GET', `/admin/payments/${a.body.id}`)).body.returnable, { ok: true, end2endId: 'E2E-WRONG' });

  putAnswer = retour('IRREVOCABLE');
  const r = await g.admin('POST', `/admin/payments/${a.body.id}/return`, { reason: 'Paid 4000 instead of 5000' });
  assert.equal(r.body.returnStatus, 'returned');
  assert.equal(new URL(retourCalls()[0]!.url).pathname, '/BFC999/paiements/E2E-WRONG/retours');
  assert.equal(postings(g, a.body.id).length, 0, 'nothing in, nothing out');
});

test('what cannot be returned, and a received payment is returned for one payment only', async () => {
  const g = await setup(PISPI);
  const nothing = await g.call('POST', '/v1/collections', { reference: 'q-0', amount: 5000, rail: 'pispi_qr' });
  assert.equal((await g.admin('POST', `/admin/payments/${nothing.body.id}/return`, { reason: 'x' })).body.error.message, 'Nothing was received for this payment');
  const id = await completed(g);
  assert.equal((await g.admin('POST', `/admin/payments/${id}/return`, {})).body.error.code, 'invalid_reason');

  // completed by an operator (no PI-SPI settlement to send back)
  const m = await g.call('POST', '/v1/collections', { reference: 'q-m', amount: 5000, rail: 'pispi_qr' });
  await g.admin('POST', `/admin/payments/${m.body.id}/resolve`, { outcome: 'completed', note: 'paid at the counter' });
  assert.match((await g.admin('GET', `/admin/payments/${m.body.id}`)).body.returnable.reason, /by hand/);

  // switched off
  const off = await setup({ ...PISPI, PISPI_RETURNS: 'false' });
  const id2 = await completed(off, 'q-2');
  assert.match((await off.admin('POST', `/admin/payments/${id2}/return`, { reason: 'x' })).body.error.message, /switched off/);
  assert.equal(retourCalls().length, 0, 'nothing was ever sent');
});
