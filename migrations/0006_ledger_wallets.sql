-- The books by wallet (PRO-37): every pool is a wallet id <country>:<rail>, so two PI-SPI accounts in different countries never share a pool,
-- and "every rail in one country" is one address pattern.
--   tenants:{tenant}:{pool}:available|held   ->  tenants:{tenant}:{country}:{rail}:available|held
--   pool:{pool}:unallocated                  ->  pool:{country}:{rail}:unallocated
-- where a pawaPay country pool CIV becomes CIV:PAWAPAY, and PISPI (the one PI-SPI account, Côte d'Ivoire) becomes CIV:PISPI.
-- Only rows still in the old shape are rewritten (no ':' in the pool), so running it twice changes nothing. Every rewritten posting is sent to
-- Formance again, to the new ledger (FORMANCE_LEDGER, default paygate-v2), under its unchanged reference: old and new addresses never mix.

-- PI-SPI payments record their country too (mobile money ones have the phone's)
UPDATE payments SET country = substr(wallet_id, 1, 3) WHERE country IS NULL AND wallet_id IS NOT NULL;

UPDATE ledger_postings SET
  source      = CASE WHEN source = 'world' THEN source ELSE replace(source, ':' || pool || ':', ':' || (CASE pool WHEN 'PISPI' THEN 'CIV:PISPI' ELSE pool || ':PAWAPAY' END) || ':') END,
  destination = CASE WHEN destination = 'world' THEN destination ELSE replace(destination, ':' || pool || ':', ':' || (CASE pool WHEN 'PISPI' THEN 'CIV:PISPI' ELSE pool || ':PAWAPAY' END) || ':') END,
  pool        = CASE pool WHEN 'PISPI' THEN 'CIV:PISPI' ELSE pool || ':PAWAPAY' END,
  posted_at = NULL, ledger_tx_id = NULL, attempts = 0, last_error = NULL
WHERE pool NOT LIKE '%:%';
