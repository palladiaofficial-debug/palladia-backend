-- ─── 045_formazione.sql ──────────────────────────────────────────────────────
-- Modulo Formazione: course_types, worker_certificates, training_providers,
-- marketplace_courses, course_sessions, course_bookings,
-- expiry_notifications, provider_reviews + seed data (20 enti, corsi, sessioni)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Tables ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS course_types (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      text NOT NULL,
  legal_reference           text NOT NULL,
  validity_years            integer NOT NULL,
  renewal_hours             integer NOT NULL,
  risk_level                text CHECK (risk_level IN ('basso', 'medio', 'alto')),
  mandatory_for_construction boolean DEFAULT true,
  created_at                timestamptz DEFAULT now()
);
ALTER TABLE course_types ADD CONSTRAINT IF NOT EXISTS course_types_name_key UNIQUE (name);

CREATE TABLE IF NOT EXISTS worker_certificates (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid REFERENCES companies(id) ON DELETE CASCADE,
  worker_id          uuid REFERENCES workers(id)   ON DELETE CASCADE,
  course_type_id     uuid REFERENCES course_types(id),
  site_id            uuid REFERENCES sites(id),
  issue_date         date NOT NULL,
  expiry_date        date NOT NULL,
  issuing_body       text NOT NULL,
  certificate_number text,
  pdf_url            text,
  created_at         timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS training_providers (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL,
  description          text,
  logo_url             text,
  location_city        text NOT NULL,
  location_province    text NOT NULL,
  address              text,
  phone                text,
  email                text NOT NULL,
  website              text,
  accreditation_code   text,
  accreditation_region text,
  rating               numeric(2,1) DEFAULT 0,
  total_reviews        integer      DEFAULT 0,
  is_featured          boolean      DEFAULT false,
  is_active            boolean      DEFAULT true,
  commission_rate      numeric(4,2) DEFAULT 15.00,
  created_at           timestamptz  DEFAULT now()
);
ALTER TABLE training_providers ADD CONSTRAINT IF NOT EXISTS training_providers_email_key UNIQUE (email);

CREATE TABLE IF NOT EXISTS marketplace_courses (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id             uuid REFERENCES training_providers(id),
  course_type_id          uuid REFERENCES course_types(id),
  title                   text NOT NULL,
  description             text,
  price_cents             integer NOT NULL,
  currency                text    DEFAULT 'EUR',
  delivery_mode           text    CHECK (delivery_mode IN ('presenza', 'online', 'blended', 'cantiere')),
  location_city           text,
  location_address        text,
  duration_hours          integer NOT NULL,
  max_participants        integer,
  language                text    DEFAULT 'it',
  includes_exam           boolean DEFAULT true,
  certificate_issued_days integer DEFAULT 7,
  is_active               boolean DEFAULT true,
  is_featured             boolean DEFAULT false,
  created_at              timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS course_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id         uuid REFERENCES marketplace_courses(id),
  start_date        timestamptz NOT NULL,
  end_date          timestamptz NOT NULL,
  available_spots   integer     NOT NULL,
  booked_spots      integer     DEFAULT 0,
  location_override text,
  notes             text,
  is_cancelled      boolean     DEFAULT false,
  created_at        timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS course_bookings (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id             uuid REFERENCES course_sessions(id),
  course_id              uuid REFERENCES marketplace_courses(id),
  worker_id              uuid REFERENCES workers(id),
  site_id                uuid REFERENCES sites(id),
  company_id             uuid REFERENCES companies(id),
  certificate_id         uuid REFERENCES worker_certificates(id),
  status                 text CHECK (status IN ('pending','confirmed','completed','cancelled','refunded')) DEFAULT 'pending',
  payment_status         text CHECK (payment_status IN ('unpaid','paid','refunded')) DEFAULT 'unpaid',
  stripe_checkout_id     text,
  total_price_cents      integer NOT NULL,
  commission_cents       integer NOT NULL,
  provider_payout_cents  integer NOT NULL,
  booked_at              timestamptz DEFAULT now(),
  completed_at           timestamptz,
  new_certificate_id     uuid REFERENCES worker_certificates(id),
  notes                  text
);

CREATE TABLE IF NOT EXISTS expiry_notifications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  certificate_id    uuid REFERENCES worker_certificates(id),
  worker_id         uuid REFERENCES workers(id),
  company_id        uuid REFERENCES companies(id),
  notification_type text CHECK (notification_type IN ('90_days','30_days','7_days','expired')),
  sent_at           timestamptz DEFAULT now(),
  read_at           timestamptz,
  action_taken      text
);

CREATE TABLE IF NOT EXISTS provider_reviews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid REFERENCES training_providers(id),
  booking_id  uuid REFERENCES course_bookings(id),
  company_id  uuid REFERENCES companies(id),
  rating      integer CHECK (rating BETWEEN 1 AND 5),
  comment     text,
  created_at  timestamptz DEFAULT now()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_worker_certs_company    ON worker_certificates(company_id);
CREATE INDEX IF NOT EXISTS idx_worker_certs_worker     ON worker_certificates(worker_id);
CREATE INDEX IF NOT EXISTS idx_worker_certs_expiry     ON worker_certificates(expiry_date);
CREATE INDEX IF NOT EXISTS idx_bookings_company        ON course_bookings(company_id);
CREATE INDEX IF NOT EXISTS idx_bookings_worker         ON course_bookings(worker_id);
CREATE INDEX IF NOT EXISTS idx_bookings_session        ON course_bookings(session_id);
CREATE INDEX IF NOT EXISTS idx_expiry_notifs_company   ON expiry_notifications(company_id);
CREATE INDEX IF NOT EXISTS idx_expiry_notifs_cert      ON expiry_notifications(certificate_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_courses_type ON marketplace_courses(course_type_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_courses_prov ON marketplace_courses(provider_id);
CREATE INDEX IF NOT EXISTS idx_sessions_course         ON course_sessions(course_id);
CREATE INDEX IF NOT EXISTS idx_sessions_start          ON course_sessions(start_date);

-- ── Seed data ─────────────────────────────────────────────────────────────────

INSERT INTO course_types (name, legal_reference, validity_years, renewal_hours, risk_level) VALUES
  ('Formazione lavoratori - Rischio Basso',    'D.Lgs 81/08 - Accordo SR 21/12/2011',        5, 6, 'basso'),
  ('Formazione lavoratori - Rischio Medio',    'D.Lgs 81/08 - Accordo SR 21/12/2011',        5, 6, 'medio'),
  ('Formazione lavoratori - Rischio Alto',     'D.Lgs 81/08 - Accordo SR 21/12/2011',        5, 6, 'alto'),
  ('Formazione Preposto',                      'D.Lgs 81/08 - L.215/2021 - Accordo SR 2011', 5, 6, 'alto'),
  ('Formazione Dirigente sicurezza',           'D.Lgs 81/08 - Accordo SR 21/12/2011',        5, 6, 'alto'),
  ('Primo Soccorso - Gruppo A',                'D.M. 388/2003',                               3, 4, 'alto'),
  ('Primo Soccorso - Gruppo B/C',              'D.M. 388/2003',                               3, 4, 'medio'),
  ('Antincendio - Rischio Basso',              'D.M. 02/09/2021',                             5, 2, 'basso'),
  ('Antincendio - Rischio Medio',              'D.M. 02/09/2021',                             3, 5, 'medio'),
  ('Antincendio - Rischio Alto',               'D.M. 02/09/2021',                             2, 8, 'alto'),
  ('Ponteggi - Montaggio e smontaggio',        'D.Lgs 81/08 All. XXI',                        4, 4, 'alto'),
  ('Lavori in quota',                          'D.Lgs 81/08 art. 116',                        4, 4, 'alto'),
  ('Carrelli elevatori',                       'Accordo SR 22/02/2012',                       5, 4, 'medio'),
  ('Gru per autocarro',                        'Accordo SR 22/02/2012',                       5, 4, 'medio'),
  ('Escavatori e macchine movimento terra',    'Accordo SR 22/02/2012',                       5, 4, 'medio'),
  ('Badge Patentino - D.L. 159/2025',          'D.L. 159/2025',                               3, 0, 'alto')
ON CONFLICT (name) DO NOTHING;

-- ── Seed: 20 Training Providers ──────────────────────────────────────────────

INSERT INTO training_providers
  (name, description, location_city, location_province, address, phone, email, website,
   accreditation_code, accreditation_region, rating, total_reviews, is_featured, commission_rate)
VALUES
  ('Formedil Milano',
   'Ente di formazione dell''edilizia della provincia di Milano. Oltre 30 anni di esperienza nella formazione professionale per il settore costruzioni. Corsi riconosciuti dai principali enti bilaterali.',
   'Milano', 'MI', 'Via Gustavo Fara 39, 20124 Milano', '+39 02 6748391', 'info@formedilmilano.it', 'https://www.formedilmilano.it',
   'ACC-MI-0042', 'Lombardia', 4.8, 312, true, 12.00),

  ('SafetyPro Italia',
   'Academy specializzata in sicurezza sul lavoro con sedi operative in tutta Italia. Corsi in presenza, online e direttamente in cantiere. Rilascio attestati in 5 giorni lavorativi.',
   'Torino', 'TO', 'Corso Francia 212, 10138 Torino', '+39 011 4372610', 'formazione@safetypro.it', 'https://www.safetypro.it',
   'ACC-TO-0117', 'Piemonte', 4.7, 203, true, 13.00),

  ('Edilsicurezza Emilia',
   'Centro di formazione per l''edilizia con accreditamento regionale Emilia-Romagna. Specialisti in corsi per ponteggiatori, operatori macchine e preposti. Aula virtuale disponibile 24/7.',
   'Bologna', 'BO', 'Via Zanardi 376, 40131 Bologna', '+39 051 4151820', 'info@edilsicurezzaemilia.it', 'https://www.edilsicurezzaemilia.it',
   'ACC-BO-0089', 'Emilia-Romagna', 4.9, 289, true, 11.00),

  ('Formedil Lombardia',
   'Ente bilaterale dell''edilizia lombarda per la formazione professionale. Rete di 8 sedi in Lombardia. Corsi sempre aggiornati alle ultime normative. Docenti RSPP certificati.',
   'Brescia', 'BS', 'Via Industriale 5, 25030 Cazzago San Martino', '+39 030 7256900', 'segreteria@formedillombardia.it', 'https://www.formedillombardia.it',
   'ACC-BS-0023', 'Lombardia', 4.8, 189, true, 12.00),

  ('Centro Nazionale Formazione Edile',
   'Istituto di formazione con copertura nazionale. Erogazione corsi per imprese con più sedi in Italia. Piattaforma e-learning proprietaria per la formazione teorica. Esami in presenza.',
   'Milano', 'MI', 'Piazza Quattro Novembre 7, 20124 Milano', '+39 02 88888990', 'info@cnfe.it', 'https://www.cnfe.it',
   'ACC-MI-0198', 'Lombardia', 4.7, 167, true, 14.00),

  ('Centro Sicurezza Roma',
   'Centro di formazione per la sicurezza sul lavoro nel Lazio. Docenti professionisti con esperienza decennale nel settore edile. Corsi in presenza presso le nostre aule e in cantiere.',
   'Roma', 'RM', 'Via Laurentina 670, 00143 Roma', '+39 06 5927834', 'info@centrosicurezzaroma.it', 'https://www.centrosicurezzaroma.it',
   'ACC-RM-0054', 'Lazio', 4.6, 87, false, 15.00),

  ('ProSafe Academy Roma',
   'Academy per la sicurezza professionale con focus sul settore costruzioni. Materiale didattico aggiornato 2024-2025. Calendario fitto con sessioni ogni settimana. Rating eccellente.',
   'Roma', 'RM', 'Via Prenestina 1013, 00177 Roma', '+39 06 2271500', 'academy@prosafe.it', 'https://www.prosafe.it',
   'ACC-RM-0211', 'Lazio', 4.6, 98, false, 15.00),

  ('ASPP Sicurezza Firenze',
   'Associazione per la sicurezza e la prevenzione nel settore edilizio. Corsi con moduli pratici in cantiere simulato. Specialisti in formazione Preposto e Dirigente per la sicurezza.',
   'Firenze', 'FI', 'Via Lorenzo il Magnifico 4, 50129 Firenze', '+39 055 4362890', 'info@asppsicurezza.it', 'https://www.asppsicurezza.it',
   'ACC-FI-0067', 'Toscana', 4.5, 94, false, 15.00),

  ('Centro Formativo Toscano',
   'Ente di formazione professionale accreditato dalla Regione Toscana. Corsi di sicurezza, primo soccorso e antincendio. Disponibilità per corsi aziendali su richiesta.',
   'Prato', 'PO', 'Via Pistoiese 273, 59100 Prato', '+39 0574 594200', 'formazione@cftoscano.it', 'https://www.cftoscano.it',
   'ACC-PO-0041', 'Toscana', 4.4, 71, false, 15.00),

  ('Sicurwork Academy',
   'Ente specializzato in corsi di sicurezza per il Triveneto. Corsi intensivi nel weekend per non fermare i cantieri. Piattaforma app mobile per gestire attestati digitali.',
   'Venezia', 'VE', 'Via Mestrina 91, 30174 Mestre', '+39 041 5384920', 'info@sicurwork.it', 'https://www.sicurwork.it',
   'ACC-VE-0033', 'Veneto', 4.6, 78, false, 14.00),

  ('Centro Formazione Verona',
   'Centro di formazione del Veneto con specializzazione in corsi per operatori di macchine movimento terra e gru. Parco macchine disponibile per le esercitazioni pratiche.',
   'Verona', 'VR', 'Via Città di Nimes 16, 37138 Verona', '+39 045 8109320', 'info@cfverona.it', 'https://www.cfverona.it',
   'ACC-VR-0078', 'Veneto', 4.7, 119, false, 13.00),

  ('Confartigianato Formazione Napoli',
   'Centro formativo di Confartigianato Campania per le imprese artigiane e le PMI del settore edile. Corsi economici con qualità garantita dall''associazione di categoria.',
   'Napoli', 'NA', 'Corso Meridionale 6, 80143 Napoli', '+39 081 5513800', 'formazione@confartigianatona.it', 'https://www.confartigianatona.it',
   'ACC-NA-0025', 'Campania', 4.3, 62, false, 15.00),

  ('FormEdil Campania',
   'Ente bilaterale per l''edilizia della Campania. Corsi cofinanziati per le imprese iscritte alla cassa edile. Aule attrezzate a Caserta, Napoli e Salerno.',
   'Caserta', 'CE', 'Via Douhet 11, 81100 Caserta', '+39 0823 326780', 'info@formedilcampania.it', 'https://www.formedilcampania.it',
   'ACC-CE-0015', 'Campania', 4.1, 38, false, 15.00),

  ('Ente Bilaterale Edile Bari',
   'Ente di formazione bilaterale del settore edile pugliese. Corsi con agevolazioni per le imprese iscritte alle casse edili provinciali di Bari, Taranto e Brindisi.',
   'Bari', 'BA', 'Via Amendola 172/7, 70126 Bari', '+39 080 5480391', 'info@ebebari.it', 'https://www.ebebari.it',
   'ACC-BA-0019', 'Puglia', 4.4, 53, false, 15.00),

  ('Sicurezza & Formazione Bari',
   'Studio professionale specializzato in corsi di sicurezza sul lavoro per il settore edilizio e industriale. Consulenza integrata: RSPP, corsi obbligatori, DVR. Risposta in 24h.',
   'Bari', 'BA', 'Corso Cavour 32, 70121 Bari', '+39 080 5214567', 'info@sicurezzaformazione.ba.it', 'https://www.sicurezzaformazione.ba.it',
   'ACC-BA-0087', 'Puglia', 4.5, 83, false, 15.00),

  ('SafetyFirst Academy Genova',
   'Academy ligure per la sicurezza. Corsi blended con teoria online e pratica in aula. Particolarmente forti nei corsi per lavori in quota e ponteggi grazie alla tradizione portuale.',
   'Genova', 'GE', 'Via Peschiera 5, 16122 Genova', '+39 010 8392760', 'info@safetyfirstgenova.it', 'https://www.safetyfirstgenova.it',
   'ACC-GE-0044', 'Liguria', 4.5, 67, false, 14.00),

  ('EBILOG Piemonte',
   'Ente bilaterale della logistica e delle costruzioni per il Piemonte. Formazione specifica per operatori di carrelli elevatori, gru e macchine da cantiere. Esami pratici inclusi.',
   'Torino', 'TO', 'Via Livorno 60, 10144 Torino', '+39 011 2484900', 'formazione@ebilogpiemonte.it', 'https://www.ebilogpiemonte.it',
   'ACC-TO-0203', 'Piemonte', 4.3, 45, false, 15.00),

  ('FormaSicur Palermo',
   'Ente di formazione siciliano con sedi a Palermo, Catania e Messina. Corsi interamente in presenza con docenti locali. Specializzati in formazione per il comparto costruzioni del Sud.',
   'Palermo', 'PA', 'Via Libertà 171, 90143 Palermo', '+39 091 6256890', 'info@formasicurpalermo.it', 'https://www.formasicurpalermo.it',
   'ACC-PA-0011', 'Sicilia', 4.2, 41, false, 15.00),

  ('Safety Training Italia Catania',
   'Centro di formazione professionale per la sicurezza con focus sull''edilizia e l''industria. Corsi serali e weekend disponibili per non fermare la produzione. Attestati rapidi in 3 giorni.',
   'Catania', 'CT', 'Viale Mario Rapisardi 231, 95123 Catania', '+39 095 4346780', 'info@safetytrainingcatania.it', 'https://www.safetytrainingcatania.it',
   'ACC-CT-0008', 'Sicilia', 4.2, 29, false, 15.00),

  ('EdiForm Sud',
   'Ente di formazione per il Mezzogiorno d''Italia. Corsi a prezzi calmierati grazie ai fondi regionali. Forte presenza in Calabria, Basilicata e Campania. Docenti INAIL certificati.',
   'Reggio Calabria', 'RC', 'Via Filippini 18, 89125 Reggio Calabria', '+39 0965 894321', 'info@ediformsud.it', 'https://www.ediformsud.it',
   'ACC-RC-0003', 'Calabria', 4.0, 22, false, 15.00)
ON CONFLICT (email) DO NOTHING;

-- ── Seed: Marketplace Courses ─────────────────────────────────────────────────

DO $$
DECLARE
  -- provider IDs
  p_formedil_mi    uuid; p_safetypro_to   uuid; p_edilsic_bo     uuid;
  p_formedil_lo    uuid; p_cnfe_mi        uuid; p_csr_rm         uuid;
  p_prosafe_rm     uuid; p_aspp_fi        uuid; p_cft_po         uuid;
  p_sicurwork_ve   uuid; p_cfv_vr         uuid; p_confart_na     uuid;
  p_formedil_ce    uuid; p_ebe_ba         uuid; p_siform_ba      uuid;
  p_sf1_ge         uuid; p_ebilog_to      uuid; p_formasicur_pa  uuid;
  p_sti_ct         uuid; p_ediform_rc     uuid;
  -- course type IDs
  ct_basso  uuid; ct_medio  uuid; ct_alto    uuid; ct_preposto  uuid;
  ct_dirig  uuid; ct_psa    uuid; ct_psbc    uuid; ct_aib       uuid;
  ct_aim    uuid; ct_aia    uuid; ct_pont    uuid; ct_quota     uuid;
  ct_carr   uuid; ct_gru    uuid; ct_escav   uuid; ct_badge     uuid;
  -- course IDs
  c1  uuid; c2  uuid; c3  uuid; c4  uuid; c5  uuid; c6  uuid; c7  uuid;
  c8  uuid; c9  uuid; c10 uuid; c11 uuid; c12 uuid; c13 uuid; c14 uuid;
  c15 uuid; c16 uuid; c17 uuid; c18 uuid; c19 uuid; c20 uuid; c21 uuid;
  c22 uuid; c23 uuid; c24 uuid; c25 uuid; c26 uuid; c27 uuid; c28 uuid;
  c29 uuid; c30 uuid; c31 uuid; c32 uuid; c33 uuid; c34 uuid; c35 uuid;
  c36 uuid; c37 uuid; c38 uuid; c39 uuid; c40 uuid;
BEGIN
  -- Guard: skip if already seeded
  IF (SELECT COUNT(*) FROM marketplace_courses) > 0 THEN RETURN; END IF;

  -- Fetch provider IDs
  SELECT id INTO p_formedil_mi   FROM training_providers WHERE email = 'info@formedilmilano.it';
  SELECT id INTO p_safetypro_to  FROM training_providers WHERE email = 'formazione@safetypro.it';
  SELECT id INTO p_edilsic_bo    FROM training_providers WHERE email = 'info@edilsicurezzaemilia.it';
  SELECT id INTO p_formedil_lo   FROM training_providers WHERE email = 'segreteria@formedillombardia.it';
  SELECT id INTO p_cnfe_mi       FROM training_providers WHERE email = 'info@cnfe.it';
  SELECT id INTO p_csr_rm        FROM training_providers WHERE email = 'info@centrosicurezzaroma.it';
  SELECT id INTO p_prosafe_rm    FROM training_providers WHERE email = 'academy@prosafe.it';
  SELECT id INTO p_aspp_fi       FROM training_providers WHERE email = 'info@asppsicurezza.it';
  SELECT id INTO p_cft_po        FROM training_providers WHERE email = 'formazione@cftoscano.it';
  SELECT id INTO p_sicurwork_ve  FROM training_providers WHERE email = 'info@sicurwork.it';
  SELECT id INTO p_cfv_vr        FROM training_providers WHERE email = 'info@cfverona.it';
  SELECT id INTO p_confart_na    FROM training_providers WHERE email = 'formazione@confartigianatona.it';
  SELECT id INTO p_formedil_ce   FROM training_providers WHERE email = 'info@formedilcampania.it';
  SELECT id INTO p_ebe_ba        FROM training_providers WHERE email = 'info@ebebari.it';
  SELECT id INTO p_siform_ba     FROM training_providers WHERE email = 'info@sicurezzaformazione.ba.it';
  SELECT id INTO p_sf1_ge        FROM training_providers WHERE email = 'info@safetyfirstgenova.it';
  SELECT id INTO p_ebilog_to     FROM training_providers WHERE email = 'formazione@ebilogpiemonte.it';
  SELECT id INTO p_formasicur_pa FROM training_providers WHERE email = 'info@formasicurpalermo.it';
  SELECT id INTO p_sti_ct        FROM training_providers WHERE email = 'info@safetytrainingcatania.it';
  SELECT id INTO p_ediform_rc    FROM training_providers WHERE email = 'info@ediformsud.it';

  -- Fetch course type IDs
  SELECT id INTO ct_basso   FROM course_types WHERE name = 'Formazione lavoratori - Rischio Basso';
  SELECT id INTO ct_medio   FROM course_types WHERE name = 'Formazione lavoratori - Rischio Medio';
  SELECT id INTO ct_alto    FROM course_types WHERE name = 'Formazione lavoratori - Rischio Alto';
  SELECT id INTO ct_preposto FROM course_types WHERE name = 'Formazione Preposto';
  SELECT id INTO ct_dirig   FROM course_types WHERE name = 'Formazione Dirigente sicurezza';
  SELECT id INTO ct_psa     FROM course_types WHERE name = 'Primo Soccorso - Gruppo A';
  SELECT id INTO ct_psbc    FROM course_types WHERE name = 'Primo Soccorso - Gruppo B/C';
  SELECT id INTO ct_aib     FROM course_types WHERE name = 'Antincendio - Rischio Basso';
  SELECT id INTO ct_aim     FROM course_types WHERE name = 'Antincendio - Rischio Medio';
  SELECT id INTO ct_aia     FROM course_types WHERE name = 'Antincendio - Rischio Alto';
  SELECT id INTO ct_pont    FROM course_types WHERE name = 'Ponteggi - Montaggio e smontaggio';
  SELECT id INTO ct_quota   FROM course_types WHERE name = 'Lavori in quota';
  SELECT id INTO ct_carr    FROM course_types WHERE name = 'Carrelli elevatori';
  SELECT id INTO ct_gru     FROM course_types WHERE name = 'Gru per autocarro';
  SELECT id INTO ct_escav   FROM course_types WHERE name = 'Escavatori e macchine movimento terra';
  SELECT id INTO ct_badge   FROM course_types WHERE name = 'Badge Patentino - D.L. 159/2025';

  -- ── Courses ────────────────────────────────────────────────────────────────

  INSERT INTO marketplace_courses (id, provider_id, course_type_id, title, description, price_cents, delivery_mode, location_city, location_address, duration_hours, max_participants, certificate_issued_days, is_featured)
  VALUES
    -- Formedil Milano
    (gen_random_uuid(), p_formedil_mi, ct_alto, 'Formazione Sicurezza Rischio Alto - Corso Completo',
     'Corso completo di formazione generale e specifica per lavoratori esposti a rischio alto. Include moduli su DPI, uso in sicurezza di attrezzature da cantiere, segnaletica e procedure di emergenza. Esame finale con rilascio attestato conforme D.Lgs 81/08.',
     18000, 'presenza', 'Milano', 'Via Gustavo Fara 39, 20124 Milano', 12, 20, 5, true),

    (gen_random_uuid(), p_formedil_mi, ct_pont, 'Ponteggi - Montaggio, Uso e Smontaggio PiMUS',
     'Corso obbligatorio per addetti al montaggio, uso e smontaggio ponteggi ai sensi dell''allegato XXI del D.Lgs 81/08. Modulo teorico e pratico con esercitazione su ponteggio reale. Attestato valido 4 anni.',
     22000, 'presenza', 'Milano', 'Via Gustavo Fara 39, 20124 Milano', 28, 15, 7, false),

    (gen_random_uuid(), p_formedil_mi, ct_badge, 'Badge Patentino Edilizia - D.L. 159/2025',
     'Percorso formativo obbligatorio per l''ottenimento del Badge Patentino ai sensi del D.L. 159/2025. Include moduli sulla sicurezza generale, diritti e doveri del lavoratore, uso DPI e sistemi antiinfortunistici.',
     25000, 'presenza', 'Milano', 'Via Gustavo Fara 39, 20124 Milano', 16, 25, 7, true),

    -- SafetyPro Torino
    (gen_random_uuid(), p_safetypro_to, ct_preposto, 'Formazione Preposto - Aggiornamento L.215/2021',
     'Corso per preposti alla sicurezza conforme alla Legge 215/2021. Moduli su responsabilità del preposto, gestione delle non conformità, rapporti con RSPP e lavoratori, compilazione registri sicurezza.',
     16000, 'blended', 'Torino', 'Corso Francia 212, 10138 Torino', 8, 20, 5, true),

    (gen_random_uuid(), p_safetypro_to, ct_quota, 'Lavori in Quota - Sicurezza e Procedure',
     'Corso teorico-pratico per lavoratori che operano in quota. Utilizzo DPI anticaduta, funi di sicurezza, imbragature e dispositivi retrattili. Esercitazioni pratiche incluse. Esame certificato.',
     19500, 'presenza', 'Torino', 'Corso Francia 212, 10138 Torino', 8, 12, 5, false),

    (gen_random_uuid(), p_safetypro_to, ct_medio, 'Sicurezza Rischio Medio - Edilizia e Cantieri',
     'Corso formazione lavoratori per attività a rischio medio nel settore edile. Conforme all''accordo Stato-Regioni 2011. Erogazione in modalità blended: 8h online + 4h pratica in aula.',
     14000, 'blended', 'Torino', 'Corso Francia 212, 10138 Torino', 12, 25, 5, false),

    -- Edilsicurezza Emilia
    (gen_random_uuid(), p_edilsic_bo, ct_pont, 'Ponteggi Avanzato - Responsabile di Squadra',
     'Corso avanzato per responsabili di squadra montaggio ponteggi. Include calcoli strutturali base, redazione PiMUS, coordinamento squadra, gestione emergenze in quota. Certificazione quadriennale.',
     28000, 'presenza', 'Bologna', 'Via Zanardi 376, 40131 Bologna', 32, 10, 7, true),

    (gen_random_uuid(), p_edilsic_bo, ct_aia, 'Antincendio Rischio Alto - Teoria e Pratica',
     'Corso antincendio per attività ad alto rischio incendio. Moduli teorici su combustione, sistemi di rilevazione, evacuazione. Esercitazione pratica con estintori reali. Durata 16h, attestato 2 anni.',
     38000, 'presenza', 'Bologna', 'Via Zanardi 376, 40131 Bologna', 16, 15, 5, false),

    (gen_random_uuid(), p_edilsic_bo, ct_escav, 'Macchine Movimento Terra - Patentino Operatore',
     'Corso completo per operatori di macchine movimento terra: escavatori, pale caricatrici, autoribaltabili, terne. Conforme Accordo SR 22/02/2012. Esercitazioni pratiche su parco macchine.',
     45000, 'presenza', 'Bologna', 'Via Zanardi 376, 40131 Bologna', 16, 8, 10, true),

    -- Formedil Lombardia
    (gen_random_uuid(), p_formedil_lo, ct_dirig, 'Formazione Dirigente per la Sicurezza - 16 ore',
     'Corso completo per dirigenti con delega alla sicurezza sul lavoro ai sensi del D.Lgs 81/08. Responsabilità penali e civili, sistemi di gestione sicurezza, gestione appalti e PSC/PSS.',
     35000, 'presenza', 'Brescia', 'Via Industriale 5, 25030 Cazzago San Martino (BS)', 16, 20, 7, false),

    (gen_random_uuid(), p_formedil_lo, ct_alto, 'Sicurezza Alto Rischio - Cantieri Complessi',
     'Formazione specifica per lavoratori in cantieri con complessità elevata: scavi, demolizioni, opere provvisionali. Moduli DPI, lavoro in ambienti confinati, gestione interferenze.',
     20000, 'presenza', 'Brescia', 'Via Industriale 5, 25030 Cazzago San Martino (BS)', 12, 20, 5, false),

    -- CNFE Milano
    (gen_random_uuid(), p_cnfe_mi, ct_carr, 'Carrelli Elevatori - Patentino Operatore Nazionale',
     'Corso per il conseguimento dell''abilitazione alla conduzione di carrelli elevatori ai sensi dell''Accordo SR 22/02/2012. Modulo teorico online + pratica in sede. Attestato valido 5 anni.',
     24000, 'blended', 'Milano', 'Piazza Quattro Novembre 7, 20124 Milano', 12, 15, 5, true),

    (gen_random_uuid(), p_cnfe_mi, ct_gru, 'Gru per Autocarro - Abilitazione Operatore',
     'Percorso abilitativo per operatori di gru per autocarro (fascia bassa e media). Modulo teorico su normativa, calcolo carichi, sicurezza. Pratica su gru reale con istruttore certificato.',
     32000, 'presenza', 'Milano', 'Piazza Quattro Novembre 7, 20124 Milano', 12, 10, 7, false),

    -- Centro Sicurezza Roma
    (gen_random_uuid(), p_csr_rm, ct_psa, 'Primo Soccorso Gruppo A - Aziende Alto Rischio',
     'Corso di primo soccorso per designati aziende Gruppo A (costruzioni, industria ad alto rischio). BLS-D, gestione traumi, ferite, fratture. Rilascio certificazione triennale conforme D.M. 388/2003.',
     18000, 'presenza', 'Roma', 'Via Laurentina 670, 00143 Roma', 16, 12, 5, false),

    (gen_random_uuid(), p_csr_rm, ct_medio, 'Formazione Rischio Medio - Roma e Lazio',
     'Corso standard per lavoratori esposti a rischio medio. Gestione emergenze, uso DPI, segnaletica. Erogato ogni settimana. Ideale per imprese che iniziano nuovi cantieri nel Lazio.',
     12000, 'presenza', 'Roma', 'Via Laurentina 670, 00143 Roma', 12, 20, 5, false),

    -- ProSafe Roma
    (gen_random_uuid(), p_prosafe_rm, ct_badge, 'Patentino Edilizia D.L. 159/2025 - Accesso Rapido',
     'Corso accelerato per l''ottenimento del Badge Patentino. Format weekend intensivo: sabato + domenica. Perfetto per i cantieri in partenza urgente. Attestato in 3 giorni lavorativi.',
     28000, 'presenza', 'Roma', 'Via Prenestina 1013, 00177 Roma', 16, 20, 3, true),

    (gen_random_uuid(), p_prosafe_rm, ct_psbc, 'Primo Soccorso B/C - Aggiornamento Triennale',
     'Corso di aggiornamento triennale per addetti al primo soccorso nelle aziende Gruppo B e C. Revisione procedure BLS, gestione shock, medicazione. Validità 3 anni.',
     9000, 'presenza', 'Roma', 'Via Prenestina 1013, 00177 Roma', 6, 15, 3, false),

    -- ASPP Firenze
    (gen_random_uuid(), p_aspp_fi, ct_preposto, 'Preposto Sicurezza - Corso + Aggiornamento Annuale',
     'Formazione completa per preposti con aggiornamento annuale incluso nel prezzo. Responsabilità, gestione squadra, interfaccia RSPP. Pacchetto conveniente per imprese con più preposti.',
     18000, 'presenza', 'Firenze', 'Via Lorenzo il Magnifico 4, 50129 Firenze', 8, 20, 5, false),

    (gen_random_uuid(), p_aspp_fi, ct_quota, 'Lavori in Quota Toscana - Corso Intensivo',
     'Corso intensivo per lavoratori in quota con componente pratica ampliata. Simulazioni di emergenza in quota, recupero in fune, ispezione imbracature. Docenti con esperienza alpinistica.',
     21000, 'presenza', 'Firenze', 'Via Lorenzo il Magnifico 4, 50129 Firenze', 8, 10, 5, false),

    -- Sicurwork Venezia
    (gen_random_uuid(), p_sicurwork_ve, ct_alto, 'Sicurezza Alto Rischio - Formato Weekend',
     'Corso formazione lavoratori rischio alto erogato in formato weekend per non fermare i cantieri. Sabato 9h - Domenica 3h. Attestato conforme D.Lgs 81/08 e Accordo SR 2011.',
     17000, 'presenza', 'Venezia', 'Via Mestrina 91, 30174 Mestre (VE)', 12, 18, 5, false),

    -- CFV Verona
    (gen_random_uuid(), p_cfv_vr, ct_escav, 'Escavatori e Pale - Corso Completo Veneto',
     'Corso abilitativo per escavatori, pale caricatrici e terne. Parco macchine di proprietà con 6 attrezzature disponibili per le esercitazioni. Corsi su appuntamento per gruppi aziendali.',
     48000, 'presenza', 'Verona', 'Via Città di Nimes 16, 37138 Verona', 16, 8, 7, true),

    (gen_random_uuid(), p_cfv_vr, ct_carr, 'Carrelli Elevatori Verona - Corso + Rinnovo',
     'Corso iniziale e rinnovo quinquennale per operatori carrelli elevatori. Sia frontali che retrattili e a filoguida. Parco macchine sempre disponibile. Rating: 4.9/5.',
     22000, 'presenza', 'Verona', 'Via Città di Nimes 16, 37138 Verona', 12, 12, 5, false),

    -- Confartigianato Napoli
    (gen_random_uuid(), p_confart_na, ct_basso, 'Sicurezza Rischio Basso - Artigiani Campania',
     'Corso di formazione per lavoratori delle imprese artigiane esposti a rischio basso. Tariffe convenzionate per le imprese associate a Confartigianato. Online o in presenza a scelta.',
     7500, 'online', 'Napoli', NULL, 8, 30, 7, false),

    -- FormEdil Campania
    (gen_random_uuid(), p_formedil_ce, ct_pont, 'Ponteggi Campania - Ente Bilaterale',
     'Corso ponteggiatori organizzato dall''ente bilaterale edile della Campania. Agevolazioni per imprese iscritte alla cassa edile. Sedi disponibili a Caserta, Napoli e Salerno.',
     16000, 'presenza', 'Caserta', 'Via Douhet 11, 81100 Caserta', 28, 15, 10, false),

    -- EBE Bari
    (gen_random_uuid(), p_ebe_ba, ct_aib, 'Antincendio Rischio Basso - Puglia',
     'Corso antincendio per rischio basso erogato dall''ente bilaterale edile pugliese. Costi ridotti per le imprese iscritte. Calendario frequente: almeno 2 sessioni al mese.',
     8000, 'presenza', 'Bari', 'Via Amendola 172/7, 70126 Bari', 4, 20, 5, false),

    -- Sicurezza & Formazione Bari
    (gen_random_uuid(), p_siform_ba, ct_dirig, 'Dirigente Sicurezza - Sud Italia',
     'Corso per dirigenti e datori di lavoro delegati con specializzazione nel contesto del Sud Italia. Analisi casi pratici reali, cantieri del Meridione, gestione subappalti.',
     32000, 'presenza', 'Bari', 'Corso Cavour 32, 70121 Bari', 16, 15, 5, false),

    -- SafetyFirst Genova
    (gen_random_uuid(), p_sf1_ge, ct_pont, 'Ponteggi Porto - Specializzazione Lavori Navali',
     'Corso ponteggi con specializzazione per lavori in ambito portuale e navale. Include moduli su lavori su navi e banchine, rischi specifici dell''ambiente marittimo.',
     26000, 'presenza', 'Genova', 'Via Peschiera 5, 16122 Genova', 28, 12, 7, false),

    (gen_random_uuid(), p_sf1_ge, ct_quota, 'Lavori in Quota - Specializzazione Navale',
     'Corso per lavori in quota in ambito portuale e navale. Gestione dei rischi specifici: superfici scivolose, vento, lavori su alberi e alberature. Docenti con esperienza marittima.',
     23000, 'presenza', 'Genova', 'Via Peschiera 5, 16122 Genova', 8, 10, 5, false),

    -- EBILOG Torino
    (gen_random_uuid(), p_ebilog_to, ct_gru, 'Gru per Autocarro - Patentino Piemonte',
     'Corso abilitativo per gru per autocarro nel territorio piemontese. Modulo teorico con simulatore, pratica su gru reale. Personale INAIL certificato. Fascia bassa e media.',
     35000, 'presenza', 'Torino', 'Via Livorno 60, 10144 Torino', 12, 10, 7, false),

    -- FormaSicur Palermo
    (gen_random_uuid(), p_formasicur_pa, ct_alto, 'Sicurezza Alto Rischio - Sicilia',
     'Corso di formazione rischio alto per lavoratori edili siciliani. Prezzi accessibili, sedi a Palermo, Catania e Messina. Certificati conformi e riconosciuti su tutto il territorio nazionale.',
     13000, 'presenza', 'Palermo', 'Via Libertà 171, 90143 Palermo', 12, 20, 7, false),

    -- Safety Training Catania
    (gen_random_uuid(), p_sti_ct, ct_psa, 'Primo Soccorso Gruppo A - Catania',
     'Corso di primo soccorso Gruppo A per le aziende del settore edile e industriale di Catania e provincia. Disponibilità serale per non fermare i lavori. Attestato in 48 ore.',
     16000, 'presenza', 'Catania', 'Viale Mario Rapisardi 231, 95123 Catania', 16, 12, 2, false),

    -- EdiForm Sud
    (gen_random_uuid(), p_ediform_rc, ct_basso, 'Formazione Base Rischio Basso - Calabria',
     'Corso economico di formazione generale rischio basso per le imprese del Sud Italia. Cofinanziamento regionale disponibile per le imprese calabresi. Corsi anche in modalità online.',
     6500, 'online', 'Reggio Calabria', NULL, 8, 40, 7, false),

    (gen_random_uuid(), p_ediform_rc, ct_medio, 'Rischio Medio Edilizia - Fondi Regionali',
     'Corso rischio medio con accesso ai fondi formativi regionali. Possibilità di corsi a costo zero per le imprese ammesse al bando. Contattare l''ente per verifica requisiti.',
     9500, 'presenza', 'Reggio Calabria', 'Via Filippini 18, 89125 Reggio Calabria', 12, 20, 7, false),

    -- CFT Prato
    (gen_random_uuid(), p_cft_po, ct_aim, 'Antincendio Rischio Medio - Toscana',
     'Corso antincendio per rischio medio erogato da ente accreditato regione Toscana. Teoria su normativa, rilevazione incendi, evacuazione. Pratica su impianti reali. Attestato 3 anni.',
     22000, 'presenza', 'Prato', 'Via Pistoiese 273, 59100 Prato', 8, 15, 5, false)
  RETURNING id;

  -- ── Sessions: generate upcoming sessions for each course ──────────────────
  -- 2-3 sessions per course, distributed in the next 1-5 months

  INSERT INTO course_sessions (course_id, start_date, end_date, available_spots, notes)
  SELECT
    mc.id,
    now() + (s.offset_days || ' days')::interval + '09:00:00'::interval,
    now() + (s.offset_days || ' days')::interval + (mc.duration_hours || ' hours')::interval + '09:00:00'::interval,
    COALESCE(mc.max_participants, 20) - FLOOR(RANDOM() * 5)::integer,
    CASE WHEN s.session_num = 1 THEN 'Prima sessione disponibile'
         WHEN s.session_num = 2 THEN NULL
         ELSE 'Sessione aggiuntiva su richiesta'
    END
  FROM marketplace_courses mc
  CROSS JOIN (
    VALUES
      (14,  1), (42,  2), (75,  3),
      (21,  1), (56,  2), (90,  3)
  ) AS s(offset_days, session_num)
  WHERE mc.is_active = true
    AND s.session_num <= CASE
      WHEN mc.max_participants IS NOT NULL AND mc.max_participants <= 10 THEN 2
      ELSE 3
    END;

END $$;
