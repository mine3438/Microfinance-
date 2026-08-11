-- Where a branch is.
--
-- MSP2-10 reports the number of branches and the number of employees in each
-- of BOT's 193 districts. 02-BOT-REPORTING-SPEC.md §8 records that as one of
-- three hard requirements the form imposes, and its §12.2 states the mapping
-- explicitly: "branches promoted from requested feature to reporting
-- requirement, with employee assignment per branch and branch→district
-- mapping". The `branches` table carried the assignment and not the mapping.
--
-- Without this column a branch's district can only be guessed from the
-- districts its clients live in, which is not the same thing: a branch in
-- Arusha City lends to borrowers in four surrounding districts, and counting it
-- once in each would report four branches where there is one.

ALTER TABLE branches
  ADD COLUMN district_code text REFERENCES reference.districts (code);

-- Nullable, and deliberately so.
--
-- The column arrives after branches exist, and there is no district a migration
-- could invent for them — inventing one would put a fabricated figure on a
-- regulatory return, which is worse than an absent one. So NULL means "not yet
-- located", and the reporting path refuses to compile MSP2-10 while any active
-- branch is in that state, exactly as it refuses over a loan no provisioning
-- band covers. An institution locates its branches once, and the refusal names
-- how many are outstanding.
COMMENT ON COLUMN branches.district_code IS
  'BOT district this branch operates in. NULL means not yet located; MSP2-10 refuses to compile until every active branch has one.';

-- Access path: MSP2-10 groups every branch of an institution by district.
CREATE INDEX branches_institution_district_idx ON branches (institution_id, district_code);
