/**
 * Payout record shape — the single source of truth for what gets written
 * to the Supabase `payouts` table when `/api/job/complete` finishes.
 *
 * Pure function, extracted so we can unit-test both branches (sent / failed)
 * without spinning up a real Stripe client.
 */

export interface PayoutRecordInput {
  jobId: string;
  contractorId: string;
  amount: number;
  now: string;
  transferId: string | null;
  error: string | null;
}

export interface PayoutRecord {
  job_id: string;
  contractor_id: string;
  amount: number;
  status: "sent" | "failed";
  triggered_at: string;
  completed_at?: string;
  reference: string | null;
}

export function buildPayoutRecord(input: PayoutRecordInput): PayoutRecord {
  if (input.transferId) {
    return {
      job_id: input.jobId,
      contractor_id: input.contractorId,
      amount: input.amount,
      status: "sent",
      triggered_at: input.now,
      completed_at: input.now,
      reference: input.transferId,
    };
  }
  return {
    job_id: input.jobId,
    contractor_id: input.contractorId,
    amount: input.amount,
    status: "failed",
    triggered_at: input.now,
    reference: input.error ? `ERR:${input.error.slice(0, 180)}` : null,
  };
}
