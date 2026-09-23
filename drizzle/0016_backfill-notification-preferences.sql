-- Backfill (plans/2026-09-05-daily-portfolio-summary-push.md): every user who
-- already registered a push token was, until this table existed, receiving
-- price alerts unconditionally — so their preference row says exactly that.
-- After this runs, a missing row means both-off, uniformly, forever: no
-- "token exists" fallback for future readers of the table to know about.
INSERT INTO notification_preferences (user_id, price_alerts)
SELECT DISTINCT user_id, true FROM push_tokens
ON CONFLICT DO NOTHING;
