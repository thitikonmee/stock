-- API key lookup also returns the key's per-minute rate limit.
-- (Return type changes, so the function is dropped and recreated.)
DROP FUNCTION auth_api_key(text);

CREATE FUNCTION auth_api_key(p_prefix text)
RETURNS TABLE (tenant_id uuid, id uuid, key_hash bytea, permissions text[], ip_allowlist cidr[],
               expires_at timestamptz, revoked_at timestamptz, created_by uuid, rate_limit_per_min int)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT k.tenant_id, k.id, k.key_hash, k.permissions, k.ip_allowlist, k.expires_at, k.revoked_at,
         k.created_by, k.rate_limit_per_min
    FROM api_keys k
   WHERE k.prefix = p_prefix
$$;
ALTER FUNCTION auth_api_key(text) OWNER TO stockos_platform;
REVOKE ALL ON FUNCTION auth_api_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_api_key(text) TO stockos_app;
