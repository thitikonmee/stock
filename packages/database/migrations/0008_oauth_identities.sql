-- Links a Google/Facebook identity to a `users` row (global identity table, no tenant_id — same
-- as `users` itself, so no RLS policy needed here; the rls-coverage test only checks tables that
-- have a tenant_id column). The primary account-match on OAuth sign-in is still `users.email`
-- (already UNIQUE citext); this table is for fast provider-id lookup and future multi-provider
-- linking, not the match itself.
CREATE TABLE user_identities (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         text NOT NULL CHECK (provider IN ('GOOGLE','FACEBOOK')),
  provider_user_id text NOT NULL,
  email            citext,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_user_id)
);
CREATE INDEX user_identities_user_id_idx ON user_identities (user_id);
