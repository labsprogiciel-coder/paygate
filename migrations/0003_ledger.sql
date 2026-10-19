-- The books: one double-entry posting per money movement (see src/ledger.ts). The journal of who owns what in the shared wallets, and the
-- outbox to the Formance ledger: posted_at is set once Formance has the transaction (its reference is this reference, so a retry never books twice).
CREATE TABLE IF NOT EXISTS ledger_postings (
  reference    TEXT PRIMARY KEY,                -- <payment id>:<kind>, or adj_<id> for an operator's adjustment
  payment_id   TEXT,
  tenant_id    TEXT,
  pool         TEXT NOT NULL,                   -- the wallet: CIV, SEN, BFA (pawaPay) or PISPI (the bank account)
  kind         TEXT NOT NULL,                   -- in | hold | out | release | adjust
  source       TEXT NOT NULL,                   -- Formance account addresses, or world
  destination  TEXT NOT NULL,
  amount       INTEGER NOT NULL,                -- whole XOF
  asset        TEXT NOT NULL,
  note         TEXT,
  created_at   INTEGER NOT NULL,
  posted_at    INTEGER,                         -- null until Formance has it
  ledger_tx_id TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT
);
CREATE INDEX IF NOT EXISTS ledger_postings_pending ON ledger_postings (posted_at, created_at);
CREATE INDEX IF NOT EXISTS ledger_postings_payment ON ledger_postings (payment_id);
