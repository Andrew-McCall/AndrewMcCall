-- Distinguishes the source of a visit: the nginx static mirror vs a
-- client-side JavaScript ping.
CREATE TYPE visit_kind AS ENUM ('static', 'js', 'secret');

-- User-agent strings are long and highly repetitive, so they are stored once
-- here and referenced by id from `visits` and `auth_log` rather than
-- duplicated on every row.
CREATE TABLE IF NOT EXISTS user_agents (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_agent TEXT NOT NULL UNIQUE
);

-- Records a single page visit.
CREATE TABLE IF NOT EXISTS visits (
    id            UUID PRIMARY KEY,
    created_at    TIMESTAMPTZ NOT NULL,
    kind          visit_kind NOT NULL,
    client_ip     TEXT NOT NULL,
    user_agent_id BIGINT NOT NULL REFERENCES user_agents (id)
);

CREATE INDEX IF NOT EXISTS visits_created_at_idx ON visits (created_at);
CREATE INDEX IF NOT EXISTS visits_client_ip_user_agent_id_idx ON visits (client_ip, user_agent_id);

-- Application users. A user authenticates with a name + pin, and may enrol a
-- TOTP authenticator as a second factor (RFC 6238). There is no `last_login`
-- column: each token use is recorded in `auth_log` (see below), so the newest
-- such row for a user is their last login.
CREATE TABLE IF NOT EXISTS users (
    id           UUID PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE,
    pin          TEXT NOT NULL,        -- hashed pin, never stored in plaintext
    totp_secret  TEXT,                 -- base32 TOTP shared secret, null until 2FA is enrolled
    created_at   TIMESTAMPTZ NOT NULL
);

-- Authentication tokens issued to a user. A user may hold several tokens
-- (one per session/device); deleting a user cascades to their tokens.
CREATE TABLE IF NOT EXISTS user_tokens (
    id         UUID PRIMARY KEY,
    user_id    UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token      TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ             -- null if the token never expires
);

CREATE INDEX IF NOT EXISTS user_tokens_user_id_idx ON user_tokens (user_id);

-- Records a single authenticated request. Mirrors `visits`, but instead of a
-- `kind` it carries the `uri` that was accessed and the `user_id` behind the
-- token. Shares the deduplicated `user_agents` table. The newest row for a
-- user is that user's last login.
CREATE TABLE IF NOT EXISTS auth_log (
    id            UUID PRIMARY KEY,
    created_at    TIMESTAMPTZ NOT NULL,
    uri           TEXT NOT NULL,
    user_id       UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    client_ip     TEXT NOT NULL,
    user_agent_id BIGINT NOT NULL REFERENCES user_agents (id)
);

CREATE INDEX IF NOT EXISTS auth_log_user_id_created_at_idx ON auth_log (user_id, created_at);
