-- 088_site_diary.sql
-- Diario di cantiere: voce giornaliera con meteo auto, presenze, mezzi, note

create table if not exists site_diary_entries (
  id               uuid default gen_random_uuid() primary key,
  company_id       uuid not null references companies(id) on delete cascade,
  site_id          uuid not null references sites(id) on delete cascade,
  entry_date       date not null,
  created_by       uuid references auth.users(id),
  created_at       timestamptz default now(),
  updated_at       timestamptz default now(),

  -- Meteo snapshot (da site_weather_logs o fetch live, modificabile)
  weather_code     int,
  weather_desc     text,
  temp_min         int,
  temp_max         int,
  precipitation_mm numeric(6,1),
  wind_max_kmh     numeric(6,1),

  -- Attività giornaliere
  activities       text,
  issues           text,
  decisions        text,
  materials        text,
  notes            text,

  -- Snapshot presenti (auto-compilato, modificabile)
  workers_snapshot     jsonb default '[]'::jsonb,
  machinery_snapshot   jsonb default '[]'::jsonb,
  subcontractors_snapshot jsonb default '[]'::jsonb,

  -- Ore totali calcolate dai punch
  work_hours_total numeric(6,1),

  -- Foto allegate (url, caption)
  photos           jsonb default '[]'::jsonb,

  unique(site_id, entry_date)
);

alter table site_diary_entries enable row level security;

create policy "company_member_diary"
  on site_diary_entries for all
  using (is_company_member(company_id));

create index if not exists idx_site_diary_site_date
  on site_diary_entries(site_id, entry_date desc);

create index if not exists idx_site_diary_company_date
  on site_diary_entries(company_id, entry_date desc);
