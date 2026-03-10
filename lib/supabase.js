'use strict';
const { createClient } = require('@supabase/supabase-js');

// Shared Supabase client (service key — bypasses RLS, used server-side only).
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY
);

module.exports = supabase;
