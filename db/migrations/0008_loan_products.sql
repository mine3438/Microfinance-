-- Loan products: the terms an institution offers, and the bounds a loan
-- created from them must respect.
--
-- The previous schema had no product concept. Rate, method and term were typed
-- afresh on every loan, so nothing stopped an officer entering 50% a month
-- where the institution offers 5%, and MSP2-04 — which reports the lowest and
-- highest rate per loan type — would report the typo as a real product.

CREATE TABLE loan_products (
  id                uuid          PRIMARY KEY DEFAULT uuid_generate_v7(),
  institution_id    uuid          NOT NULL REFERENCES institutions (id) ON DELETE RESTRICT,

  code              text          NOT NULL CHECK (length(btrim(code)) > 0),
  name              text          NOT NULL CHECK (length(btrim(name)) > 0),

  -- Which MSP2-04 row loans of this product report under, and — through
  -- reference.loan_types.provisioning_schedule — which provisioning schedule
  -- applies. A housing product provisions on BOT's longer bands.
  bot_loan_type     text          NOT NULL REFERENCES reference.loan_types (code),

  interest_method   text          NOT NULL CHECK (interest_method IN ('flat', 'reducing_balance')),

  -- Monthly rate as a fraction, matching @mfi/money's Rate: 0.0500 is 5% a month.
  -- MSP2-04 reports these annualised; the conversion is applied at report time,
  -- not at rest, so the stored figure stays the one the institution quotes.
  min_monthly_rate  numeric(6, 4) NOT NULL CHECK (min_monthly_rate >= 0),
  max_monthly_rate  numeric(6, 4) NOT NULL CHECK (max_monthly_rate >= 0),

  min_term_months   integer       NOT NULL CHECK (min_term_months >= 1),
  max_term_months   integer       NOT NULL CHECK (max_term_months <= 360),

  min_principal     numeric(15, 2) NOT NULL CHECK (min_principal > 0),
  max_principal     numeric(15, 2) NOT NULL CHECK (max_principal > 0),

  status            text          NOT NULL DEFAULT 'active'
                                  CHECK (status IN ('active', 'retired')),

  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT loan_products_id_institution_key UNIQUE (id, institution_id),
  CONSTRAINT loan_products_code_unique_per_institution UNIQUE (institution_id, code),

  -- A range whose floor exceeds its ceiling admits no loan at all. Catching it
  -- here means the product is rejected when it is defined, rather than every
  -- loan created from it failing for reasons that point at the wrong place.
  CONSTRAINT loan_products_rate_range CHECK (min_monthly_rate <= max_monthly_rate),
  CONSTRAINT loan_products_term_range CHECK (min_term_months <= max_term_months),
  CONSTRAINT loan_products_principal_range CHECK (min_principal <= max_principal)
);

COMMENT ON TABLE loan_products IS
  'Terms an institution offers. Loans are created from a product and must fall within its bounds.';
COMMENT ON COLUMN loan_products.bot_loan_type IS
  'MSP2-04 reporting row, and via reference.loan_types the provisioning schedule that applies.';

CREATE INDEX loan_products_institution_status_idx ON loan_products (institution_id, status);
CREATE INDEX loan_products_bot_type_idx ON loan_products (bot_loan_type);

CREATE TRIGGER trg_loan_products_updated_at
  BEFORE UPDATE ON loan_products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_audit_loan_products
  AFTER INSERT OR UPDATE OR DELETE ON loan_products
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

ALTER TABLE loan_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE loan_products FORCE ROW LEVEL SECURITY;

CREATE POLICY loan_products_select ON loan_products
  FOR SELECT TO mfi_app
  USING (institution_id = current_institution_id());

CREATE POLICY loan_products_insert ON loan_products
  FOR INSERT TO mfi_app
  WITH CHECK (institution_id = current_institution_id());

CREATE POLICY loan_products_update ON loan_products
  FOR UPDATE TO mfi_app
  USING (institution_id = current_institution_id())
  WITH CHECK (institution_id = current_institution_id());

-- No DELETE policy. A product that has ever issued a loan is referenced by that
-- loan's terms; retiring it stops new lending without rewriting history.
GRANT SELECT, INSERT, UPDATE ON loan_products TO mfi_app;
