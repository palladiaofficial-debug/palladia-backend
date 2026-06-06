'use strict';

// Comma-separated list of Supabase auth user UUIDs that have founder access.
// Set FOUNDER_USER_IDS on Railway to enable founder mode.
const FOUNDER_IDS = new Set(
  (process.env.FOUNDER_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
);

module.exports = {
  isFounder: (uid) => FOUNDER_IDS.has(uid),
};
