-- Returning a received PI-SPI payment to its payer (PUT /paiements/{end2endId}/retours), started by an operator. One return per payment.
--   return_status: requested (asked; PI-SPI may not have it yet) -> initiated (PI-SPI is sending it) -> returned (irrevocable) | rejected
-- A rejected return can be requested again. return_ref is the end2endId of the received payment that is sent back: the payment's own
-- settlement (provider_ref) when it completed, or the mismatched payment that arrived for it.
ALTER TABLE payments ADD COLUMN return_status TEXT;
ALTER TABLE payments ADD COLUMN return_ref TEXT;
ALTER TABLE payments ADD COLUMN return_reason TEXT;        -- the operator's reason, kept with the payment
ALTER TABLE payments ADD COLUMN return_detail TEXT;        -- PI-SPI's rejection reason, logs and operators only
ALTER TABLE payments ADD COLUMN return_requested_at INTEGER;
ALTER TABLE payments ADD COLUMN return_checked_at INTEGER;
ALTER TABLE payments ADD COLUMN returned_at INTEGER;
CREATE INDEX IF NOT EXISTS payments_returning ON payments (return_status, return_checked_at) WHERE return_status IN ('requested', 'initiated');
CREATE UNIQUE INDEX IF NOT EXISTS payments_return_ref ON payments (return_ref) WHERE return_ref IS NOT NULL;
