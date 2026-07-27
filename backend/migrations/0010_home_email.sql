-- Add the "Email" row to the home-page "Now" details (whitelisted in
-- `site::DETAILS`). Seeded with the value directly so it renders on the public
-- home page without needing an admin edit first. Rendered as plain text, not a
-- link: the url field only accepts http(s)/relative values (see `clean_url`), so
-- a mailto: there would be rejected on the admin editor's next save.
INSERT INTO home_details (key, value) VALUES
    ('email', 'andrewdavidmccall@hotmail.com')
ON CONFLICT (key) DO NOTHING;
