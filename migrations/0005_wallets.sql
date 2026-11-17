-- The wallets registry: every real account money sits in, named, with a country, and switched on per product.
--   id: <country>:<rail>, e.g. CIV:PAWAPAY (the pawaPay wallet in Côte d'Ivoire) or CIV:PISPI (the PI-SPI bank account in Côte d'Ivoire)
--   status: active | off (an off wallet takes no new payment; payments already on their way still settle)
--   secrets_prefix: names this wallet's secrets once there are several accounts per rail (PRO-39); never a secret value
CREATE TABLE IF NOT EXISTS wallets (
  id             TEXT PRIMARY KEY,
  rail           TEXT NOT NULL,                 -- PAWAPAY | PISPI
  country        TEXT NOT NULL,                 -- CIV | SEN | BFA
  currency       TEXT NOT NULL DEFAULT 'XOF',
  label          TEXT,
  status         TEXT NOT NULL DEFAULT 'active',
  secrets_prefix TEXT,
  created_at     INTEGER NOT NULL
);

-- Which products may collect or pay out through which wallets. No row: the product cannot use the wallet.
CREATE TABLE IF NOT EXISTS tenant_wallets (
  tenant_id  TEXT NOT NULL REFERENCES tenants (id),
  wallet_id  TEXT NOT NULL REFERENCES wallets (id),
  collect    INTEGER NOT NULL DEFAULT 1,
  payout     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, wallet_id)
);

-- Today's wallets: pawaPay in three countries, and the one PI-SPI account (Côte d'Ivoire)
INSERT OR IGNORE INTO wallets (id, rail, country, label, created_at) VALUES
  ('CIV:PAWAPAY', 'PAWAPAY', 'CIV', 'pawaPay Côte d''Ivoire', 0),
  ('SEN:PAWAPAY', 'PAWAPAY', 'SEN', 'pawaPay Senegal', 0),
  ('BFA:PAWAPAY', 'PAWAPAY', 'BFA', 'pawaPay Burkina Faso', 0),
  ('CIV:PISPI', 'PISPI', 'CIV', 'PI-SPI Côte d''Ivoire', 0);

-- Products that exist today keep doing what they do: every wallet, both directions
INSERT OR IGNORE INTO tenant_wallets (tenant_id, wallet_id, collect, payout, created_at)
  SELECT t.id, w.id, 1, 1, 0 FROM tenants t CROSS JOIN wallets w;

-- Every payment records the wallet it went through
ALTER TABLE payments ADD COLUMN wallet_id TEXT;
UPDATE payments SET wallet_id = country || ':PAWAPAY' WHERE rail = 'mobile_money' AND country IS NOT NULL;
UPDATE payments SET wallet_id = 'CIV:PISPI' WHERE rail IN ('pispi_qr', 'pispi_rtp');
CREATE INDEX IF NOT EXISTS payments_wallet ON payments (wallet_id, created_at);
