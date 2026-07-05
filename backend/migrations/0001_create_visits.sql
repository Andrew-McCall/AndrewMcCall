-- Distinguishes the source of a visit: the nginx static mirror vs a
-- client-side JavaScript ping.
CREATE TYPE visit_kind AS ENUM ('static', 'js');

-- User-agent strings are long and highly repetitive, so they are stored once
-- here and referenced by id from `visits` rather than duplicated on every row.
CREATE TABLE IF NOT EXISTS user_agents (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_agent TEXT NOT NULL UNIQUE
);

-- Records a single page visit.
CREATE TABLE IF NOT EXISTS visits (
    id            UUID PRIMARY KEY,
    created_at    BIGINT NOT NULL, -- unix timestamp (seconds)
    kind          visit_kind NOT NULL,
    client_ip     TEXT NOT NULL,
    user_agent_id BIGINT NOT NULL REFERENCES user_agents (id)
);

CREATE INDEX IF NOT EXISTS visits_created_at_idx ON visits (created_at);
CREATE INDEX IF NOT EXISTS visits_client_ip_user_agent_id_idx ON visits (client_ip, user_agent_id);
