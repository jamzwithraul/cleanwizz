/**
 * Clean Wizz — Storage Layer
 *
 * Supabase PostgreSQL is the sole backend.
 * All routes consume IStorageAsync via getStorage().
 */

import { createSupabaseStorage } from "./storage.supabase";

// Re-export IStorageAsync so routes.ts can import from one place
export type { IStorageAsync } from "./storage.supabase";

// ── getStorage() ──────────────────────────────────────────────────────────────
let _storage: ReturnType<typeof createSupabaseStorage> | null = null;

export function getStorage() {
  if (_storage) return _storage;

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "[storage] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. " +
      "Check your environment variables."
    );
  }

  console.log("[storage] Using Supabase PostgreSQL backend");
  _storage = createSupabaseStorage();
  return _storage;
}
