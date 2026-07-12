export const SCHEMA_SQL = `
-- Opportunities: every scan result worth recording, whether or not executed
CREATE TABLE IF NOT EXISTS opportunities (
  id BIGSERIAL PRIMARY KEY,
  pair_id TEXT NOT NULL,
  base_symbol TEXT NOT NULL,
  quote_symbol TEXT NOT NULL,
  source_buy TEXT NOT NULL,
  source_sell TEXT NOT NULL,
  price_buy NUMERIC NOT NULL,
  price_sell NUMERIC NOT NULL,
  spread_bps NUMERIC NOT NULL,
  est_liquidity_usd NUMERIC,
  est_gas_cost_usd NUMERIC,
  est_protocol_fee_usd NUMERIC,
  est_net_profit_usd NUMERIC NOT NULL,
  meets_threshold BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_opportunities_pair_created
  ON opportunities (pair_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_opportunities_meets_threshold
  ON opportunities (meets_threshold, created_at DESC);

-- Trades: actual execution attempts (successful or failed)
CREATE TABLE IF NOT EXISTS trades (
  id BIGSERIAL PRIMARY KEY,
  opportunity_id BIGINT REFERENCES opportunities(id),
  pair_id TEXT NOT NULL,
  status TEXT NOT NULL,
  tx_hash TEXT,
  position_size_usd NUMERIC NOT NULL,
  expected_profit_usd NUMERIC NOT NULL,
  actual_profit_usd NUMERIC,
  gas_used NUMERIC,
  gas_cost_usd NUMERIC,
  protocol_fee_usd NUMERIC,
  error_message TEXT,
  submitted_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trades_status_created
  ON trades (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trades_pair_created
  ON trades (pair_id, created_at DESC);

-- Sweeps: transfers of profit from execution wallet to treasury/cold wallet
CREATE TABLE IF NOT EXISTS sweeps (
  id BIGSERIAL PRIMARY KEY,
  token_symbol TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  amount_usd NUMERIC,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  tx_hash TEXT,
  status TEXT NOT NULL,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sweeps_status_created
  ON sweeps (status, created_at DESC);

-- Circuit breaker events: for audit trail of halts/resumes
CREATE TABLE IF NOT EXISTS circuit_breaker_events (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;