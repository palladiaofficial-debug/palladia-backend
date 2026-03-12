-- Migration 008: remove plaintext pin_code column from sites
-- PIN is now stored exclusively as bcrypt hash in pin_hash column.
-- Existing pin_hash values (HMAC-SHA256) must be re-hashed via set-site-pin.js
-- before this migration is run, as bcrypt hashes are not backwards-compatible.

-- Drop plaintext PIN column (was added in 002_multi_tenant.sql)
ALTER TABLE sites DROP COLUMN IF EXISTS pin_code;
