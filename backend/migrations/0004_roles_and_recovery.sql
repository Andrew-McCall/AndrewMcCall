-- Adds an authorization role to users and a store for TOTP recovery codes.
--
-- `user_role` distinguishes ordinary users from administrators. Only admins may
-- create users (see the `/admin` endpoints); everyone defaults to 'standard'.
CREATE TYPE user_role AS ENUM ('standard', 'admin');

ALTER TABLE users ADD COLUMN role user_role NOT NULL DEFAULT 'standard';

-- One-time recovery codes, a fallback for a user who has enrolled TOTP but lost
-- their authenticator. Codes are stored hashed (SHA-256), never in plaintext —
-- exactly like `users.pin` — and are shown to the user only once, at the moment
-- 2FA is enabled. Consuming a code stamps `used_at` so it can never be reused;
-- deleting a user (or disabling their 2FA) removes their codes.
CREATE TABLE IF NOT EXISTS user_recovery_codes (
    id         UUID PRIMARY KEY,
    user_id    UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    code_hash  TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ             -- null until the code is redeemed
);

CREATE INDEX IF NOT EXISTS user_recovery_codes_user_id_idx ON user_recovery_codes (user_id);
