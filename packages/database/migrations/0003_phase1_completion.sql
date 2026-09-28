-- Phase 1 completion: rate limiting, MFA enforcement, API key lookup, POS device registration

-- ---------------------------------------------------------------------------
-- Fixed-window rate limit counters (login, registration ...). UNLOGGED: losing counters on a
-- crash only resets limits, and it avoids WAL for a hot, disposable table. Not tenant data.
-- ---------------------------------------------------------------------------
CREATE UNLOGGED TABLE rate_limit_buckets (
  key          text NOT NULL,
  window_start timestamptz NOT NULL,
  count        int NOT NULL,
  PRIMARY KEY (key, window_start)
);

-- ---------------------------------------------------------------------------
-- MFA enforcement: members holding dangerous permissions must enrol 2FA after this date.
-- New tenants get a 7-day grace period (set at signup); existing tenants get 7 days from now.
-- ---------------------------------------------------------------------------
ALTER TABLE tenants ADD COLUMN mfa_enforced_from timestamptz NOT NULL DEFAULT now() + interval '7 days';

-- ---------------------------------------------------------------------------
-- API keys are looked up by their public prefix before any tenant context exists.
-- ---------------------------------------------------------------------------
CREATE FUNCTION auth_api_key(p_prefix text)
RETURNS TABLE (tenant_id uuid, id uuid, key_hash bytea, permissions text[], ip_allowlist cidr[],
               expires_at timestamptz, revoked_at timestamptz, created_by uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT k.tenant_id, k.id, k.key_hash, k.permissions, k.ip_allowlist, k.expires_at, k.revoked_at, k.created_by
    FROM api_keys k
   WHERE k.prefix = p_prefix
$$;
ALTER FUNCTION auth_api_key(text) OWNER TO stockos_platform;
REVOKE ALL ON FUNCTION auth_api_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_api_key(text) TO stockos_app;

-- Device registration and login-by-slug need tenant id from its public slug.
CREATE FUNCTION tenant_id_by_slug(p_slug text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ SELECT id FROM tenants WHERE slug = p_slug::citext $$;
ALTER FUNCTION tenant_id_by_slug(text) OWNER TO stockos_platform;
REVOKE ALL ON FUNCTION tenant_id_by_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_id_by_slug(text) TO stockos_app;

-- ---------------------------------------------------------------------------
-- POS device registration: a short one-time code (hash only) typed on the device.
-- ---------------------------------------------------------------------------
ALTER TABLE pos_devices
  ADD COLUMN registration_code_hash  bytea,
  ADD COLUMN registration_expires_at timestamptz,
  ADD COLUMN registered_at           timestamptz,
  ADD COLUMN created_by              uuid;
