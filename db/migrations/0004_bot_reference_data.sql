-- BOT MSP2 reference data.
--
-- GENERATED FILE — do not edit by hand.
-- Produced by scripts/generate-bot-reference-migration.mjs from
-- docs/reference/bot-taxonomies.json, which was extracted from BOT’s own
-- MSP2 template. See docs/02-BOT-REPORTING-SPEC.md.
--
-- These tables live in the `reference` schema rather than `public` because
-- they hold no institution data. That separation is structural rather than
-- conventional: the tenant-isolation invariants apply to every table in
-- `public`, so a table only escapes them by being somewhere that visibly is
-- not tenant storage. The application role is granted SELECT and nothing
-- else — reference data changes by migration, never at runtime.

CREATE SCHEMA IF NOT EXISTS reference;
GRANT USAGE ON SCHEMA reference TO mfi_app;
REVOKE CREATE ON SCHEMA reference FROM mfi_app;

-- ---------------------------------------------------------------------------
-- Economic sectors (MSP2-03 rows, MSP2-09 rows)
-- ---------------------------------------------------------------------------

CREATE TABLE reference.sectors (
  code text     PRIMARY KEY,
  sno  smallint NOT NULL UNIQUE,
  name text     NOT NULL UNIQUE
);

COMMENT ON TABLE reference.sectors IS 'BOT sector taxonomy. Fixed list; loans and clients reference it.';

INSERT INTO reference.sectors (code, sno, name) VALUES
  ('agriculture', 1, 'Agriculture'),
  ('fishing', 2, 'Fishing'),
  ('forest', 3, 'Forest'),
  ('hunting', 4, 'Hunting'),
  ('financial_intermediaries', 5, 'Financial Intermediaries'),
  ('mining_and_quarrying', 6, 'Mining and Quarrying'),
  ('manufacturing', 7, 'Manufacturing'),
  ('building_and_construction', 8, 'Building and Construction'),
  ('real_estate', 9, 'Real Estate'),
  ('leasing', 10, 'Leasing'),
  ('transport_and_communication', 11, 'Transport and Communication'),
  ('trade', 12, 'Trade'),
  ('tourism', 13, 'Tourism'),
  ('hotels_and_restaurants', 14, 'Hotels and Restaurants'),
  ('warehousing_and_storage', 15, 'Warehousing and Storage'),
  ('electricity', 16, 'Electricity'),
  ('gas', 17, 'Gas'),
  ('water', 18, 'Water'),
  ('education', 19, 'Education'),
  ('health', 20, 'Health'),
  ('other_services', 21, 'Other Services'),
  ('personal_private', 22, 'Personal (Private)');

-- ---------------------------------------------------------------------------
-- Loan types (MSP2-04 rows)
-- ---------------------------------------------------------------------------

CREATE TABLE reference.loan_types (
  code                      text     PRIMARY KEY,
  sno                       smallint NOT NULL UNIQUE,
  name                      text     NOT NULL,
  parent_code               text     REFERENCES reference.loan_types (code),
  -- Housing microfinance loans classify on a separate, longer provisioning
  -- schedule. A housing loan 100 days overdue provisions at 25%; any other
  -- loan at 100 days provisions at 100%. See 02-BOT-REPORTING-SPEC.md §4.1.
  provisioning_schedule     text     NOT NULL DEFAULT 'standard'
);

COMMENT ON TABLE reference.loan_types IS 'BOT loan type taxonomy. Salaried Loans reports as two sub-rows rolling up to a parent.';

INSERT INTO reference.loan_types (code, sno, name, parent_code, provisioning_schedule) VALUES
  ('business_group_loans', 1, 'Business Group Loans', NULL, 'standard'),
  ('business_solidarity_small_group_loans', 2, 'Business Solidarity/Small Group Loans', NULL, 'standard'),
  ('business_individual_loans', 3, 'Business Individual Loans', NULL, 'standard'),
  ('agriculture_loans', 4, 'Agriculture Loans', NULL, 'standard'),
  ('housing_microfinance_loans', 5, 'Housing Microfinance Loans', NULL, 'housing'),
  ('microleasing_hire_purchase_loans', 6, 'Microleasing/Hire purchase Loans', NULL, 'standard'),
  ('loans_to_other_microfinance_service_providers_e_g_saccos', 7, 'Loans to Other Microfinance Service Providers (e.g. SACCOS)', NULL, 'standard'),
  ('micro_insurance_loans', 8, 'Micro Insurance Loans', NULL, 'standard'),
  ('education_loan', 9, 'Education Loan', NULL, 'standard'),
  ('salaried_loans', 10, 'Salaried Loans', NULL, 'standard'),
  ('government_employees', 11, 'Government Employees', 'salaried_loans', 'standard'),
  ('non_government_employees', 12, 'Non-Government Employees', 'salaried_loans', 'standard'),
  ('emergence_loans', 13, 'Emergence Loans', NULL, 'standard'),
  ('other_micro_loans', 14, 'Other Micro Loans', NULL, 'standard');

-- ---------------------------------------------------------------------------
-- Loan-loss provisioning schedules (MSP2-03)
-- ---------------------------------------------------------------------------

-- Versioned with effective dates because BOT can revise the rates, and a
-- report for a past quarter must be reproducible with the rates that applied
-- then. 02-BOT-REPORTING-SPEC.md §11.1 records that as an open question.
CREATE TABLE reference.provisioning_schedules (
  code           text PRIMARY KEY,
  name           text NOT NULL,
  effective_from date NOT NULL,
  effective_to   date,
  CONSTRAINT provisioning_schedules_period CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE TABLE reference.provisioning_bands (
  schedule_code    text        NOT NULL REFERENCES reference.provisioning_schedules (code),
  classification   text        NOT NULL
                               CHECK (classification IN ('current','esm','substandard','doubtful','loss')),
  min_days_overdue integer     NOT NULL CHECK (min_days_overdue >= 0),
  max_days_overdue integer     CHECK (max_days_overdue IS NULL OR max_days_overdue >= min_days_overdue),
  provision_rate   numeric(5,4) NOT NULL CHECK (provision_rate BETWEEN 0 AND 1),
  PRIMARY KEY (schedule_code, classification)
);

COMMENT ON TABLE reference.provisioning_bands IS 'Days-past-due bands and provision rates, read from BOT’s MSP2-03 sheet.';

INSERT INTO reference.provisioning_schedules (code, name, effective_from) VALUES
  ('standard', 'Standard microfinance loan classification', DATE '2021-01-01'),
  ('housing', 'Housing microfinance loan classification', DATE '2021-01-01');

INSERT INTO reference.provisioning_bands
  (schedule_code, classification, min_days_overdue, max_days_overdue, provision_rate) VALUES
  ('standard', 'current', 0, 5, 0.01),
  ('standard', 'esm', 6, 30, 0.05),
  ('standard', 'substandard', 31, 60, 0.25),
  ('standard', 'doubtful', 61, 90, 0.5),
  ('standard', 'loss', 91, NULL, 1),
  ('housing', 'substandard', 91, 180, 0.25),
  ('housing', 'doubtful', 181, 360, 0.5),
  ('housing', 'loss', 361, NULL, 1);

-- ---------------------------------------------------------------------------
-- Complaint natures (MSP2-06 columns)
-- ---------------------------------------------------------------------------

CREATE TABLE reference.complaint_natures (
  code text     PRIMARY KEY,
  sno  smallint NOT NULL UNIQUE,
  name text     NOT NULL UNIQUE
);

INSERT INTO reference.complaint_natures (code, sno, name) VALUES
  ('interest_rate', 1, 'Interest Rate'),
  ('agreements', 2, 'Agreements'),
  ('repayments', 3, 'Repayments'),
  ('loan_statement', 4, 'Loan Statement'),
  ('loan_processing', 5, 'Loan Processing'),
  ('others', 6, 'Others');

-- ---------------------------------------------------------------------------
-- Geography (MSP2-10 rows)
-- ---------------------------------------------------------------------------

-- Replaces the free-text district/region columns the previous schema carried.
-- MSP2-10 aggregates by district across a fixed hierarchy, and free text
-- cannot be aggregated reliably — one misspelling silently drops a branch out
-- of the return.
CREATE TABLE reference.regions (
  code       text     PRIMARY KEY,
  area       text     NOT NULL CHECK (area IN ('mainland','zanzibar')),
  name       text     NOT NULL,
  sort_order smallint NOT NULL,
  UNIQUE (area, name)
);

CREATE TABLE reference.districts (
  code         text     PRIMARY KEY,
  region_code  text     NOT NULL REFERENCES reference.regions (code),
  name         text     NOT NULL,
  council_type text     CHECK (council_type IN ('CC','MC','DC','TC')),
  sort_order   smallint NOT NULL,
  UNIQUE (region_code, name)
);

CREATE INDEX districts_region_idx ON reference.districts (region_code);

COMMENT ON COLUMN reference.districts.council_type IS 'CC City Council, MC Municipal, DC District Council, TC Town Council.';

INSERT INTO reference.regions (code, area, name, sort_order) VALUES
  ('tz_arusha', 'mainland', 'Arusha', 1),
  ('tz_dar_es_salaam', 'mainland', 'Dar Es Salaam', 2),
  ('tz_dodoma', 'mainland', 'Dodoma', 3),
  ('tz_geita', 'mainland', 'Geita', 4),
  ('tz_iringa', 'mainland', 'Iringa', 5),
  ('tz_kagera', 'mainland', 'Kagera', 6),
  ('tz_katavi', 'mainland', 'Katavi', 7),
  ('tz_kigoma', 'mainland', 'Kigoma', 8),
  ('tz_kilimanjaro', 'mainland', 'Kilimanjaro', 9),
  ('tz_lindi', 'mainland', 'Lindi', 10),
  ('tz_manyara', 'mainland', 'Manyara', 11),
  ('tz_mara', 'mainland', 'Mara', 12),
  ('tz_mbeya', 'mainland', 'Mbeya', 13),
  ('tz_morogoro', 'mainland', 'Morogoro', 14),
  ('tz_mtwara', 'mainland', 'Mtwara', 15),
  ('tz_mwanza', 'mainland', 'Mwanza', 16),
  ('tz_njombe', 'mainland', 'Njombe', 17),
  ('tz_pwani', 'mainland', 'Pwani', 18),
  ('tz_rukwa', 'mainland', 'Rukwa', 19),
  ('tz_ruvuma', 'mainland', 'Ruvuma', 20),
  ('tz_shinyanga', 'mainland', 'Shinyanga', 21),
  ('tz_simiyu', 'mainland', 'Simiyu', 22),
  ('tz_singida', 'mainland', 'Singida', 23),
  ('tz_songwe', 'mainland', 'Songwe', 24),
  ('tz_tabora', 'mainland', 'Tabora', 25),
  ('tz_tanga', 'mainland', 'Tanga', 26),
  ('zn_kusini_pemba', 'zanzibar', 'Kusini Pemba', 27),
  ('zn_kaskazini_pemba', 'zanzibar', 'Kaskazini Pemba', 28),
  ('zn_mjini_magharibi_unguja', 'zanzibar', 'Mjini Magharibi Unguja', 29),
  ('zn_kaskazini_unguja', 'zanzibar', 'Kaskazini Unguja', 30),
  ('zn_kusini_unguja', 'zanzibar', 'Kusini Unguja', 31);

INSERT INTO reference.districts (code, region_code, name, council_type, sort_order) VALUES
  ('tz_arusha__arusha_cc', 'tz_arusha', 'Arusha CC', 'CC', 1),
  ('tz_arusha__arusha_dc', 'tz_arusha', 'Arusha DC', 'DC', 2),
  ('tz_arusha__karatu', 'tz_arusha', 'Karatu', NULL, 3),
  ('tz_arusha__longido_dc', 'tz_arusha', 'Longido DC', 'DC', 4),
  ('tz_arusha__meru', 'tz_arusha', 'Meru', NULL, 5),
  ('tz_arusha__monduli', 'tz_arusha', 'Monduli', NULL, 6),
  ('tz_arusha__ngorongoro', 'tz_arusha', 'Ngorongoro', NULL, 7),
  ('tz_dar_es_salaam__ilala_mc', 'tz_dar_es_salaam', 'Ilala MC', 'MC', 8),
  ('tz_dar_es_salaam__kigamboni_mc', 'tz_dar_es_salaam', 'Kigamboni MC', 'MC', 9),
  ('tz_dar_es_salaam__kinondoni_mc', 'tz_dar_es_salaam', 'Kinondoni MC', 'MC', 10),
  ('tz_dar_es_salaam__temeke_mc', 'tz_dar_es_salaam', 'Temeke MC', 'MC', 11),
  ('tz_dar_es_salaam__ubungo_mc', 'tz_dar_es_salaam', 'Ubungo MC', 'MC', 12),
  ('tz_dodoma__bahi_dc', 'tz_dodoma', 'Bahi DC', 'DC', 13),
  ('tz_dodoma__chamwino_dc', 'tz_dodoma', 'Chamwino DC', 'DC', 14),
  ('tz_dodoma__chemba_dc', 'tz_dodoma', 'Chemba DC', 'DC', 15),
  ('tz_dodoma__dodoma_cc', 'tz_dodoma', 'Dodoma CC', 'CC', 16),
  ('tz_dodoma__kondoa_dc', 'tz_dodoma', 'Kondoa DC', 'DC', 17),
  ('tz_dodoma__kondoa_tc', 'tz_dodoma', 'Kondoa TC', 'TC', 18),
  ('tz_dodoma__kongwa_dc', 'tz_dodoma', 'Kongwa DC', 'DC', 19),
  ('tz_dodoma__mpwapwa_dc', 'tz_dodoma', 'Mpwapwa DC', 'DC', 20),
  ('tz_geita__bukombe', 'tz_geita', 'Bukombe', NULL, 21),
  ('tz_geita__chato_dc', 'tz_geita', 'Chato DC', 'DC', 22),
  ('tz_geita__geita_dc', 'tz_geita', 'Geita DC', 'DC', 23),
  ('tz_geita__geita_tc', 'tz_geita', 'Geita TC', 'TC', 24),
  ('tz_geita__mbogwe_dc', 'tz_geita', 'Mbogwe DC', 'DC', 25),
  ('tz_iringa__iringa_dc', 'tz_iringa', 'Iringa DC', 'DC', 26),
  ('tz_iringa__iringa_mc', 'tz_iringa', 'Iringa MC', 'MC', 27),
  ('tz_iringa__kilolo_dc', 'tz_iringa', 'Kilolo DC', 'DC', 28),
  ('tz_iringa__mafinga_tc', 'tz_iringa', 'Mafinga TC', 'TC', 29),
  ('tz_iringa__mufindi_dc', 'tz_iringa', 'Mufindi DC', 'DC', 30),
  ('tz_kagera__biharamulo_dc', 'tz_kagera', 'Biharamulo DC', 'DC', 31),
  ('tz_kagera__bukoba_dc', 'tz_kagera', 'Bukoba DC', 'DC', 32),
  ('tz_kagera__bukoba_mc', 'tz_kagera', 'Bukoba MC', 'MC', 33),
  ('tz_kagera__karagwe_dc', 'tz_kagera', 'Karagwe DC', 'DC', 34),
  ('tz_kagera__kyerwa_dc', 'tz_kagera', 'Kyerwa DC', 'DC', 35),
  ('tz_kagera__missenyi_dc', 'tz_kagera', 'Missenyi DC', 'DC', 36),
  ('tz_kagera__muleba_dc', 'tz_kagera', 'Muleba DC', 'DC', 37),
  ('tz_kagera__ngara_dc', 'tz_kagera', 'Ngara DC', 'DC', 38),
  ('tz_katavi__mlele_dc', 'tz_katavi', 'Mlele DC', 'DC', 39),
  ('tz_katavi__mpanda_dc', 'tz_katavi', 'Mpanda DC', 'DC', 40),
  ('tz_katavi__mpanda_mc', 'tz_katavi', 'Mpanda MC', 'MC', 41),
  ('tz_katavi__mpimbwe_dc', 'tz_katavi', 'Mpimbwe DC', 'DC', 42),
  ('tz_katavi__nsimbo_dc', 'tz_katavi', 'Nsimbo DC', 'DC', 43),
  ('tz_kigoma__buhigwe_dc', 'tz_kigoma', 'Buhigwe DC', 'DC', 44),
  ('tz_kigoma__kakonko_dc', 'tz_kigoma', 'Kakonko DC', 'DC', 45),
  ('tz_kigoma__kasulu_dc', 'tz_kigoma', 'Kasulu DC', 'DC', 46),
  ('tz_kigoma__kasulu_tc', 'tz_kigoma', 'Kasulu TC', 'TC', 47),
  ('tz_kigoma__kibondo_dc', 'tz_kigoma', 'Kibondo DC', 'DC', 48),
  ('tz_kigoma__kigoma_dc', 'tz_kigoma', 'Kigoma DC', 'DC', 49),
  ('tz_kigoma__kigoma_mc', 'tz_kigoma', 'Kigoma MC', 'MC', 50),
  ('tz_kigoma__uvinza_dc', 'tz_kigoma', 'Uvinza DC', 'DC', 51),
  ('tz_kilimanjaro__hai_dc', 'tz_kilimanjaro', 'Hai DC', 'DC', 52),
  ('tz_kilimanjaro__moshi_dc', 'tz_kilimanjaro', 'Moshi DC', 'DC', 53),
  ('tz_kilimanjaro__moshi_mc', 'tz_kilimanjaro', 'Moshi MC', 'MC', 54),
  ('tz_kilimanjaro__mwanga_dc', 'tz_kilimanjaro', 'Mwanga DC', 'DC', 55),
  ('tz_kilimanjaro__rombo_dc', 'tz_kilimanjaro', 'Rombo DC', 'DC', 56),
  ('tz_kilimanjaro__same_dc', 'tz_kilimanjaro', 'Same DC', 'DC', 57),
  ('tz_kilimanjaro__siha_dc', 'tz_kilimanjaro', 'Siha DC', 'DC', 58),
  ('tz_lindi__kilwa_dc', 'tz_lindi', 'Kilwa DC', 'DC', 59),
  ('tz_lindi__lindi_dc', 'tz_lindi', 'Lindi DC', 'DC', 60),
  ('tz_lindi__lindi_mc', 'tz_lindi', 'Lindi MC', 'MC', 61),
  ('tz_lindi__liwale_dc', 'tz_lindi', 'Liwale DC', 'DC', 62),
  ('tz_lindi__nachingwea_dc', 'tz_lindi', 'Nachingwea DC', 'DC', 63),
  ('tz_lindi__ruangwa_dc', 'tz_lindi', 'Ruangwa DC', 'DC', 64),
  ('tz_manyara__babati_dc', 'tz_manyara', 'Babati DC', 'DC', 65),
  ('tz_manyara__babati_tc', 'tz_manyara', 'Babati TC', 'TC', 66),
  ('tz_manyara__hanang_dc', 'tz_manyara', 'Hanang DC', 'DC', 67),
  ('tz_manyara__kiteto_dc', 'tz_manyara', 'Kiteto DC', 'DC', 68),
  ('tz_manyara__mbulu_dc', 'tz_manyara', 'Mbulu DC', 'DC', 69),
  ('tz_manyara__mbulu_tc', 'tz_manyara', 'Mbulu TC', 'TC', 70),
  ('tz_manyara__simanjiro_dc', 'tz_manyara', 'Simanjiro DC', 'DC', 71),
  ('tz_mara__bunda_dc', 'tz_mara', 'Bunda DC', 'DC', 72),
  ('tz_mara__bunda_tc', 'tz_mara', 'Bunda TC', 'TC', 73),
  ('tz_mara__butiama_dc', 'tz_mara', 'Butiama DC', 'DC', 74),
  ('tz_mara__musoma_dc', 'tz_mara', 'Musoma DC', 'DC', 75),
  ('tz_mara__musoma_mc', 'tz_mara', 'Musoma MC', 'MC', 76),
  ('tz_mara__rorya_dc', 'tz_mara', 'Rorya DC', 'DC', 77),
  ('tz_mara__serengeti_dc', 'tz_mara', 'Serengeti DC', 'DC', 78),
  ('tz_mara__tarime_dc', 'tz_mara', 'Tarime DC', 'DC', 79),
  ('tz_mara__tarime_tc', 'tz_mara', 'Tarime TC', 'TC', 80),
  ('tz_mbeya__busokelo_dc', 'tz_mbeya', 'Busokelo DC', 'DC', 81),
  ('tz_mbeya__chunya_dc', 'tz_mbeya', 'Chunya DC', 'DC', 82),
  ('tz_mbeya__kyela_dc', 'tz_mbeya', 'Kyela DC', 'DC', 83),
  ('tz_mbeya__mbarali_dc', 'tz_mbeya', 'Mbarali DC', 'DC', 84),
  ('tz_mbeya__mbeya_cc', 'tz_mbeya', 'Mbeya CC', 'CC', 85),
  ('tz_mbeya__mbeya_dc', 'tz_mbeya', 'Mbeya DC', 'DC', 86),
  ('tz_mbeya__rungwe_dc', 'tz_mbeya', 'Rungwe DC', 'DC', 87),
  ('tz_morogoro__gairo_dc', 'tz_morogoro', 'Gairo DC', 'DC', 88),
  ('tz_morogoro__ifakara_tc', 'tz_morogoro', 'Ifakara TC', 'TC', 89),
  ('tz_morogoro__kilombero_dc', 'tz_morogoro', 'Kilombero DC', 'DC', 90),
  ('tz_morogoro__kilosa_dc', 'tz_morogoro', 'Kilosa DC', 'DC', 91),
  ('tz_morogoro__morogoro_dc', 'tz_morogoro', 'Morogoro DC', 'DC', 92),
  ('tz_morogoro__morogoro_mc', 'tz_morogoro', 'Morogoro MC', 'MC', 93),
  ('tz_morogoro__mvomero_dc', 'tz_morogoro', 'Mvomero DC', 'DC', 94),
  ('tz_morogoro__ulanga_dc', 'tz_morogoro', 'Ulanga DC', 'DC', 95),
  ('tz_mtwara__masasi_dc', 'tz_mtwara', 'Masasi DC', 'DC', 96),
  ('tz_mtwara__masasi_tc', 'tz_mtwara', 'Masasi TC', 'TC', 97),
  ('tz_mtwara__mtwara_dc', 'tz_mtwara', 'Mtwara DC', 'DC', 98),
  ('tz_mtwara__mtwara_mc', 'tz_mtwara', 'Mtwara MC', 'MC', 99),
  ('tz_mtwara__nanyamba_tc', 'tz_mtwara', 'Nanyamba TC', 'TC', 100),
  ('tz_mtwara__nanyumbu_dc', 'tz_mtwara', 'Nanyumbu DC', 'DC', 101),
  ('tz_mtwara__newala_dc', 'tz_mtwara', 'Newala DC', 'DC', 102),
  ('tz_mtwara__newala_tc', 'tz_mtwara', 'Newala TC', 'TC', 103),
  ('tz_mtwara__tandahimba_dc', 'tz_mtwara', 'Tandahimba DC', 'DC', 104),
  ('tz_mwanza__buchosa_dc', 'tz_mwanza', 'Buchosa DC', 'DC', 105),
  ('tz_mwanza__ilemela_mc', 'tz_mwanza', 'Ilemela MC', 'MC', 106),
  ('tz_mwanza__kwimba_dc', 'tz_mwanza', 'Kwimba DC', 'DC', 107),
  ('tz_mwanza__magu_dc', 'tz_mwanza', 'Magu DC', 'DC', 108),
  ('tz_mwanza__misungwi_dc', 'tz_mwanza', 'Misungwi DC', 'DC', 109),
  ('tz_mwanza__sengerema_dc', 'tz_mwanza', 'Sengerema DC', 'DC', 110),
  ('tz_mwanza__ukerewe_dc', 'tz_mwanza', 'Ukerewe DC', 'DC', 111),
  ('tz_njombe__ludewa_dc', 'tz_njombe', 'Ludewa DC', 'DC', 112),
  ('tz_njombe__makambako_tc', 'tz_njombe', 'Makambako TC', 'TC', 113),
  ('tz_njombe__makete_dc', 'tz_njombe', 'Makete DC', 'DC', 114),
  ('tz_njombe__njombe_dc', 'tz_njombe', 'Njombe DC', 'DC', 115),
  ('tz_njombe__njombe_tc', 'tz_njombe', 'Njombe TC', 'TC', 116),
  ('tz_njombe__wanging_ombe_dc', 'tz_njombe', 'Wanging''ombe DC', 'DC', 117),
  ('tz_pwani__bagamoyo_dc', 'tz_pwani', 'Bagamoyo DC', 'DC', 118),
  ('tz_pwani__chalinze_dc', 'tz_pwani', 'Chalinze DC', 'DC', 119),
  ('tz_pwani__kibaha_dc', 'tz_pwani', 'Kibaha DC', 'DC', 120),
  ('tz_pwani__kibaha_tc', 'tz_pwani', 'Kibaha TC', 'TC', 121),
  ('tz_pwani__kibiti_dc', 'tz_pwani', 'Kibiti DC', 'DC', 122),
  ('tz_pwani__kisarawe_dc', 'tz_pwani', 'Kisarawe DC', 'DC', 123),
  ('tz_pwani__mafia_dc', 'tz_pwani', 'Mafia DC', 'DC', 124),
  ('tz_pwani__mkuranga_dc', 'tz_pwani', 'Mkuranga DC', 'DC', 125),
  ('tz_pwani__rufiji_dc', 'tz_pwani', 'Rufiji DC', 'DC', 126),
  ('tz_rukwa__kalambo_dc', 'tz_rukwa', 'Kalambo DC', 'DC', 127),
  ('tz_rukwa__nkasi_dc', 'tz_rukwa', 'Nkasi DC', 'DC', 128),
  ('tz_rukwa__sumbawanga_dc', 'tz_rukwa', 'Sumbawanga DC', 'DC', 129),
  ('tz_rukwa__sumbawanga_mc', 'tz_rukwa', 'Sumbawanga MC', 'MC', 130),
  ('tz_ruvuma__madaba_dc', 'tz_ruvuma', 'Madaba DC', 'DC', 131),
  ('tz_ruvuma__mbinga_dc', 'tz_ruvuma', 'Mbinga DC', 'DC', 132),
  ('tz_ruvuma__mbinga_tc', 'tz_ruvuma', 'Mbinga TC', 'TC', 133),
  ('tz_ruvuma__namtumbo_dc', 'tz_ruvuma', 'Namtumbo DC', 'DC', 134),
  ('tz_ruvuma__nyasa_dc', 'tz_ruvuma', 'Nyasa DC', 'DC', 135),
  ('tz_ruvuma__songea_dc', 'tz_ruvuma', 'Songea DC', 'DC', 136),
  ('tz_ruvuma__songea_mc', 'tz_ruvuma', 'Songea MC', 'MC', 137),
  ('tz_ruvuma__tunduru_dc', 'tz_ruvuma', 'Tunduru DC', 'DC', 138),
  ('tz_shinyanga__kahama_tc', 'tz_shinyanga', 'Kahama TC', 'TC', 139),
  ('tz_shinyanga__kishapu_dc', 'tz_shinyanga', 'Kishapu DC', 'DC', 140),
  ('tz_shinyanga__msalala_dc', 'tz_shinyanga', 'Msalala DC', 'DC', 141),
  ('tz_shinyanga__shinyanga_dc', 'tz_shinyanga', 'Shinyanga DC', 'DC', 142),
  ('tz_shinyanga__shinyanga_mc', 'tz_shinyanga', 'Shinyanga MC', 'MC', 143),
  ('tz_shinyanga__ushetu_dc', 'tz_shinyanga', 'Ushetu DC', 'DC', 144),
  ('tz_simiyu__bariadi_dc', 'tz_simiyu', 'Bariadi DC', 'DC', 145),
  ('tz_simiyu__bariadi_tc', 'tz_simiyu', 'Bariadi TC', 'TC', 146),
  ('tz_simiyu__busega_dc', 'tz_simiyu', 'Busega DC', 'DC', 147),
  ('tz_simiyu__itilima_dc', 'tz_simiyu', 'Itilima DC', 'DC', 148),
  ('tz_simiyu__maswa_dc', 'tz_simiyu', 'Maswa DC', 'DC', 149),
  ('tz_simiyu__meatu_dc', 'tz_simiyu', 'Meatu DC', 'DC', 150),
  ('tz_singida__ikungi_dc', 'tz_singida', 'Ikungi DC', 'DC', 151),
  ('tz_singida__iramba_dc', 'tz_singida', 'Iramba DC', 'DC', 152),
  ('tz_singida__itigi_dc', 'tz_singida', 'Itigi DC', 'DC', 153),
  ('tz_singida__manyoni_dc', 'tz_singida', 'Manyoni DC', 'DC', 154),
  ('tz_singida__mkalama_dc', 'tz_singida', 'Mkalama DC', 'DC', 155),
  ('tz_singida__singida_dc', 'tz_singida', 'Singida DC', 'DC', 156),
  ('tz_singida__singida_mc', 'tz_singida', 'Singida MC', 'MC', 157),
  ('tz_songwe__ileje_dc', 'tz_songwe', 'Ileje DC', 'DC', 158),
  ('tz_songwe__mbozi_dc', 'tz_songwe', 'Mbozi DC', 'DC', 159),
  ('tz_songwe__momba_dc', 'tz_songwe', 'Momba DC', 'DC', 160),
  ('tz_songwe__songwe_dc', 'tz_songwe', 'Songwe DC', 'DC', 161),
  ('tz_songwe__tunduma_tc', 'tz_songwe', 'Tunduma TC', 'TC', 162),
  ('tz_tabora__igunga_dc', 'tz_tabora', 'Igunga DC', 'DC', 163),
  ('tz_tabora__kaliua_dc', 'tz_tabora', 'Kaliua DC', 'DC', 164),
  ('tz_tabora__nzega_dc', 'tz_tabora', 'Nzega DC', 'DC', 165),
  ('tz_tabora__nzega_tc', 'tz_tabora', 'Nzega TC', 'TC', 166),
  ('tz_tabora__sikonge_dc', 'tz_tabora', 'Sikonge DC', 'DC', 167),
  ('tz_tabora__tabora_dc', 'tz_tabora', 'Tabora DC', 'DC', 168),
  ('tz_tabora__tabora_mc', 'tz_tabora', 'Tabora MC', 'MC', 169),
  ('tz_tabora__urambo_dc', 'tz_tabora', 'Urambo DC', 'DC', 170),
  ('tz_tanga__bumbuli_dc', 'tz_tanga', 'Bumbuli DC', 'DC', 171),
  ('tz_tanga__handeni_dc', 'tz_tanga', 'Handeni DC', 'DC', 172),
  ('tz_tanga__handeni_tc', 'tz_tanga', 'Handeni TC', 'TC', 173),
  ('tz_tanga__kilindi_dc', 'tz_tanga', 'Kilindi DC', 'DC', 174),
  ('tz_tanga__korogwe_dc', 'tz_tanga', 'Korogwe DC', 'DC', 175),
  ('tz_tanga__korogwe_tc', 'tz_tanga', 'Korogwe TC', 'TC', 176),
  ('tz_tanga__lushoto_dc', 'tz_tanga', 'Lushoto DC', 'DC', 177),
  ('tz_tanga__mbulu_dc', 'tz_tanga', 'Mbulu DC', 'DC', 178),
  ('tz_tanga__mkinga_dc', 'tz_tanga', 'Mkinga Dc', NULL, 179),
  ('tz_tanga__muheza_dc', 'tz_tanga', 'Muheza DC', 'DC', 180),
  ('tz_tanga__pangani_dc', 'tz_tanga', 'Pangani DC', 'DC', 181),
  ('tz_tanga__tanga_cc', 'tz_tanga', 'Tanga CC', 'CC', 182),
  ('zn_kusini_pemba__chakechake', 'zn_kusini_pemba', 'Chakechake', NULL, 183),
  ('zn_kusini_pemba__mkoani', 'zn_kusini_pemba', 'Mkoani', NULL, 184),
  ('zn_kaskazini_pemba__micheweni', 'zn_kaskazini_pemba', 'Micheweni', NULL, 185),
  ('zn_kaskazini_pemba__wete', 'zn_kaskazini_pemba', 'Wete', NULL, 186),
  ('zn_mjini_magharibi_unguja__magharibi_a', 'zn_mjini_magharibi_unguja', 'Magharibi A', NULL, 187),
  ('zn_mjini_magharibi_unguja__magharibi_b', 'zn_mjini_magharibi_unguja', 'Magharibi B', NULL, 188),
  ('zn_mjini_magharibi_unguja__mjini', 'zn_mjini_magharibi_unguja', 'Mjini', NULL, 189),
  ('zn_kaskazini_unguja__kaskazini_a', 'zn_kaskazini_unguja', 'Kaskazini A', NULL, 190),
  ('zn_kaskazini_unguja__kaskazini_b', 'zn_kaskazini_unguja', 'Kaskazini B', NULL, 191),
  ('zn_kusini_unguja__kati', 'zn_kusini_unguja', 'Kati', NULL, 192),
  ('zn_kusini_unguja__kusini', 'zn_kusini_unguja', 'Kusini', NULL, 193);

-- ---------------------------------------------------------------------------
-- Financial institutions and mobile network operators (MSP2-07, MSP2-08)
-- ---------------------------------------------------------------------------

-- BOT publishes two overlapping lists: one for deposit and borrowing
-- balances (MSP2-07) and one for agent-banking balances (MSP2-08). Held as a
-- single table with a flag per list, since most institutions appear on both
-- and duplicating them would let the two copies drift.
CREATE TABLE reference.financial_institutions (
  code                   text     PRIMARY KEY,
  name                   text     NOT NULL UNIQUE,
  kind                   text     NOT NULL CHECK (kind IN ('bank','mno')),
  in_deposits_list       boolean  NOT NULL DEFAULT false,
  in_agent_banking_list  boolean  NOT NULL DEFAULT false,
  sort_order             smallint NOT NULL
);

INSERT INTO reference.financial_institutions
  (code, name, kind, in_deposits_list, in_agent_banking_list, sort_order) VALUES
  ('absa_bank_tanzania_limited', 'ABSA BANK TANZANIA LIMITED', 'bank', true, true, 1),
  ('accessbank_tanzania_limited', 'ACCESSBANK (TANZANIA) LIMITED', 'bank', true, true, 2),
  ('african_banking_corporation_t_ltd', 'AFRICAN BANKING CORPORATION (T) LTD', 'bank', true, true, 3),
  ('akiba_commercial_bank_ltd', 'AKIBA COMMERCIAL BANK LTD', 'bank', true, true, 4),
  ('alios_finance_tanzania_limited', 'ALIOS FINANCE TANZANIA LIMITED', 'bank', true, false, 5),
  ('amana_bank_limited', 'AMANA BANK LIMITED', 'bank', true, true, 6),
  ('azania_bank_limited', 'AZANIA BANK LIMITED', 'bank', true, true, 7),
  ('bank_of_baroda_tanzania_limited', 'BANK OF BARODA TANZANIA LIMITED', 'bank', true, true, 8),
  ('bank_of_india_tanzania_limited', 'BANK OF INDIA (TANZANIA) LIMITED', 'bank', true, true, 9),
  ('bank_of_tanzania', 'BANK OF TANZANIA', 'bank', true, false, 10),
  ('boa_bank', 'BOA BANK', 'bank', true, true, 11),
  ('canara_bank_tanzania_limited', 'CANARA BANK TANZANIA LIMITED', 'bank', true, true, 12),
  ('china_commercial_bank_limited', 'CHINA COMMERCIAL BANK LIMITED', 'bank', true, true, 13),
  ('china_dasheng_bank_limited', 'CHINA DASHENG BANK LIMITED', 'bank', true, true, 14),
  ('citibank_t_ltd', 'CITIBANK (T) LTD', 'bank', true, true, 15),
  ('commercial_bank_of_africa_t_limited', 'COMMERCIAL BANK OF AFRICA (T) LIMITED', 'bank', true, true, 16),
  ('crdb_bank_plc', 'CRDB BANK PLC', 'bank', true, true, 17),
  ('dcb_commercial_bank_plc', 'DCB COMMERCIAL BANK PLC', 'bank', true, true, 18),
  ('diamond_trust_bank_t_ltd', 'DIAMOND TRUST BANK (T) LTD.', 'bank', true, true, 19),
  ('ecobank_tanzania_limited', 'ECOBANK TANZANIA LIMITED', 'bank', true, true, 20),
  ('efc_m_f_b_tanzania_limited', 'EFC M.F.B TANZANIA LIMITED', 'bank', true, true, 21),
  ('equity_bank_tanzania_limited', 'EQUITY BANK TANZANIA LIMITED', 'bank', true, true, 22),
  ('exim_bank_tanzania_limited', 'EXIM BANK TANZANIA LIMITED', 'bank', true, true, 23),
  ('finca_m_f_b_tanzania_limited', 'FINCA M.F.B TANZANIA LIMITED', 'bank', true, true, 24),
  ('first_housing_finance_tanzania_limited', 'FIRST HOUSING FINANCE (TANZANIA) LIMITED', 'bank', true, false, 25),
  ('first_national_bank_tanzania_limited', 'FIRST NATIONAL BANK TANZANIA LIMITED', 'bank', true, true, 26),
  ('guaranty_trust_bank_tanzania_limited', 'GUARANTY TRUST BANK (TANZANIA) LIMITED', 'bank', true, true, 27),
  ('habib_african_bank', 'HABIB AFRICAN BANK', 'bank', true, true, 28),
  ('hakika_microfinance_bank_limited', 'HAKIKA MICROFINANCE BANK LIMITED', 'bank', true, true, 29),
  ('i_m_bank_tanzania_limited', 'I & M BANK TANZANIA LIMITED', 'bank', true, true, 30),
  ('international_commercial_bank_t_ltd', 'INTERNATIONAL COMMERCIAL BANK  (T) LTD.', 'bank', true, true, 31),
  ('kcb_bank_tanzania_limited', 'KCB BANK TANZANIA LIMITED', 'bank', true, true, 32),
  ('kilimanjaro_cooperative_bank', 'KILIMANJARO COOPERATIVE BANK', 'bank', true, true, 33),
  ('letshego_bank_t_limited', 'LETSHEGO BANK (T) LIMITED', 'bank', true, true, 34),
  ('maendeleo_bank_plc', 'MAENDELEO BANK PLC', 'bank', true, true, 35),
  ('mkombozi_commercial_bank_limited', 'MKOMBOZI COMMERCIAL BANK LIMITED', 'bank', true, true, 36),
  ('mufindi_community_bank_ltd', 'MUFINDI COMMUNITY BANK LTD', 'bank', true, true, 37),
  ('mwalimu_commercial_bank_public_limited_company', 'MWALIMU COMMERCIAL BANK PUBLIC LIMITED COMPANY', 'bank', true, true, 38),
  ('mwanga_rural_community_bank', 'MWANGA RURAL COMMUNITY BANK', 'bank', true, true, 39),
  ('national_microfinance_bank_t_ltd', 'NATIONAL MICROFINANCE BANK (T) LTD.', 'bank', true, true, 40),
  ('nbc_limited', 'NBC LIMITED', 'bank', true, true, 41),
  ('nic_bank_tanzania_limited', 'NIC BANK TANZANIA LIMITED', 'bank', true, true, 42),
  ('peoples_bank_of_zanzibar', 'PEOPLES BANK OF ZANZIBAR', 'bank', true, true, 43),
  ('stanbic_bank_t_ltd', 'STANBIC BANK (T) LTD', 'bank', true, true, 44),
  ('standard_chartered_bank_t_ltd', 'STANDARD CHARTERED BANK (T) LTD', 'bank', true, true, 45),
  ('tandahimba_community_bank_ltd', 'TANDAHIMBA COMMUNITY BANK LTD', 'bank', true, true, 46),
  ('tanzania_agricultural_development_bank', 'TANZANIA AGRICULTURAL DEVELOPMENT BANK', 'bank', true, true, 47),
  ('tanzania_mortgage_refinance_company_ltd', 'TANZANIA MORTGAGE REFINANCE COMPANY LTD', 'bank', true, false, 48),
  ('tanzania_postal_bank', 'TANZANIA POSTAL BANK', 'bank', true, true, 49),
  ('tib_corporate_finance_limited', 'TIB CORPORATE FINANCE LIMITED', 'bank', true, true, 50),
  ('tib_development_bank_limited', 'TIB DEVELOPMENT BANK LIMITED', 'bank', true, true, 51),
  ('uchumi_commercial_bank_limited', 'UCHUMI COMMERCIAL BANK LIMITED', 'bank', true, true, 52),
  ('united_bank_for_africa', 'UNITED BANK FOR AFRICA', 'bank', true, true, 53),
  ('vision_fund_tanzania_m_f_c_limited', 'VISION FUND TANZANIA M.F.C LIMITED', 'bank', true, true, 54),
  ('yetu_microfinance_plc', 'YETU MICROFINANCE PLC', 'bank', true, true, 55),
  ('mpesa', 'MPESA', 'mno', true, false, 56),
  ('airtel_money', 'AIRTEL MONEY', 'mno', true, false, 57),
  ('t_pesa', 'T-PESA', 'mno', true, false, 58),
  ('halopesa', 'HALOPESA', 'mno', true, false, 59),
  ('tigopesa', 'TIGOPESA', 'mno', true, false, 60),
  ('zpesa', 'ZPESA', 'mno', true, false, 61);

-- ---------------------------------------------------------------------------
-- Financial statement line items (MSP2-01, MSP2-02)
-- ---------------------------------------------------------------------------

-- BOT’s cross-form validation rules address cells by Sno, not by spreadsheet
-- position — "C67=MSP2_04C15" means column C at Sno 67. So Sno is the wire
-- identifier, and the exporter writes by (form, sno, column) rather than by
-- a hardcoded row index.
CREATE TABLE reference.form_lines (
  form_code   text     NOT NULL,
  sno         smallint NOT NULL,
  label       text     NOT NULL,
  -- True where BOT’s template computes the line from others rather than
  -- accepting entry. Such a line is derived, never filled in.
  is_computed boolean  NOT NULL,
  -- The template’s own formula, retained so a future template revision can be
  -- diffed against what this system implements.
  formula     text,
  PRIMARY KEY (form_code, sno)
);

INSERT INTO reference.form_lines (form_code, sno, label, is_computed, formula) VALUES
  ('MSP2-01', 1, '1. CASH AND CASH EQUIVALENTS (sum a:d)', true, '=SUM(C15:C16,C19:C20)'),
  ('MSP2-01', 2, '(a) Cash in Hand', false, NULL),
  ('MSP2-01', 3, '(b) Balances with  Banks and Financial Institutions (sum i:ii)', true, '=SUM(C17:C18)'),
  ('MSP2-01', 4, '(i) Non-Agent Banking  Balances', false, NULL),
  ('MSP2-01', 5, '(ii) Agent-Banking Balances', false, NULL),
  ('MSP2-01', 6, '(c ) Balances with Microfinance Service Providers', false, NULL),
  ('MSP2-01', 7, '(d) MNOs Float  Balances', false, NULL),
  ('MSP2-01', 8, '2. INVESTMENT IN DEBT SECURITIES - NET (Sum a:d minus e)', true, '=SUM(C22:C25)-C26'),
  ('MSP2-01', 9, '(a )Treasury Bills', false, NULL),
  ('MSP2-01', 10, '(b) Other Government Securities', false, NULL),
  ('MSP2-01', 11, '(c) Private Securities', false, NULL),
  ('MSP2-01', 12, '(d) Others', false, NULL),
  ('MSP2-01', 13, '(e) Allowance for Probable Losses (Deduction)', false, NULL),
  ('MSP2-01', 14, '3. EQUITY INVESTMENTS - NET (a - b)', true, '=C28-C29'),
  ('MSP2-01', 15, '(a) Equity Investment', false, NULL),
  ('MSP2-01', 16, '(b) Allowance for Probable Losses (Deduction)', false, NULL),
  ('MSP2-01', 17, '4. LOANS - NET (sum a:d less e)', true, '=C31+C32+C33+C34-C35'),
  ('MSP2-01', 18, '(a) Loans to Clients', false, NULL),
  ('MSP2-01', 19, '(b) Loan to Staff and Related Parties', false, NULL),
  ('MSP2-01', 20, '(c)Loans to other Microfinance Service Providers', false, NULL),
  ('MSP2-01', 21, '(d) Accrued Interest on Loans', false, NULL),
  ('MSP2-01', 22, '(e) Allowances for Probable Losses (Deduction)', false, NULL),
  ('MSP2-01', 23, '5. PROPERTY, PLANT AND EQUIPMENT -NET (a -b)', true, '=C37-C38'),
  ('MSP2-01', 24, '(a) Property, Plant and Equipment', false, NULL),
  ('MSP2-01', 25, '(b) Accumulated Depreciation (Deduction)', false, NULL),
  ('MSP2-01', 26, '6. OTHER ASSETS (sum a:e less f)', true, '=SUM(C40:C44)-C45'),
  ('MSP2-01', 27, '(a) Receivables', false, NULL),
  ('MSP2-01', 28, '(b) Prepaid Expenses', false, NULL),
  ('MSP2-01', 29, '(c )Deffered Tax Assets', false, NULL),
  ('MSP2-01', 30, '(d )Intangible Assets', false, NULL),
  ('MSP2-01', 31, '(e) Miscellaneous Assets', false, NULL),
  ('MSP2-01', 32, '(f) Allowance for Probable Losses  (Deduction)', false, NULL),
  ('MSP2-01', 33, '7. TOTAL ASSETS', true, '=C14+C21+C27+C30+C36+C39'),
  ('MSP2-01', 34, '8. LIABILITIES', false, NULL),
  ('MSP2-01', 35, '9.  BORROWINGS (sum a:b)', true, '=C49+C55'),
  ('MSP2-01', 36, '(a)Borrowings in Tanzania (sum i:v)', true, '=SUM(C50:C54)'),
  ('MSP2-01', 37, '(i) Borrowings from Banks and Financial Institutions', false, NULL),
  ('MSP2-01', 38, '(ii) Borrowings from Other Microfinance Service Providers', false, NULL),
  ('MSP2-01', 39, '(iii) Borrowing from Shareholders', false, NULL),
  ('MSP2-01', 40, '(iv) Borrowing from Public through Debt Securities', false, NULL),
  ('MSP2-01', 41, '(v) Other Borrowings', false, NULL),
  ('MSP2-01', 42, '(b)Borrowings from Abroad (sum i:iii)', true, '=SUM(C56:C58)'),
  ('MSP2-01', 43, '(i) Borrowings from Banks and Financial Institutions', false, NULL),
  ('MSP2-01', 44, '(ii) Borrowing from Shareholders', false, NULL),
  ('MSP2-01', 45, '(iii) Other Borrowings', false, NULL),
  ('MSP2-01', 46, '10. CASH COLLATERAL/LOAN INSURANCE GUARANTEES/COMPULSORY SAVINGS', false, NULL),
  ('MSP2-01', 47, '11.TAX PAYABLES', false, NULL),
  ('MSP2-01', 48, '12. DIVIDEND PAYABLES', false, NULL),
  ('MSP2-01', 49, '13. OTHER PAYABLES AND ACCRUALS', false, NULL),
  ('MSP2-01', 50, '14. TOTAL LIABILITIES (sum 9:13)', true, '=C48+C59+C60+C61+C62'),
  ('MSP2-01', 51, '15. TOTAL CAPITAL (sum a:i)', true, '=SUM(C65:C73)'),
  ('MSP2-01', 52, '(a) Paid-up Ordinary Share Capital', false, NULL),
  ('MSP2-01', 53, '(b) Paid-up Preference Shares', false, NULL),
  ('MSP2-01', 54, '(c) Capital Grants', false, NULL),
  ('MSP2-01', 55, '(d) Donations', false, NULL),
  ('MSP2-01', 56, '(e) Share Premium', false, NULL),
  ('MSP2-01', 57, '(f) General Reserves', false, NULL),
  ('MSP2-01', 58, '(g) Retained Earnings', false, NULL),
  ('MSP2-01', 59, '(h) Profit/Loss', false, NULL),
  ('MSP2-01', 60, '(i) Other Reserves', false, NULL),
  ('MSP2-01', 61, '16. TOTAL LIABILITIES AND CAPITAL (14+15)', true, '=C63+C64'),
  ('MSP2-02', 1, '1. INTEREST INCOME', true, '=SUM(C15:C19)'),
  ('MSP2-02', 2, 'a. Interest - Loans to Clients', false, NULL),
  ('MSP2-02', 3, 'b. Interest - Loans to Microfinance Service Providers', false, NULL),
  ('MSP2-02', 4, 'c. Interest - Investments in Govt Securities', false, NULL),
  ('MSP2-02', 5, 'd. Interest - Bank Deposits', false, NULL),
  ('MSP2-02', 6, 'e. Interest - Others', false, NULL),
  ('MSP2-02', 7, '2. INTEREST EXPENSE', true, '=SUM(C21:C25)'),
  ('MSP2-02', 8, 'a. Interest - Borrowings  from Banks & Financial Institutions in Tanzania', false, NULL),
  ('MSP2-02', 9, 'b. Interest - Borrowing from Microfinance Service Providers in Tanzania', false, NULL),
  ('MSP2-02', 10, 'c. Interest - Borrowings from Abroad', false, NULL),
  ('MSP2-02', 11, 'd. Interest - Borrowing from Shareholders', false, NULL),
  ('MSP2-02', 12, 'e. Interest - Others', false, NULL),
  ('MSP2-02', 13, '3. NET INTEREST INCOME (1 less 2)', true, '=C14-C20'),
  ('MSP2-02', 14, '4. BAD DEBTS WRITTEN OFF NOT PROVIDED FOR', false, NULL),
  ('MSP2-02', 15, '5. PROVISION FOR BAD AND DOUBTFUL DEBTS', false, NULL),
  ('MSP2-02', 16, '6. NON-INTEREST INCOME', true, '=SUM(C30:C35)'),
  ('MSP2-02', 17, 'a. Commisions', false, NULL),
  ('MSP2-02', 18, 'b.  Fees', false, NULL),
  ('MSP2-02', 19, 'c.  Rental Income on Premises', false, NULL),
  ('MSP2-02', 20, 'd.  Dividends on Equity Investment', false, NULL),
  ('MSP2-02', 21, 'e.  Income from Recovery of Charged off Assets and Acquired Assets', false, NULL),
  ('MSP2-02', 22, 'f.  Other Income', false, NULL),
  ('MSP2-02', 23, '7. NON-INTEREST EXPENSES', true, '=SUM(C37:C52)'),
  ('MSP2-02', 24, 'a. Managements'' Salaries and Benefits', false, NULL),
  ('MSP2-02', 25, 'b. Employees'' Salaries and Benefits', false, NULL),
  ('MSP2-02', 26, 'c. Wages', false, NULL),
  ('MSP2-02', 27, 'd. Pensions Contributions', false, NULL),
  ('MSP2-02', 28, 'e. Skills and Development Levy', false, NULL),
  ('MSP2-02', 29, 'f. Rental Expense on Premises and Equipment', false, NULL),
  ('MSP2-02', 30, 'g. Depreciation - Premises and Equipment', false, NULL),
  ('MSP2-02', 31, 'h. Amortization - Leasehold Rights and Equipments', false, NULL),
  ('MSP2-02', 32, 'i. Foreclosure  and Litigation Expenses', false, NULL),
  ('MSP2-02', 33, 'j. Management Fees', false, NULL),
  ('MSP2-02', 34, 'k. Auditors Fees', false, NULL),
  ('MSP2-02', 35, 'l. Taxes', false, NULL),
  ('MSP2-02', 36, 'm. License Fees', false, NULL),
  ('MSP2-02', 37, 'n. Insurance', false, NULL),
  ('MSP2-02', 38, 'o. Utilities Expenses', false, NULL),
  ('MSP2-02', 39, 'p. Other Non-Interest Expenses', false, NULL),
  ('MSP2-02', 40, '8. NET INCOME / (LOSS) BEFORE INCOME TAX (3+6 Less 4,5 and 7)', true, '=C26+C29-SUM(C27:C28,C36)'),
  ('MSP2-02', 41, '9. INCOME TAX PROVISION', false, NULL),
  ('MSP2-02', 42, '10. NET INCOME / (LOSS) AFTER INCOME TAX (8 less 9)', true, '=C53-C54');

-- ---------------------------------------------------------------------------
-- Cross-form validation rules
-- ---------------------------------------------------------------------------

-- Run as pre-submission checks. A report that fails one of these is not
-- exported: a compliance product that quietly files inconsistent numbers is
-- worse than one that refuses to file.
CREATE TABLE reference.validation_rules (
  id        smallint PRIMARY KEY,
  form_code text     NOT NULL,
  rule      text     NOT NULL
);

INSERT INTO reference.validation_rules (id, form_code, rule) VALUES
  (1, 'MSP2-01', 'Sno33 (Total Assets) = Sno61 (Total Liabilities and Capital)'),
  (2, 'MSP2-02', 'Sno42 YTD (Net Income after Tax) = MSP2-01 Sno59 (Profit/Loss)'),
  (3, 'MSP2-03', 'Sno67 col C (Total Borrowers) = MSP2-04 Sno15 col C (Total Borrowers)'),
  (4, 'MSP2-04', 'Sno15 col D (Total Outstanding) = MSP2-01 Sno17 (Loans-Net) + Sno22 (Allowance)'),
  (5, 'MSP2-05', 'Sno2=MSP2-01 Sno2; Sno3=MSP2-01 Sno3; Sno4=MSP2-01 Sno6; Sno5=MSP2-01 Sno7'),
  (6, 'MSP2-05', 'Liquid Asset Ratio = A/B; Required Minimum = 5% of Total Assets'),
  (7, 'MSP2-06', 'For each row: col C (Number) = sum of nature columns E..J'),
  (8, 'MSP2-06', 'Sno5 (Unresolved at end) = Sno1 + Sno2 - Sno3 - Sno4'),
  (9, 'MSP2-07', 'Sno30 col H = MSP2-01 Sno37 (Borrowings from Banks/FI in TZ)'),
  (10, 'MSP2-07', 'Sno46 col E = MSP2-01 Sno6; Sno46 col H = MSP2-01 Sno38'),
  (11, 'MSP2-07', 'Sno56 col E = MSP2-01 Sno7 (MNO float)'),
  (12, 'MSP2-07', 'Sno57 col E = MSP2-01 Sno3 + Sno6 + Sno7'),
  (13, 'MSP2-07', 'Sno65 col H = MSP2-01 Sno43 (Borrowings from Banks abroad)'),
  (14, 'MSP2-07', 'Sno66 col E = MSP2-01 Sno3 (Balances with Banks)'),
  (15, 'MSP2-08', 'Sno30 (Total agent banking balances) = MSP2-01 Sno5 (Agent-Banking Balances)'),
  (16, 'MSP2-10', 'Sno229 col E (Grand total compulsory savings) = MSP2-01 Sno46 (Cash Collateral/Loan Insurance/Compulsory Savings)'),
  (17, 'MSP2-03', 'Per sector: Total Outstanding = Current + ESM + Substandard + Doubtful + Loss'),
  (18, 'MSP2-03', 'NPL ratio = (Substandard + Doubtful + Loss) / Total Outstanding * 100');

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

-- Read only. Reference data is BOT’s, not the institution’s: it changes when
-- BOT revises a template, through a reviewed migration, never at runtime.
GRANT SELECT ON ALL TABLES IN SCHEMA reference TO mfi_app;
