#!/usr/bin/env node
/**
 * Generates the BOT reference-data migration from the taxonomies extracted
 * out of BOT's own template.
 *
 * The chain is deliberate and one-directional:
 *
 *   BOT-MSP2-template.xlsx
 *     → docs/reference/extract-bot-taxonomies.py   (reads the workbook)
 *     → docs/reference/bot-taxonomies.json         (machine-readable)
 *     → this script
 *     → db/migrations/0004_bot_reference_data.sql  (committed, immutable)
 *
 * Nothing in that chain is retyped by hand. Twenty-two sectors, 193 districts
 * and 103 financial-statement line items transcribed manually would contain
 * errors, and every one of them would surface as a wrong regulatory filing
 * rather than as a crash.
 *
 * When BOT revises its template, re-run the extractor and this script, and
 * commit the output as a *new* migration. Applied migrations are immutable —
 * see db/migrations/README.md.
 *
 * Usage: node scripts/generate-bot-reference-migration.mjs [outputPath]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = resolve(ROOT, 'docs/reference/bot-taxonomies.json');
const DEFAULT_OUTPUT = resolve(ROOT, 'db/migrations/0004_bot_reference_data.sql');

/** Quote a string as a SQL literal. */
const lit = (value) =>
  value === null || value === undefined ? 'NULL' : `'${String(value).replace(/'/g, "''")}'`;

/** Stable, readable identifier derived from a display name. */
const slug = (value) =>
  String(value)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

/** Council type encoded in a district's name suffix, if any. */
function councilType(name) {
  const match = /\s(CC|MC|DC|TC)$/.exec(name.trim());
  return match ? match[1] : null;
}

/**
 * Day range and BOT classification for a provisioning band label.
 *
 * The standard schedule's five bands align one-to-one, in order, with MSP2-03's
 * five classification columns (Current, ESM, Substandard, Doubtful, Loss).
 *
 * The housing schedule lists only three bands. Their rates (25%, 50%, 100%)
 * equal the standard schedule's Substandard, Doubtful and Loss rates, so they
 * are mapped to those classifications. That mapping is an inference from the
 * rates, not something the template states — and the template says nothing at
 * all about how a housing loan between 0 and 90 days overdue is classified.
 * Recorded as an open question in 02-BOT-REPORTING-SPEC.md §11.5.
 */
function parseBand(label) {
  const unbounded = /^>\s*(\d+)\s*days$/.exec(label);
  if (unbounded) {
    return { minDays: Number(unbounded[1]) + 1, maxDays: null };
  }
  const range = /^(\d+)\s*-\s*(\d+)\s*days$/.exec(label);
  if (range) {
    return { minDays: Number(range[1]), maxDays: Number(range[2]) };
  }
  throw new Error(`Unrecognised provisioning band label: ${label}`);
}

const STANDARD_CLASSIFICATIONS = ['current', 'esm', 'substandard', 'doubtful', 'loss'];
const HOUSING_CLASSIFICATIONS = ['substandard', 'doubtful', 'loss'];

function main() {
  const outputPath = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_OUTPUT;
  const data = JSON.parse(readFileSync(SOURCE, 'utf8'));
  const out = [];
  const w = (line = '') => out.push(line);

  w('-- BOT MSP2 reference data.');
  w('--');
  w('-- GENERATED FILE — do not edit by hand.');
  w('-- Produced by scripts/generate-bot-reference-migration.mjs from');
  w('-- docs/reference/bot-taxonomies.json, which was extracted from BOT’s own');
  w('-- MSP2 template. See docs/02-BOT-REPORTING-SPEC.md.');
  w('--');
  w('-- These tables live in the `reference` schema rather than `public` because');
  w('-- they hold no institution data. That separation is structural rather than');
  w('-- conventional: the tenant-isolation invariants apply to every table in');
  w('-- `public`, so a table only escapes them by being somewhere that visibly is');
  w('-- not tenant storage. The application role is granted SELECT and nothing');
  w('-- else — reference data changes by migration, never at runtime.');
  w();
  w('CREATE SCHEMA IF NOT EXISTS reference;');
  w('GRANT USAGE ON SCHEMA reference TO mfi_app;');
  w('REVOKE CREATE ON SCHEMA reference FROM mfi_app;');
  w();

  // ── Sectors ───────────────────────────────────────────────────────────────
  w('-- ---------------------------------------------------------------------------');
  w('-- Economic sectors (MSP2-03 rows, MSP2-09 rows)');
  w('-- ---------------------------------------------------------------------------');
  w();
  w('CREATE TABLE reference.sectors (');
  w('  code text     PRIMARY KEY,');
  w('  sno  smallint NOT NULL UNIQUE,');
  w('  name text     NOT NULL UNIQUE');
  w(');');
  w();
  w(
    "COMMENT ON TABLE reference.sectors IS 'BOT sector taxonomy. Fixed list; loans and clients reference it.';",
  );
  w();
  w('INSERT INTO reference.sectors (code, sno, name) VALUES');
  w(
    data.sectors
      .map((name, index) => `  (${lit(slug(name))}, ${index + 1}, ${lit(name)})`)
      .join(',\n') + ';',
  );
  w();

  // ── Loan types ────────────────────────────────────────────────────────────
  // MSP2-04 lists 12 reportable types; "Salaried Loans" splits into two
  // sub-rows that report separately but roll up to their parent.
  const loanTypes = [];
  let parentOfSalaried = null;
  for (const { label } of data.loan_types) {
    const isSubRow = /^\(\w\)\s/.test(label);
    const cleaned = label.replace(/^\(\w\)\s*/, '');
    const code = slug(cleaned);
    if (!isSubRow) {
      parentOfSalaried = /salaried/i.test(cleaned) ? code : null;
    }
    loanTypes.push({
      code,
      name: cleaned,
      parent: isSubRow ? parentOfSalaried : null,
      housing: /housing/i.test(cleaned),
    });
  }

  w('-- ---------------------------------------------------------------------------');
  w('-- Loan types (MSP2-04 rows)');
  w('-- ---------------------------------------------------------------------------');
  w();
  w('CREATE TABLE reference.loan_types (');
  w('  code                      text     PRIMARY KEY,');
  w('  sno                       smallint NOT NULL UNIQUE,');
  w('  name                      text     NOT NULL,');
  w('  parent_code               text     REFERENCES reference.loan_types (code),');
  w('  -- Housing microfinance loans classify on a separate, longer provisioning');
  w('  -- schedule. A housing loan 100 days overdue provisions at 25%; any other');
  w('  -- loan at 100 days provisions at 100%. See 02-BOT-REPORTING-SPEC.md §4.1.');
  w("  provisioning_schedule     text     NOT NULL DEFAULT 'standard'");
  w(');');
  w();
  w(
    "COMMENT ON TABLE reference.loan_types IS 'BOT loan type taxonomy. Salaried Loans reports as two sub-rows rolling up to a parent.';",
  );
  w();
  w(
    'INSERT INTO reference.loan_types (code, sno, name, parent_code, provisioning_schedule) VALUES',
  );
  w(
    loanTypes
      .map(
        (type, index) =>
          `  (${lit(type.code)}, ${index + 1}, ${lit(type.name)}, ${lit(type.parent)}, ${lit(
            type.housing ? 'housing' : 'standard',
          )})`,
      )
      .join(',\n') + ';',
  );
  w();

  // ── Provisioning ──────────────────────────────────────────────────────────
  w('-- ---------------------------------------------------------------------------');
  w('-- Loan-loss provisioning schedules (MSP2-03)');
  w('-- ---------------------------------------------------------------------------');
  w();
  w('-- Versioned with effective dates because BOT can revise the rates, and a');
  w('-- report for a past quarter must be reproducible with the rates that applied');
  w('-- then. 02-BOT-REPORTING-SPEC.md §11.1 records that as an open question.');
  w('CREATE TABLE reference.provisioning_schedules (');
  w('  code           text PRIMARY KEY,');
  w('  name           text NOT NULL,');
  w('  effective_from date NOT NULL,');
  w('  effective_to   date,');
  w(
    '  CONSTRAINT provisioning_schedules_period CHECK (effective_to IS NULL OR effective_to > effective_from)',
  );
  w(');');
  w();
  w('CREATE TABLE reference.provisioning_bands (');
  w('  schedule_code    text        NOT NULL REFERENCES reference.provisioning_schedules (code),');
  w('  classification   text        NOT NULL');
  w(
    "                               CHECK (classification IN ('current','esm','substandard','doubtful','loss')),",
  );
  w('  min_days_overdue integer     NOT NULL CHECK (min_days_overdue >= 0),');
  w(
    '  max_days_overdue integer     CHECK (max_days_overdue IS NULL OR max_days_overdue >= min_days_overdue),',
  );
  w('  provision_rate   numeric(5,4) NOT NULL CHECK (provision_rate BETWEEN 0 AND 1),');
  w('  PRIMARY KEY (schedule_code, classification)');
  w(');');
  w();
  w(
    "COMMENT ON TABLE reference.provisioning_bands IS 'Days-past-due bands and provision rates, read from BOT’s MSP2-03 sheet.';",
  );
  w();
  w('INSERT INTO reference.provisioning_schedules (code, name, effective_from) VALUES');
  w("  ('standard', 'Standard microfinance loan classification', DATE '2021-01-01'),");
  w("  ('housing', 'Housing microfinance loan classification', DATE '2021-01-01');");
  w();

  const bandRows = [];
  data.provisioning_standard.forEach((band, index) => {
    const { minDays, maxDays } = parseBand(band.band);
    bandRows.push(
      `  ('standard', ${lit(STANDARD_CLASSIFICATIONS[index])}, ${minDays}, ${
        maxDays === null ? 'NULL' : maxDays
      }, ${band.rate})`,
    );
  });
  data.provisioning_housing.forEach((band, index) => {
    const { minDays, maxDays } = parseBand(band.band);
    bandRows.push(
      `  ('housing', ${lit(HOUSING_CLASSIFICATIONS[index])}, ${minDays}, ${
        maxDays === null ? 'NULL' : maxDays
      }, ${band.rate})`,
    );
  });

  w('INSERT INTO reference.provisioning_bands');
  w('  (schedule_code, classification, min_days_overdue, max_days_overdue, provision_rate) VALUES');
  w(bandRows.join(',\n') + ';');
  w();

  // ── Complaint natures ─────────────────────────────────────────────────────
  w('-- ---------------------------------------------------------------------------');
  w('-- Complaint natures (MSP2-06 columns)');
  w('-- ---------------------------------------------------------------------------');
  w();
  w('CREATE TABLE reference.complaint_natures (');
  w('  code text     PRIMARY KEY,');
  w('  sno  smallint NOT NULL UNIQUE,');
  w('  name text     NOT NULL UNIQUE');
  w(');');
  w();
  w('INSERT INTO reference.complaint_natures (code, sno, name) VALUES');
  w(
    data.complaint_natures
      .map((name, index) => `  (${lit(slug(name))}, ${index + 1}, ${lit(name)})`)
      .join(',\n') + ';',
  );
  w();

  // ── Geography ─────────────────────────────────────────────────────────────
  w('-- ---------------------------------------------------------------------------');
  w('-- Geography (MSP2-10 rows)');
  w('-- ---------------------------------------------------------------------------');
  w();
  w('-- Replaces the free-text district/region columns the previous schema carried.');
  w('-- MSP2-10 aggregates by district across a fixed hierarchy, and free text');
  w('-- cannot be aggregated reliably — one misspelling silently drops a branch out');
  w('-- of the return.');
  w('CREATE TABLE reference.regions (');
  w('  code       text     PRIMARY KEY,');
  w("  area       text     NOT NULL CHECK (area IN ('mainland','zanzibar')),");
  w('  name       text     NOT NULL,');
  w('  sort_order smallint NOT NULL,');
  w('  UNIQUE (area, name)');
  w(');');
  w();
  w('CREATE TABLE reference.districts (');
  w('  code         text     PRIMARY KEY,');
  w('  region_code  text     NOT NULL REFERENCES reference.regions (code),');
  w('  name         text     NOT NULL,');
  w("  council_type text     CHECK (council_type IN ('CC','MC','DC','TC')),");
  w('  sort_order   smallint NOT NULL,');
  w('  UNIQUE (region_code, name)');
  w(');');
  w();
  w('CREATE INDEX districts_region_idx ON reference.districts (region_code);');
  w();
  w(
    "COMMENT ON COLUMN reference.districts.council_type IS 'CC City Council, MC Municipal, DC District Council, TC Town Council.';",
  );
  w();

  const regionRows = [];
  const districtRows = [];
  let regionOrder = 0;
  let districtOrder = 0;
  for (const entry of data.geography) {
    const area = /zanzibar/i.test(entry.area) ? 'zanzibar' : 'mainland';
    const regionCode = `${area === 'zanzibar' ? 'zn' : 'tz'}_${slug(entry.region)}`;
    regionOrder += 1;
    regionRows.push(`  (${lit(regionCode)}, ${lit(area)}, ${lit(entry.region)}, ${regionOrder})`);

    for (const district of entry.districts) {
      districtOrder += 1;
      // District names repeat across regions (there is a "Kaskazini A" in more
      // than one place), so the code is qualified by region.
      const districtCode = `${regionCode}__${slug(district)}`;
      districtRows.push(
        `  (${lit(districtCode)}, ${lit(regionCode)}, ${lit(district.trim())}, ${lit(
          councilType(district),
        )}, ${districtOrder})`,
      );
    }
  }

  w('INSERT INTO reference.regions (code, area, name, sort_order) VALUES');
  w(regionRows.join(',\n') + ';');
  w();
  w('INSERT INTO reference.districts (code, region_code, name, council_type, sort_order) VALUES');
  w(districtRows.join(',\n') + ';');
  w();

  // ── Financial institutions ────────────────────────────────────────────────
  w('-- ---------------------------------------------------------------------------');
  w('-- Financial institutions and mobile network operators (MSP2-07, MSP2-08)');
  w('-- ---------------------------------------------------------------------------');
  w();
  w('-- BOT publishes two overlapping lists: one for deposit and borrowing');
  w('-- balances (MSP2-07) and one for agent-banking balances (MSP2-08). Held as a');
  w('-- single table with a flag per list, since most institutions appear on both');
  w('-- and duplicating them would let the two copies drift.');
  w('CREATE TABLE reference.financial_institutions (');
  w('  code                   text     PRIMARY KEY,');
  w('  name                   text     NOT NULL UNIQUE,');
  w("  kind                   text     NOT NULL CHECK (kind IN ('bank','mno')),");
  w('  in_deposits_list       boolean  NOT NULL DEFAULT false,');
  w('  in_agent_banking_list  boolean  NOT NULL DEFAULT false,');
  w('  sort_order             smallint NOT NULL');
  w(');');
  w();

  const institutions = new Map();

  /**
   * BOT's dropdown lists begin with a literal "NIL" row, meaning "none
   * selected". It is not an institution, and seeding it would let a user pick a
   * bank called NIL and have that selection flow into MSP2-07 as a real
   * counterparty. The extractor stays faithful to the template; the exclusion
   * belongs here, where the template is being interpreted.
   */
  const isPlaceholder = (name) => name.trim().toUpperCase() === 'NIL';

  const addInstitution = (name, kind, flag) => {
    if (isPlaceholder(name)) {
      return;
    }
    const code = slug(name);
    const existing = institutions.get(code);
    if (existing) {
      existing[flag] = true;
      return;
    }
    institutions.set(code, {
      code,
      name: name.trim(),
      kind,
      in_deposits_list: false,
      in_agent_banking_list: false,
      ...(flag ? { [flag]: true } : {}),
    });
  };

  for (const name of data.banks_list_A) addInstitution(name, 'bank', 'in_deposits_list');
  for (const name of data.banks_list_B_agent) addInstitution(name, 'bank', 'in_agent_banking_list');
  for (const name of data.mnos) addInstitution(name, 'mno', 'in_deposits_list');

  w('INSERT INTO reference.financial_institutions');
  w('  (code, name, kind, in_deposits_list, in_agent_banking_list, sort_order) VALUES');
  w(
    [...institutions.values()]
      .map(
        (institution, index) =>
          `  (${lit(institution.code)}, ${lit(institution.name)}, ${lit(institution.kind)}, ` +
          `${institution.in_deposits_list}, ${institution.in_agent_banking_list}, ${index + 1})`,
      )
      .join(',\n') + ';',
  );
  w();

  // ── Form lines ────────────────────────────────────────────────────────────
  w('-- ---------------------------------------------------------------------------');
  w('-- Financial statement line items (MSP2-01, MSP2-02)');
  w('-- ---------------------------------------------------------------------------');
  w();
  w('-- BOT’s cross-form validation rules address cells by Sno, not by spreadsheet');
  w('-- position — "C67=MSP2_04C15" means column C at Sno 67. So Sno is the wire');
  w('-- identifier, and the exporter writes by (form, sno, column) rather than by');
  w('-- a hardcoded row index.');
  w('CREATE TABLE reference.form_lines (');
  w('  form_code   text     NOT NULL,');
  w('  sno         smallint NOT NULL,');
  w('  label       text     NOT NULL,');
  w('  -- True where BOT’s template computes the line from others rather than');
  w('  -- accepting entry. Such a line is derived, never filled in.');
  w('  is_computed boolean  NOT NULL,');
  w('  -- The template’s own formula, retained so a future template revision can be');
  w('  -- diffed against what this system implements.');
  w('  formula     text,');
  w('  PRIMARY KEY (form_code, sno)');
  w(');');
  w();

  const formLineRows = [];
  for (const [formCode, lines] of [
    ['MSP2-01', data.msp2_01_lines],
    ['MSP2-02', data.msp2_02_lines],
  ]) {
    for (const line of lines) {
      formLineRows.push(
        `  (${lit(formCode)}, ${Number(line.sno)}, ${lit(line.label)}, ${
          line.formula ? 'true' : 'false'
        }, ${lit(line.formula)})`,
      );
    }
  }
  w('INSERT INTO reference.form_lines (form_code, sno, label, is_computed, formula) VALUES');
  w(formLineRows.join(',\n') + ';');
  w();

  // ── Validation rules ──────────────────────────────────────────────────────
  w('-- ---------------------------------------------------------------------------');
  w('-- Cross-form validation rules');
  w('-- ---------------------------------------------------------------------------');
  w();
  w('-- Run as pre-submission checks. A report that fails one of these is not');
  w('-- exported: a compliance product that quietly files inconsistent numbers is');
  w('-- worse than one that refuses to file.');
  w('CREATE TABLE reference.validation_rules (');
  w('  id        smallint PRIMARY KEY,');
  w('  form_code text     NOT NULL,');
  w('  rule      text     NOT NULL');
  w(');');
  w();
  w('INSERT INTO reference.validation_rules (id, form_code, rule) VALUES');
  w(
    data.validations
      .map(
        (validation, index) => `  (${index + 1}, ${lit(validation.form)}, ${lit(validation.rule)})`,
      )
      .join(',\n') + ';',
  );
  w();

  // ── Grants ────────────────────────────────────────────────────────────────
  w('-- ---------------------------------------------------------------------------');
  w('-- Grants');
  w('-- ---------------------------------------------------------------------------');
  w();
  w('-- Read only. Reference data is BOT’s, not the institution’s: it changes when');
  w('-- BOT revises a template, through a reviewed migration, never at runtime.');
  w('GRANT SELECT ON ALL TABLES IN SCHEMA reference TO mfi_app;');
  w();

  writeFileSync(outputPath, out.join('\n'), 'utf8');

  const counts = {
    sectors: data.sectors.length,
    loanTypes: loanTypes.length,
    provisioningBands: bandRows.length,
    complaintNatures: data.complaint_natures.length,
    regions: regionRows.length,
    districts: districtRows.length,
    financialInstitutions: institutions.size,
    formLines: formLineRows.length,
    validationRules: data.validations.length,
  };
  process.stdout.write(`Wrote ${outputPath}\n${JSON.stringify(counts, null, 2)}\n`);
}

main();
