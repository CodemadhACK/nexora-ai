-- Nexora AI platform schema.
--
-- Design rules this file follows:
--   * The backend is the source of truth. Nothing here is writable by a client.
--   * Money is stored in the smallest unit (paise) as INTEGER. Never float.
--   * Credits are an append-only ledger. users.credit_balance is a cache that is
--     only ever written in the same transaction as a credit_transactions row.
--   * Provider secrets are stored encrypted (AES-256-GCM); see lib/crypto.js.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ───────────────────────── identity ─────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash   TEXT NOT NULL,
  name            TEXT NOT NULL DEFAULT '',
  phone           TEXT NOT NULL DEFAULT '',
  -- Four fixed roles, so a CHECK beats a join table. Server-side only.
  role            TEXT NOT NULL DEFAULT 'USER'
                    CHECK (role IN ('SUPER_ADMIN', 'ADMIN', 'SUPPORT', 'USER')),
  status          TEXT NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DELETED')),
  -- Cache of the credit ledger. Source of truth is credit_transactions.
  credit_balance  INTEGER NOT NULL DEFAULT 0,
  email_verified  INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_role   ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- Opaque session tokens. Only the SHA-256 of the token is stored, so a database
-- leak does not hand over live sessions.
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  user_agent   TEXT NOT NULL DEFAULT '',
  ip           TEXT NOT NULL DEFAULT '',
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ───────────────────────── plans & entitlements ─────────────────────────

CREATE TABLE IF NOT EXISTS plans (
  id                TEXT PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  -- Paise. 99900 = ₹999.00
  price_minor       INTEGER NOT NULL DEFAULT 0,
  currency          TEXT NOT NULL DEFAULT 'INR',
  billing_period    TEXT NOT NULL DEFAULT 'MONTHLY'
                      CHECK (billing_period IN ('MONTHLY', 'YEARLY', 'ONE_TIME', 'FREE')),
  credits_granted   INTEGER NOT NULL DEFAULT 0,
  -- Hard caps, enforced server-side. -1 means unlimited.
  max_interviews    INTEGER NOT NULL DEFAULT -1,
  max_ai_requests   INTEGER NOT NULL DEFAULT -1,
  is_public         INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'ACTIVE'
                      CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- What a plan is allowed to do. Separate from the plan row so capabilities can
-- be added without a migration, and so entitlement checks are a single lookup.
CREATE TABLE IF NOT EXISTS plan_entitlements (
  plan_id     TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  feature_key TEXT NOT NULL,
  -- 'BOOL' -> enabled/disabled, 'LIMIT' -> numeric cap, 'LIST' -> JSON array
  value       TEXT NOT NULL,
  PRIMARY KEY (plan_id, feature_key)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id               TEXT NOT NULL REFERENCES plans(id),
  status                TEXT NOT NULL
                          CHECK (status IN ('PENDING','ACTIVE','PAST_DUE','CANCELLED','EXPIRED')),
  cashfree_subscription_id TEXT,
  start_date            TEXT,
  next_billing_date     TEXT,
  expiry_date           TEXT,
  cancel_at_period_end  INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_subs_user   ON subscriptions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_subs_expiry ON subscriptions(expiry_date);

-- ───────────────────────── credits ─────────────────────────

-- Append-only. A balance is never overwritten without a row here explaining why.
CREATE TABLE IF NOT EXISTS credit_transactions (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Positive grants, negative consumption.
  delta          INTEGER NOT NULL,
  balance_after  INTEGER NOT NULL,
  reason         TEXT NOT NULL,
  kind           TEXT NOT NULL
                   CHECK (kind IN ('GRANT','CONSUME','REFUND','ADMIN_ADJUST','EXPIRY')),
  -- Free-form link to whatever caused it (payment order id, ai_request id…).
  ref_type       TEXT,
  ref_id         TEXT,
  -- Guards double-grants: one row per (user, idempotency_key).
  idempotency_key TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_credit_tx_user ON credit_transactions(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_tx_idem
  ON credit_transactions(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- What each action costs. Admin-editable; nothing in the frontend knows these.
CREATE TABLE IF NOT EXISTS credit_costs (
  action_key   TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  credits      INTEGER NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ───────────────────────── AI configuration ─────────────────────────

CREATE TABLE IF NOT EXISTS ai_providers (
  id              TEXT PRIMARY KEY,
  -- Matches a module id in the repo's providers/ registry (gemini|openai|anthropic).
  provider_key    TEXT NOT NULL,
  label           TEXT NOT NULL,
  -- AES-256-GCM ciphertext. Never leaves the server.
  api_key_cipher  TEXT,
  -- Last 4 characters, for display as sk-••••1234.
  api_key_last4   TEXT NOT NULL DEFAULT '',
  enabled         INTEGER NOT NULL DEFAULT 1,
  priority        INTEGER NOT NULL DEFAULT 100,
  health_status   TEXT NOT NULL DEFAULT 'UNKNOWN'
                    CHECK (health_status IN ('UNKNOWN','HEALTHY','DEGRADED','DOWN')),
  health_checked_at TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_models (
  id                TEXT PRIMARY KEY,
  provider_id       TEXT NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  model_key         TEXT NOT NULL,
  label             TEXT NOT NULL,
  -- Micro-rupees per 1M tokens, so costs stay integers.
  input_cost_micro  INTEGER NOT NULL DEFAULT 0,
  output_cost_micro INTEGER NOT NULL DEFAULT 0,
  max_tokens        INTEGER NOT NULL DEFAULT 4096,
  context_window    INTEGER NOT NULL DEFAULT 128000,
  reasoning         INTEGER NOT NULL DEFAULT 0,
  speed_rating      INTEGER NOT NULL DEFAULT 3 CHECK (speed_rating BETWEEN 1 AND 5),
  enabled           INTEGER NOT NULL DEFAULT 1,
  priority          INTEGER NOT NULL DEFAULT 100,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider_id, model_key)
);

-- Maps an intent (+ optional complexity) to an ordered model chain. Editing a
-- rule changes routing immediately — no frontend deploy, no code change.
CREATE TABLE IF NOT EXISTS ai_routing_rules (
  id           TEXT PRIMARY KEY,
  intent       TEXT NOT NULL,
  complexity   TEXT NOT NULL DEFAULT 'ANY'
                 CHECK (complexity IN ('ANY','SIMPLE','MEDIUM','COMPLEX')),
  -- JSON array of ai_models.id, tried in order. This is the fallback chain.
  model_chain  TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  notes        TEXT NOT NULL DEFAULT '',
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (intent, complexity)
);

-- One row per AI call attempt, including failed ones. This is what makes
-- "what does the platform cost to run" answerable.
CREATE TABLE IF NOT EXISTS ai_requests (
  id             TEXT PRIMARY KEY,
  user_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  feature        TEXT NOT NULL,
  intent         TEXT NOT NULL DEFAULT '',
  complexity     TEXT NOT NULL DEFAULT '',
  provider_id    TEXT REFERENCES ai_providers(id) ON DELETE SET NULL,
  model_id       TEXT REFERENCES ai_models(id) ON DELETE SET NULL,
  provider_key   TEXT NOT NULL DEFAULT '',
  model_key      TEXT NOT NULL DEFAULT '',
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  total_tokens   INTEGER NOT NULL DEFAULT 0,
  -- 0 when the provider returned real usage, 1 when we estimated from length.
  tokens_estimated INTEGER NOT NULL DEFAULT 0,
  credits_charged INTEGER NOT NULL DEFAULT 0,
  cost_micro     INTEGER NOT NULL DEFAULT 0,
  latency_ms     INTEGER NOT NULL DEFAULT 0,
  success        INTEGER NOT NULL DEFAULT 0,
  error_code     TEXT,
  error_message  TEXT,
  attempt        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_req_user ON ai_requests(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_req_date ON ai_requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_req_prov ON ai_requests(provider_id, created_at DESC);

-- ───────────────────────── prompts ─────────────────────────

CREATE TABLE IF NOT EXISTS prompts (
  id                 TEXT PRIMARY KEY,
  key                TEXT NOT NULL UNIQUE,
  label              TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  active_version_id  TEXT,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompt_versions (
  id          TEXT PRIMARY KEY,
  prompt_id   TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  body        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','ARCHIVED')),
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (prompt_id, version)
);

-- ───────────────────────── feature flags ─────────────────────────

CREATE TABLE IF NOT EXISTS feature_flags (
  key          TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  enabled      INTEGER NOT NULL DEFAULT 0,
  -- JSON array of plan codes the flag is available to. [] means "all plans".
  plan_codes   TEXT NOT NULL DEFAULT '[]',
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ───────────────────────── payments ─────────────────────────

CREATE TABLE IF NOT EXISTS payment_orders (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id           TEXT REFERENCES plans(id),
  kind              TEXT NOT NULL DEFAULT 'SUBSCRIPTION'
                      CHECK (kind IN ('SUBSCRIPTION','CREDIT_PACK')),
  cashfree_order_id TEXT UNIQUE,
  cf_order_id       TEXT,
  -- Snapshot of what the server decided at checkout. The client never sends these.
  amount_minor      INTEGER NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'INR',
  credits_to_grant  INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'CREATED'
                      CHECK (status IN ('CREATED','PENDING','PAID','ACTIVATED','FAILED','CANCELLED','REFUNDED')),
  failure_reason    TEXT,
  activated_at      TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_user   ON payment_orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON payment_orders(status);

CREATE TABLE IF NOT EXISTS payment_transactions (
  id                 TEXT PRIMARY KEY,
  payment_order_id   TEXT NOT NULL REFERENCES payment_orders(id) ON DELETE CASCADE,
  cf_payment_id      TEXT UNIQUE,
  status             TEXT NOT NULL,
  amount_minor       INTEGER NOT NULL DEFAULT 0,
  payment_method     TEXT NOT NULL DEFAULT '',
  payment_group      TEXT NOT NULL DEFAULT '',
  gateway_response   TEXT NOT NULL DEFAULT '{}',
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS refunds (
  id                TEXT PRIMARY KEY,
  payment_order_id  TEXT NOT NULL REFERENCES payment_orders(id) ON DELETE CASCADE,
  cf_refund_id      TEXT,
  amount_minor      INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'PENDING',
  reason            TEXT NOT NULL DEFAULT '',
  credits_clawed_back INTEGER NOT NULL DEFAULT 0,
  created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every webhook Cashfree sends, stored before it is acted on. The UNIQUE
-- constraint is what makes redelivery a no-op instead of a double grant.
CREATE TABLE IF NOT EXISTS webhook_events (
  id             TEXT PRIMARY KEY,
  provider       TEXT NOT NULL DEFAULT 'cashfree',
  event_type     TEXT NOT NULL,
  -- Stable per-event identity: cf_payment_id for payment events.
  dedupe_key     TEXT NOT NULL,
  raw_body       TEXT NOT NULL,
  signature_ok   INTEGER NOT NULL DEFAULT 0,
  processed      INTEGER NOT NULL DEFAULT 0,
  process_error  TEXT,
  received_at    TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at   TEXT,
  UNIQUE (provider, dedupe_key)
);

CREATE TABLE IF NOT EXISTS invoices (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payment_order_id  TEXT REFERENCES payment_orders(id) ON DELETE SET NULL,
  number            TEXT NOT NULL UNIQUE,
  amount_minor      INTEGER NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'INR',
  description       TEXT NOT NULL DEFAULT '',
  issued_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ───────────────────────── platform settings & audit ─────────────────────────

-- Key/value for gateway credentials, maintenance mode, registration policy.
-- `encrypted = 1` means value holds AES-256-GCM ciphertext.
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL DEFAULT '',
  encrypted   INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Append-only. There is no UPDATE or DELETE path to this table in the code.
CREATE TABLE IF NOT EXISTS audit_logs (
  id           TEXT PRIMARY KEY,
  actor_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_email  TEXT NOT NULL DEFAULT '',
  action       TEXT NOT NULL,
  target_type  TEXT NOT NULL DEFAULT '',
  target_id    TEXT NOT NULL DEFAULT '',
  previous_value TEXT,
  new_value    TEXT,
  ip           TEXT NOT NULL DEFAULT '',
  user_agent   TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor   ON audit_logs(actor_id);

-- ───────────────────────── product data ─────────────────────────

CREATE TABLE IF NOT EXISTS interview_sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_title  TEXT NOT NULL DEFAULT '',
  company     TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'TECHNICAL',
  difficulty  TEXT NOT NULL DEFAULT 'MEDIUM',
  status      TEXT NOT NULL DEFAULT 'ACTIVE'
                CHECK (status IN ('ACTIVE','COMPLETED','ABANDONED')),
  score       INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user2 ON interview_sessions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS interview_messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content     TEXT NOT NULL,
  ai_request_id TEXT REFERENCES ai_requests(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_msgs_session ON interview_messages(session_id, created_at);

-- ═══════════════════════ authentication (§48–§53) ═══════════════════════

-- A user may hold several identities (password, google) against one account.
-- Keeping them out of `users` is what makes safe account-linking possible:
-- signing in with Google on an email that already has a password adds a row
-- here rather than creating a second account.
CREATE TABLE IF NOT EXISTS auth_identities (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL CHECK (provider IN ('password','google')),
  -- Google's `sub` claim, which is stable and never reused. NULL for password.
  provider_uid  TEXT,
  email         TEXT NOT NULL DEFAULT '',
  linked_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, provider_uid),
  UNIQUE (user_id, provider)
);

-- Single-use, expiring tokens for email verification and password reset.
-- Only the hash is stored: a database leak must not yield usable reset links.
CREATE TABLE IF NOT EXISTS auth_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('EMAIL_VERIFY','PASSWORD_RESET')),
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id, purpose);

-- Short-lived state for the OAuth authorization-code flow. The `state` value
-- defends against CSRF on the callback; `nonce` binds the ID token to this
-- request. Rows are deleted on use and expire in minutes.
CREATE TABLE IF NOT EXISTS oauth_states (
  state         TEXT PRIMARY KEY,
  nonce         TEXT NOT NULL,
  redirect_to   TEXT NOT NULL DEFAULT '/app',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT NOT NULL
);

-- Every authentication attempt, for lockout and for the user's login history.
CREATE TABLE IF NOT EXISTS login_attempts (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL DEFAULT '',
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  success     INTEGER NOT NULL DEFAULT 0,
  method      TEXT NOT NULL DEFAULT 'password',
  reason      TEXT NOT NULL DEFAULT '',
  ip          TEXT NOT NULL DEFAULT '',
  user_agent  TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_login_email ON login_attempts(email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_user  ON login_attempts(user_id, created_at DESC);

-- ═══════════════════════ profile & context (§54–§59) ═══════════════════════

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  target_role        TEXT NOT NULL DEFAULT '',
  experience_years   INTEGER NOT NULL DEFAULT 0,
  seniority          TEXT NOT NULL DEFAULT '',
  skills             TEXT NOT NULL DEFAULT '[]',
  industries         TEXT NOT NULL DEFAULT '[]',
  target_companies   TEXT NOT NULL DEFAULT '[]',
  preferred_language TEXT NOT NULL DEFAULT 'English',
  preferred_code_language TEXT NOT NULL DEFAULT 'Python',
  answer_length      TEXT NOT NULL DEFAULT 'BALANCED'
                       CHECK (answer_length IN ('CONCISE','BALANCED','DETAILED')),
  answer_tone        TEXT NOT NULL DEFAULT 'NATURAL'
                       CHECK (answer_tone IN ('NATURAL','PROFESSIONAL','CONVERSATIONAL')),
  technical_depth    INTEGER NOT NULL DEFAULT 3 CHECK (technical_depth BETWEEN 1 AND 5),
  onboarded_at       TEXT,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS resumes (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  mime_type     TEXT NOT NULL DEFAULT '',
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  raw_text      TEXT NOT NULL DEFAULT '',
  -- AI-extracted structure, which the user reviews and may correct. Kept
  -- separate from raw_text so an extraction can be re-run without data loss.
  extracted     TEXT NOT NULL DEFAULT '{}',
  extraction_status TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (extraction_status IN ('PENDING','DONE','FAILED','EDITED')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_resumes_user ON resumes(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS job_descriptions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL DEFAULT '',
  company      TEXT NOT NULL DEFAULT '',
  url          TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jd_user ON job_descriptions(user_id, created_at DESC);

-- ═══════════════════════ notifications (§67) ═══════════════════════

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  product_updates    INTEGER NOT NULL DEFAULT 1,
  interview_reminders INTEGER NOT NULL DEFAULT 1,
  -- Payment and security mail is transactional and deliberately not opt-out.
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Outbox rather than direct send: delivery is retryable, auditable, and the
-- request that queued it never blocks on an SMTP round trip.
CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL DEFAULT 'EMAIL',
  template    TEXT NOT NULL,
  payload     TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'QUEUED'
                CHECK (status IN ('QUEUED','SENT','FAILED','SKIPPED')),
  error       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_notif_status ON notifications(status, created_at);

-- ═══════════════════════ two-factor authentication (§53) ═══════════════════════

-- TOTP secrets live in their own table rather than on `users`, so the hot path
-- (every request resolving a session) never loads a secret it does not need.
CREATE TABLE IF NOT EXISTS totp_secrets (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- AES-256-GCM. Reversible because TOTP verification needs the shared secret.
  secret_cipher TEXT NOT NULL,
  -- 0 while enrolling, 1 once a code has been proven. An unconfirmed secret
  -- must never gate a login, or a failed enrolment locks the account out.
  confirmed     INTEGER NOT NULL DEFAULT 0,
  confirmed_at  TEXT,
  -- Rejects replay of a code inside its own 30-second step.
  last_step     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Single-use fallbacks, stored as hashes like any other credential.
CREATE TABLE IF NOT EXISTS recovery_codes (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_recovery_user ON recovery_codes(user_id);

-- A password was accepted but a second factor is still owed. Deliberately not a
-- session: holding one of these grants nothing until the code is verified.
CREATE TABLE IF NOT EXISTS login_challenges (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  attempts    INTEGER NOT NULL DEFAULT 0,
  ip          TEXT NOT NULL DEFAULT '',
  user_agent  TEXT NOT NULL DEFAULT '',
  expires_at  TEXT NOT NULL,
  consumed_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ═══════════════════════ stored files (§56) ═══════════════════════

-- Uploaded bytes, kept out of `resumes` so listing résumés never drags a
-- multi-megabyte blob through SQLite.
CREATE TABLE IF NOT EXISTS file_blobs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,
  mime_type   TEXT NOT NULL DEFAULT '',
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  content     BLOB NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_blobs_user ON file_blobs(user_id);

-- ═══════════════════════ interview scoring (§18) ═══════════════════════

CREATE TABLE IF NOT EXISTS interview_reports (
  session_id      TEXT PRIMARY KEY REFERENCES interview_sessions(id) ON DELETE CASCADE,
  overall_score   INTEGER NOT NULL DEFAULT 0,
  -- JSON: { technical, problem_solving, communication, depth, confidence }
  breakdown       TEXT NOT NULL DEFAULT '{}',
  strengths       TEXT NOT NULL DEFAULT '[]',
  improvements    TEXT NOT NULL DEFAULT '[]',
  next_questions  TEXT NOT NULL DEFAULT '[]',
  summary         TEXT NOT NULL DEFAULT '',
  ai_request_id   TEXT REFERENCES ai_requests(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
