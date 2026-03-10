-- ============================================================
-- Migration 007 — Aggiungi colonne frontend a sites
-- Colonne usate da NewSiteModal e SiteCard nel frontend React
-- Eseguire in Supabase > SQL Editor
-- ============================================================

ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS client     text,
  ADD COLUMN IF NOT EXISTS start_date date,
  ADD COLUMN IF NOT EXISTS status     text NOT NULL DEFAULT 'attivo'
                                      CHECK (status IN ('attivo', 'sospeso', 'chiuso'));
