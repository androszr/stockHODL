-- Null the profile stamp so every already-synced instrument is stale-eligible
-- once. Without this, a fresh stamp plus null new columns would read as
-- "asked, vendor has none" for up to 30 days (the timestamp-disambiguates-a-null
-- doctrine). Old code re-syncing sector in the deploy window is harmless.
UPDATE instruments SET profile_synced_at = NULL;
