-- Migration 015: RPC helper per incremento accessi coordinatore
-- Usata da resolveInvite() in coordinator.js per tracciare access_count

CREATE OR REPLACE FUNCTION increment_coord_access(p_invite_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
  UPDATE site_coordinator_invites
  SET access_count = access_count + 1
  WHERE id = p_invite_id;
$$;
