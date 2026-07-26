-- Home-page "Now" details: a small key/value store backing the fixed whitelist of
-- display rows (currently reading, building, learning, …) rendered as their own
-- box on the front page. The set of keys and their labels live in code
-- (`site::DETAILS`); only the editable value and an optional link are stored here.
-- Reads are public (via the /home aggregate); writes go through the admin API.
CREATE TABLE IF NOT EXISTS home_details (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL DEFAULT '',
    url        TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the whitelisted keys with empty values so the admin editor has a row to
-- fill in. Unknown keys are ignored on write and never rendered.
INSERT INTO home_details (key) VALUES
    ('currently_reading'),
    ('currently_building'),
    ('currently_learning'),
    ('based_in')
ON CONFLICT (key) DO NOTHING;
