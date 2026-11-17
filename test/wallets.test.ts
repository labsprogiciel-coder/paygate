import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { silence } from './helpers/env.ts';
import { COLLECT, PAYOUT, setup } from './helpers/gateway.ts';

let restore: () => void;
beforeEach(() => { restore = silence(); });
afterEach(() => restore());

const SEN = '+221770000001';
const enc = encodeURIComponent;

test('a new product starts with every active wallet, both ways, and each payment records the wallet it went through', async () => {
  const g = await setup();
  const me = (await g.call('GET', '/v1/me')).body;
  assert.deepEqual(me.wallets.map((w: any) => [w.id, w.collect, w.payout]), [
    ['BFA:PAWAPAY', true, true], ['CIV:PAWAPAY', true, true], ['SEN:PAWAPAY', true, true], ['CIV:PISPI', true, true],
  ]);
  const c = await g.call('POST', '/v1/collections', COLLECT);
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.equal(g.row(c.body.id).wallet_id, 'CIV:PAWAPAY');
  const s = await g.call('POST', '/v1/disbursements', { ...PAYOUT, reference: 'p-sen', phone: SEN });
  assert.equal(g.row(s.body.id).wallet_id, 'SEN:PAWAPAY', 'the wallet of the phone\'s country');
  assert.equal((await g.admin('GET', `/admin/payments/${c.body.id}`)).body.walletId, 'CIV:PAWAPAY');
});

test('a product can only use the wallets enabled for it, per direction: refused before anything is recorded or sent', async () => {
  const g = await setup();
  const r = await g.admin('PUT', `/admin/tenants/shop/wallets/${enc('CIV:PAWAPAY')}`, { collect: true, payout: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.find((w: any) => w.id === 'CIV:PAWAPAY'), { id: 'CIV:PAWAPAY', rail: 'PAWAPAY', country: 'CIV', label: 'pawaPay Côte d\'Ivoire', status: 'active', collect: true, payout: false });

  const p = await g.call('POST', '/v1/disbursements', PAYOUT);
  assert.equal(p.status, 422);
  assert.equal(p.body.error.code, 'wallet_not_enabled');
  assert.equal(p.body.error.wallet, 'CIV:PAWAPAY');
  assert.equal(g.sqlite.prepare(`SELECT COUNT(*) AS n FROM payments`).get()!.n, 0, 'nothing recorded');
  assert.equal(g.sqlite.prepare(`SELECT COUNT(*) AS n FROM payment_events`).get()!.n, 0, 'nothing started');
  assert.equal((await g.call('POST', '/v1/collections', COLLECT)).status, 201, 'collecting is still allowed');
  assert.equal((await g.call('POST', '/v1/disbursements', { ...PAYOUT, reference: 'p-sen', phone: SEN })).status, 201, 'another country is its own wallet');

  // /v1/methods says so before the product shows the option
  const m = (await g.call('GET', `/v1/methods?direction=disburse&operator=orange&phone=${enc(PAYOUT.phone)}&amount=5000`)).body;
  assert.equal(m.available, false);
  assert.match(m.reason, /cannot pay out through the CIV:PAWAPAY wallet/);
  assert.equal((await g.call('GET', `/v1/methods?operator=orange&phone=${enc(COLLECT.phone)}`)).body.available, true);

  // both off removes it; another product is not affected
  await g.admin('PUT', `/admin/tenants/shop/wallets/CIV:PAWAPAY`, { collect: false, payout: false });
  assert.equal((await g.call('POST', '/v1/collections', { ...COLLECT, reference: 'c-2' })).body.error.code, 'wallet_not_enabled');
  const other = await g.addTenant('school');
  assert.equal((await other('POST', '/v1/disbursements', PAYOUT)).status, 201);

  assert.equal((await g.admin('PUT', '/admin/tenants/shop/wallets/CIV:PAWAPAY', { collect: true })).status, 400);
  assert.equal((await g.admin('PUT', '/admin/tenants/shop/wallets/MLI:PAWAPAY', { collect: true, payout: true })).status, 404);
  assert.equal((await g.admin('PUT', '/admin/tenants/nobody/wallets/CIV:PAWAPAY', { collect: true, payout: true })).status, 404);
});

test('an idempotent repeat of a payment already made still answers after its wallet is narrowed', async () => {
  const g = await setup();
  const c = await g.call('POST', '/v1/collections', COLLECT);
  await g.admin('PUT', '/admin/tenants/shop/wallets/CIV:PAWAPAY', { collect: false, payout: true });
  const again = await g.call('POST', '/v1/collections', COLLECT);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.id, c.body.id);
});

test('a wallet switched off takes no new payment from anyone; operators register, rename and list wallets', async () => {
  const g = await setup();
  const off = await g.admin('PATCH', '/admin/wallets/CIV:PAWAPAY', { status: 'off' });
  assert.equal(off.body.status, 'off');
  const r = await g.call('POST', '/v1/collections', COLLECT);
  assert.equal(r.body.error.code, 'wallet_not_enabled');
  assert.match(r.body.error.message, /switched off/);
  await g.admin('PATCH', '/admin/wallets/CIV:PAWAPAY', { status: 'active' });
  assert.equal((await g.call('POST', '/v1/collections', COLLECT)).status, 201);

  const made = await g.admin('POST', '/admin/wallets', { id: 'sen:pispi', label: 'PI-SPI Senegal', secretsPrefix: 'PI_SPI_SEN' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual([made.body.id, made.body.rail, made.body.country, made.body.status, made.body.secrets_prefix], ['SEN:PISPI', 'PISPI', 'SEN', 'active', 'PI_SPI_SEN']);
  assert.equal((await g.admin('POST', '/admin/wallets', { id: 'SEN:PISPI' })).status, 409);
  assert.equal((await g.admin('POST', '/admin/wallets', { id: 'FRA:PAWAPAY' })).body.error.code, 'invalid_wallet');
  assert.equal((await g.admin('POST', '/admin/wallets', { id: 'MLI:PISPI', secretsPrefix: 'lower-case' })).body.error.code, 'invalid_wallet');
  assert.equal((await g.admin('PATCH', '/admin/wallets/CIV:PAWAPAY', { status: 'paused' })).status, 400);
  assert.equal((await g.admin('PATCH', '/admin/wallets/MLI:PISPI', { label: 'x' })).status, 404);
  assert.equal((await g.admin('PATCH', '/admin/wallets/SEN:PISPI', { label: 'Senegal bank' })).body.label, 'Senegal bank');

  const list = (await g.admin('GET', '/admin/wallets')).body.data;
  const sen = list.find((w: any) => w.id === 'SEN:PISPI');
  assert.deepEqual(sen.tenants, [], 'a new wallet is enabled for no product until an operator says so');
  assert.deepEqual(list.find((w: any) => w.id === 'CIV:PAWAPAY').tenants, [{ id: 'shop', collect: true, payout: true }]);
  // a product created now gets the new wallet too (every active wallet)
  await g.addTenant('school');
  assert.deepEqual((await g.admin('GET', '/admin/tenants/school/wallets')).body.data.find((w: any) => w.id === 'SEN:PISPI'), { id: 'SEN:PISPI', rail: 'PISPI', country: 'SEN', label: 'Senegal bank', status: 'active', collect: true, payout: true });
  assert.equal((await g.call('GET', '/v1/me', undefined, null)).status, 401, 'the tenant API still needs a key');
});

test('migration 0005: products that exist keep every wallet, and payments already made are placed in theirs', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const db = new DatabaseSync(':memory:');
  for (const f of files.filter((f) => f < '0005')) db.exec(readFileSync(join(dir, f), 'utf8'));
  db.exec(`INSERT INTO tenants (id, name, created_at) VALUES ('old', 'Old', 1)`);
  const pay = db.prepare(`INSERT INTO payments (id, tenant_id, kind, reference, rail, operator, country, counterparty, amount, status, provider, request_hash, created_at, updated_at)
    VALUES (?, 'old', ?, ?, ?, ?, ?, '+x', 100, 'completed', ?, 'h', 1, 1)`);
  pay.run('pg1', 'collection', 'r1', 'mobile_money', 'orange', 'SEN', 'pawapay');
  pay.run('pg2', 'collection', 'r2', 'pispi_qr', null, null, 'pispi');
  pay.run('pg3', 'disbursement', 'r3', 'mobile_money', 'orange', 'BFA', 'pawapay');
  for (const f of files.filter((f) => f >= '0005')) db.exec(readFileSync(join(dir, f), 'utf8'));
  assert.deepEqual(db.prepare(`SELECT id, wallet_id FROM payments ORDER BY id`).all().map((r) => [r.id, r.wallet_id]), [['pg1', 'SEN:PAWAPAY'], ['pg2', 'CIV:PISPI'], ['pg3', 'BFA:PAWAPAY']]);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM tenant_wallets WHERE tenant_id = 'old' AND collect = 1 AND payout = 1`).get()!.n, 4);
});
