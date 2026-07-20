-- Records every login attempt (success or failure) for audit, and backs the
-- rolling-window IP ban: an IP with >= LOGIN_ATTEMPT_LIMIT distinct failed
-- pin_hash values in the trailing 24h is banned until enough of those rows
-- age out past 24h. pin_hash is sha256 of the submitted PIN (existing
-- sha256_hex helper) -- it exists only to de-duplicate repeated identical
-- wrong guesses, never to look up or verify a user.
--
-- user_id is null when no user's PIN matched at all; it is set when the PIN
-- matched but a later factor (TOTP/recovery) then failed -- that still counts
-- as a failed attempt with a distinct pin_hash. Set null (not cascaded) on
-- user deletion so the audit trail survives the user being removed.
CREATE TABLE IF NOT EXISTS login_attempts (
    id            UUID PRIMARY KEY,
    created_at    TIMESTAMPTZ NOT NULL,
    client_ip     TEXT NOT NULL,
    pin_hash      TEXT NOT NULL,
    success       BOOLEAN NOT NULL,
    user_id       UUID REFERENCES users (id) ON DELETE SET NULL,
    user_agent_id BIGINT NOT NULL REFERENCES user_agents (id)
);

-- Serves the ban-check query directly: filters to failures, then ranges on
-- (client_ip, created_at) so COUNT(DISTINCT pin_hash) scans a small slice.
CREATE INDEX IF NOT EXISTS login_attempts_failed_ip_time_idx
    ON login_attempts (client_ip, created_at) WHERE NOT success;
