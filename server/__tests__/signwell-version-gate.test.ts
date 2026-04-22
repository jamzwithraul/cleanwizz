/**
 * signwell-version-gate.test.ts
 *
 * Verifies the contractor assignment gate:
 *   - Contractors with signwell_reclean_clause_version < 1 cannot be assigned jobs.
 *   - Contractors with version >= 1 can be assigned.
 *   - RECLEAN_CLAUSE_VERSION export matches the expected value.
 */

import { describe, it, expect } from "vitest";
import { RECLEAN_CLAUSE_VERSION } from "../signwell";

// ── Gate logic (mirrors the Supabase .gte() filter in routes.ts) ──────────────
interface ContractorStub {
  id:                           string;
  full_name:                    string;
  email:                        string;
  status:                       string;
  signwell_reclean_clause_version: number;
}

/**
 * Simulates the .gte("signwell_reclean_clause_version", 1) Supabase filter
 * that blocks contractors from receiving job assignments until they re-sign.
 */
function filterEligibleContractors(
  contractors: ContractorStub[],
  requiredVersion = RECLEAN_CLAUSE_VERSION,
): ContractorStub[] {
  return contractors.filter(
    c => c.status === "approved" && c.signwell_reclean_clause_version >= requiredVersion,
  );
}

function contractorNeedsResign(contractor: ContractorStub): boolean {
  return contractor.signwell_reclean_clause_version < RECLEAN_CLAUSE_VERSION;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const contractorV0: ContractorStub = {
  id:                           "ctr-v0",
  full_name:                    "Alice Smith",
  email:                        "alice@example.com",
  status:                       "approved",
  signwell_reclean_clause_version: 0,
};

const contractorV1: ContractorStub = {
  id:                           "ctr-v1",
  full_name:                    "Bob Jones",
  email:                        "bob@example.com",
  status:                       "approved",
  signwell_reclean_clause_version: 1,
};

const contractorPending: ContractorStub = {
  id:                           "ctr-pending",
  full_name:                    "Carol White",
  email:                        "carol@example.com",
  status:                       "pending",
  signwell_reclean_clause_version: 1,
};

// ─────────────────────────────────────────────────────────────────────────────

describe("RECLEAN_CLAUSE_VERSION constant", () => {
  it("is exported as 1 for this sprint", () => {
    expect(RECLEAN_CLAUSE_VERSION).toBe(1);
  });
});

describe("Contractor eligibility gate", () => {
  it("excludes contractors with version 0", () => {
    const eligible = filterEligibleContractors([contractorV0]);
    expect(eligible).toHaveLength(0);
  });

  it("includes contractors with version 1", () => {
    const eligible = filterEligibleContractors([contractorV1]);
    expect(eligible).toHaveLength(1);
    expect(eligible[0].id).toBe("ctr-v1");
  });

  it("excludes non-approved contractors even if they have the right version", () => {
    const eligible = filterEligibleContractors([contractorPending]);
    expect(eligible).toHaveLength(0);
  });

  it("returns only eligible contractors from a mixed list", () => {
    const eligible = filterEligibleContractors([
      contractorV0,
      contractorV1,
      contractorPending,
    ]);
    expect(eligible).toHaveLength(1);
    expect(eligible[0].id).toBe("ctr-v1");
  });

  it("returns empty array if no contractors have signed", () => {
    const eligible = filterEligibleContractors([contractorV0]);
    expect(eligible).toHaveLength(0);
  });
});

describe("contractorNeedsResign helper", () => {
  it("returns true for contractor with version 0", () => {
    expect(contractorNeedsResign(contractorV0)).toBe(true);
  });

  it("returns false for contractor with version 1", () => {
    expect(contractorNeedsResign(contractorV1)).toBe(false);
  });

  it("returns false for contractor with version higher than current", () => {
    const futureVersion: ContractorStub = {
      ...contractorV1,
      signwell_reclean_clause_version: 5,
    };
    expect(contractorNeedsResign(futureVersion)).toBe(false);
  });
});

describe("Admin resend-signwell endpoint logic", () => {
  it("identifies contractors who need to re-sign", () => {
    const contractors = [contractorV0, contractorV1];
    const needResign  = contractors.filter(contractorNeedsResign);

    expect(needResign).toHaveLength(1);
    expect(needResign[0].id).toBe("ctr-v0");
  });
});
