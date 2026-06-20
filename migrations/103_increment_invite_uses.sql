-- Incremento atomico uses_count per evitare race condition su link invite
CREATE OR REPLACE FUNCTION increment_invite_uses(p_invite_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
  UPDATE worker_invite_tokens
     SET uses_count = uses_count + 1
   WHERE id = p_invite_id;
$$;
