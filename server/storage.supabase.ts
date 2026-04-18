/**
 * Clean Wizz — Supabase Storage Implementation
 *
 * Implements IStorageAsync using the Supabase JS client (service-role key).
 * All methods are async and map directly onto the PostgreSQL schema defined
 * in supabase/schema.sql.
 *
 * Column name mapping (PostgreSQL snake_case → TypeScript camelCase):
 *   client_id        → clientId
 *   promo_code       → promoCode
 *   expires_at       → expiresAt
 *   created_at       → createdAt
 *   quote_id         → quoteId
 *   unit_price       → unitPrice
 *   line_total       → lineTotal
 *   price_per_sqft   → pricePerSqft
 *   base_rate        → baseRate
 *   fridge_price     → fridgePrice
 *   oven_price       → ovenPrice
 *   windows_price    → windowsPrice
 *   baseboards_price → baseboardsPrice
 *   deep_clean_surcharge → deepCleanSurcharge
 *   moveout_surcharge    → moveoutSurcharge
 *   updated_at       → updatedAt
 *   valid_from       → validFrom
 *   valid_to         → validTo
 *   property_type    → propertyType
 *   square_footage   → squareFootage
 *   special_notes    → specialNotes
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import type {
  Client, InsertClient,
  Quote, InsertQuote,
  QuoteItem, InsertQuoteItem,
  PromoCode, InsertPromoCode,
  Settings, InsertSettings,
  EmailSignup,
} from "@shared/schema";

// ── Async storage interface ───────────────────────────────────────────────────
// Mirrors IStorage exactly but every method returns a Promise.
export interface IStorageAsync {
  // Clients
  getClients(): Promise<Client[]>;
  getClient(id: string): Promise<Client | undefined>;
  createClient(data: Omit<InsertClient, "id">): Promise<Client>;

  // Quotes
  getQuotes(): Promise<Quote[]>;
  getQuote(id: string): Promise<Quote | undefined>;
  createQuote(data: Omit<InsertQuote, "id">): Promise<Quote>;
  updateQuoteStatus(id: string, status: string, extra?: Record<string, any>): Promise<Quote | undefined>;

  // Quote Items
  getQuoteItems(quoteId: string): Promise<QuoteItem[]>;
  createQuoteItems(items: Omit<InsertQuoteItem, "id">[]): Promise<QuoteItem[]>;

  // Promo Codes
  getPromoCodes(): Promise<PromoCode[]>;
  getPromoCode(code: string): Promise<PromoCode | undefined>;
  createPromoCode(data: Omit<InsertPromoCode, "id">): Promise<PromoCode>;
  updatePromoCode(id: string, data: Partial<InsertPromoCode>): Promise<PromoCode | undefined>;
  deletePromoCode(id: string): Promise<void>;

  // Settings
  getSettings(): Promise<Settings | undefined>;
  upsertSettings(data: Partial<InsertSettings>): Promise<Settings>;

  // Email signups (consent audit log)
  createEmailSignup(data: {
    email: string;
    source: string;
    consentText: string;
    ipAddress?: string | null;
    userAgent?: string | null;
    bookingId?: string | null;
  }): Promise<EmailSignup>;
  getEmailSignup(id: string): Promise<EmailSignup | undefined>;
  hasEmailSignup(email: string): Promise<boolean>;
  hasRecentEmailSignup(email: string, sinceIso: string, excludeId?: string): Promise<boolean>;
}

// ── Row types returned by Supabase (snake_case) ───────────────────────────────
interface ClientRow {
  id: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  created_at: string;
}

interface QuoteRow {
  id: string;
  client_id: string;
  subtotal: number;
  discount: number;
  total: number;
  currency: string;
  promo_code: string | null;
  expires_at: string;
  status: string;
  created_at: string;
  property_type: string;
  square_footage: number;
  bedrooms: number;
  bathrooms: number;
  special_notes: string;
  services: string;
  addons: string;
  payment_intent_id: string | null;
}

interface QuoteItemRow {
  id: string;
  quote_id: string;
  label: string;
  quantity: number;
  unit_price: number;
  line_total: number;
}

interface PromoCodeRow {
  id: string;
  code: string;
  type: string;
  value: number;
  active: boolean;
  valid_from: string | null;
  valid_to: string | null;
}

interface SettingsRow {
  id: string;
  price_per_sqft: number;
  base_rate: number;
  fridge_price: number;
  grout_price: number;
  windows_price: number;
  baseboards_price: number;
  deep_clean_surcharge: number;
  moveout_surcharge: number;
  updated_at: string;
}

// ── Mappers (snake_case rows → camelCase TS types) ────────────────────────────
function mapClient(r: ClientRow): Client {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    address: r.address,
    createdAt: r.created_at,
  };
}

function mapQuote(r: QuoteRow): Quote {
  return {
    id: r.id,
    clientId: r.client_id,
    subtotal: Number(r.subtotal),
    discount: Number(r.discount),
    total: Number(r.total),
    currency: r.currency,
    promoCode: r.promo_code ?? null,
    expiresAt: r.expires_at,
    status: r.status,
    createdAt: r.created_at,
    propertyType: r.property_type,
    squareFootage: Number(r.square_footage),
    bedrooms: r.bedrooms,
    bathrooms: r.bathrooms,
    specialNotes: r.special_notes,
    services: r.services,
    addons: r.addons,
    paymentIntentId: r.payment_intent_id ?? null,
  };
}

function mapQuoteItem(r: QuoteItemRow): QuoteItem {
  return {
    id: r.id,
    quoteId: r.quote_id,
    label: r.label,
    quantity: Number(r.quantity),
    unitPrice: Number(r.unit_price),
    lineTotal: Number(r.line_total),
  };
}

function mapPromoCode(r: PromoCodeRow): PromoCode {
  return {
    id: r.id,
    code: r.code,
    type: r.type,
    value: Number(r.value),
    active: r.active,
    validFrom: r.valid_from ?? null,
    validTo: r.valid_to ?? null,
  };
}

function mapSettings(r: SettingsRow): Settings {
  return {
    id: r.id,
    pricePerSqft: Number(r.price_per_sqft),
    baseRate: Number(r.base_rate),
    fridgePrice: Number(r.fridge_price),
    groutPrice: Number(r.grout_price ?? 35),
    windowsPrice: Number(r.windows_price),
    baseboardsPrice: Number(r.baseboards_price),
    deepCleanSurcharge: Number(r.deep_clean_surcharge),
    moveoutSurcharge: Number(r.moveout_surcharge),
    updatedAt: r.updated_at,
  };
}

// ── Helper: throw on Supabase errors ─────────────────────────────────────────
function assertNoError<T>(result: { data: T | null; error: any }, context: string): T {
  if (result.error) {
    throw new Error(`[Supabase/${context}] ${result.error.message}`);
  }
  if (result.data === null) {
    throw new Error(`[Supabase/${context}] returned null data`);
  }
  return result.data;
}

// ── Factory ───────────────────────────────────────────────────────────────────
export function createSupabaseStorage(): IStorageAsync {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.\n" +
      "Copy .env.example to .env and fill in your Supabase credentials."
    );
  }

  const supabase: SupabaseClient = createClient(url, key, {
    auth: {
      // Service role key — disable auto-refresh/session persistence
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });

  return {
    // ── Clients ──────────────────────────────────────────────────────────────

    async getClients(): Promise<Client[]> {
      const result = await supabase
        .from("clients")
        .select("*")
        .order("created_at", { ascending: false });
      const rows = assertNoError(result, "getClients") as ClientRow[];
      return rows.map(mapClient);
    },

    async getClient(id: string): Promise<Client | undefined> {
      const result = await supabase
        .from("clients")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (result.error) throw new Error(`[Supabase/getClient] ${result.error.message}`);
      return result.data ? mapClient(result.data as ClientRow) : undefined;
    },

    async createClient(data: Omit<InsertClient, "id">): Promise<Client> {
      const id = randomUUID();
      const now = new Date().toISOString();
      const row = {
        id,
        name: data.name,
        email: data.email,
        phone: data.phone ?? "",
        address: data.address ?? "",
        created_at: now,
      };
      const result = await supabase
        .from("clients")
        .insert(row)
        .select()
        .single();
      return mapClient(assertNoError(result, "createClient") as ClientRow);
    },

    // ── Quotes ───────────────────────────────────────────────────────────────

    async getQuotes(): Promise<Quote[]> {
      const result = await supabase
        .from("quotes")
        .select("*")
        .order("created_at", { ascending: false });
      const rows = assertNoError(result, "getQuotes") as QuoteRow[];
      return rows.map(mapQuote);
    },

    async getQuote(id: string): Promise<Quote | undefined> {
      const result = await supabase
        .from("quotes")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (result.error) throw new Error(`[Supabase/getQuote] ${result.error.message}`);
      return result.data ? mapQuote(result.data as QuoteRow) : undefined;
    },

    async createQuote(data: Omit<InsertQuote, "id">): Promise<Quote> {
      const id = randomUUID();
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
      const row = {
        id,
        client_id: data.clientId,
        subtotal: data.subtotal,
        discount: data.discount ?? 0,
        total: data.total,
        currency: data.currency ?? "CAD",
        promo_code: data.promoCode ?? null,
        expires_at: expiresAt,
        status: data.status ?? "draft",
        created_at: now,
        property_type: data.propertyType ?? "",
        square_footage: data.squareFootage ?? 0,
        bedrooms: data.bedrooms ?? 0,
        bathrooms: data.bathrooms ?? 0,
        special_notes: data.specialNotes ?? "",
        services: data.services ?? "[]",
        addons: data.addons ?? "[]",
      };
      const result = await supabase
        .from("quotes")
        .insert(row)
        .select()
        .single();
      return mapQuote(assertNoError(result, "createQuote") as QuoteRow);
    },

    async updateQuoteStatus(id: string, status: string, extra?: Record<string, any>): Promise<Quote | undefined> {
      const patch: Record<string, any> = { status };
      if (extra?.paymentIntentId) patch.payment_intent_id = extra.paymentIntentId;
      const result = await supabase
        .from("quotes")
        .update(patch)
        .eq("id", id)
        .select()
        .single();
      if (result.error) throw new Error(`[Supabase/updateQuoteStatus] ${result.error.message}`);
      return result.data ? mapQuote(result.data as QuoteRow) : undefined;
    },

    // ── Quote Items ───────────────────────────────────────────────────────────

    async getQuoteItems(quoteId: string): Promise<QuoteItem[]> {
      const result = await supabase
        .from("quote_items")
        .select("*")
        .eq("quote_id", quoteId);
      const rows = assertNoError(result, "getQuoteItems") as QuoteItemRow[];
      return rows.map(mapQuoteItem);
    },

    async createQuoteItems(items: Omit<InsertQuoteItem, "id">[]): Promise<QuoteItem[]> {
      if (items.length === 0) return [];
      const rows = items.map(item => ({
        id: randomUUID(),
        quote_id: item.quoteId,
        label: item.label,
        quantity: item.quantity ?? 1,
        unit_price: item.unitPrice,
        line_total: item.lineTotal,
      }));
      const result = await supabase
        .from("quote_items")
        .insert(rows)
        .select();
      const inserted = assertNoError(result, "createQuoteItems") as QuoteItemRow[];
      return inserted.map(mapQuoteItem);
    },

    // ── Promo Codes ───────────────────────────────────────────────────────────

    async getPromoCodes(): Promise<PromoCode[]> {
      const result = await supabase
        .from("promo_codes")
        .select("*")
        .order("code");
      const rows = assertNoError(result, "getPromoCodes") as PromoCodeRow[];
      return rows.map(mapPromoCode);
    },

    async getPromoCode(code: string): Promise<PromoCode | undefined> {
      const result = await supabase
        .from("promo_codes")
        .select("*")
        .eq("code", code.toUpperCase())
        .maybeSingle();
      if (result.error) throw new Error(`[Supabase/getPromoCode] ${result.error.message}`);
      return result.data ? mapPromoCode(result.data as PromoCodeRow) : undefined;
    },

    async createPromoCode(data: Omit<InsertPromoCode, "id">): Promise<PromoCode> {
      const id = randomUUID();
      const row = {
        id,
        code: data.code.toUpperCase(),
        type: data.type,
        value: data.value,
        active: data.active ?? true,
        valid_from: data.validFrom ?? null,
        valid_to: data.validTo ?? null,
      };
      const result = await supabase
        .from("promo_codes")
        .insert(row)
        .select()
        .single();
      return mapPromoCode(assertNoError(result, "createPromoCode") as PromoCodeRow);
    },

    async updatePromoCode(id: string, data: Partial<InsertPromoCode>): Promise<PromoCode | undefined> {
      // Build a snake_case patch object only with defined keys
      const patch: Record<string, any> = {};
      if (data.code !== undefined)      patch.code       = data.code.toUpperCase();
      if (data.type !== undefined)      patch.type       = data.type;
      if (data.value !== undefined)     patch.value      = data.value;
      if (data.active !== undefined)    patch.active     = data.active;
      if (data.validFrom !== undefined) patch.valid_from = data.validFrom;
      if (data.validTo !== undefined)   patch.valid_to   = data.validTo;

      const result = await supabase
        .from("promo_codes")
        .update(patch)
        .eq("id", id)
        .select()
        .single();
      if (result.error) throw new Error(`[Supabase/updatePromoCode] ${result.error.message}`);
      return result.data ? mapPromoCode(result.data as PromoCodeRow) : undefined;
    },

    async deletePromoCode(id: string): Promise<void> {
      const result = await supabase
        .from("promo_codes")
        .delete()
        .eq("id", id);
      if (result.error) throw new Error(`[Supabase/deletePromoCode] ${result.error.message}`);
    },

    // ── Settings ──────────────────────────────────────────────────────────────

    async getSettings(): Promise<Settings | undefined> {
      const result = await supabase
        .from("settings")
        .select("*")
        .eq("id", "default")
        .maybeSingle();
      if (result.error) throw new Error(`[Supabase/getSettings] ${result.error.message}`);
      return result.data ? mapSettings(result.data as SettingsRow) : undefined;
    },

    // ── Email Signups (consent audit log) ─────────────────────────────────────

    async createEmailSignup(data: {
      email: string;
      source: string;
      consentText: string;
      ipAddress?: string | null;
      userAgent?: string | null;
      bookingId?: string | null;
    }): Promise<EmailSignup> {
      const id = randomUUID();
      const row = {
        id,
        email: data.email.toLowerCase().trim(),
        source: data.source,
        consent_text: data.consentText,
        consent_at: new Date().toISOString(),
        ip_address: data.ipAddress ?? null,
        user_agent: data.userAgent ?? null,
        booking_id: data.bookingId ?? null,
      };
      const result = await supabase
        .from("email_signups")
        .insert(row)
        .select()
        .single();
      const r = assertNoError(result, "createEmailSignup") as any;
      return {
        id: r.id,
        email: r.email,
        source: r.source,
        consentText: r.consent_text,
        consentAt: r.consent_at,
        ipAddress: r.ip_address ?? null,
        userAgent: r.user_agent ?? null,
        bookingId: r.booking_id ?? null,
      };
    },

    async getEmailSignup(id: string): Promise<EmailSignup | undefined> {
      const result = await supabase
        .from("email_signups")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (result.error) throw new Error(`[Supabase/getEmailSignup] ${result.error.message}`);
      if (!result.data) return undefined;
      const r: any = result.data;
      return {
        id: r.id,
        email: r.email,
        source: r.source,
        consentText: r.consent_text,
        consentAt: r.consent_at,
        ipAddress: r.ip_address ?? null,
        userAgent: r.user_agent ?? null,
        bookingId: r.booking_id ?? null,
      };
    },

    async hasEmailSignup(email: string): Promise<boolean> {
      const result = await supabase
        .from("email_signups")
        .select("id")
        .eq("email", email.toLowerCase().trim())
        .limit(1);
      if (result.error) throw new Error(`[Supabase/hasEmailSignup] ${result.error.message}`);
      return (result.data?.length ?? 0) > 0;
    },

    async hasRecentEmailSignup(email: string, sinceIso: string, excludeId?: string): Promise<boolean> {
      let query = supabase
        .from("email_signups")
        .select("id")
        .eq("email", email.toLowerCase().trim())
        .gte("consent_at", sinceIso);
      if (excludeId) query = query.neq("id", excludeId);
      const result = await query.limit(1);
      if (result.error) throw new Error(`[Supabase/hasRecentEmailSignup] ${result.error.message}`);
      return (result.data?.length ?? 0) > 0;
    },

    async upsertSettings(data: Partial<InsertSettings>): Promise<Settings> {
      const now = new Date().toISOString();
      // Build snake_case upsert payload
      const patch: Record<string, any> = {
        id: "default",
        updated_at: now,
      };
      if (data.pricePerSqft        !== undefined) patch.price_per_sqft        = data.pricePerSqft;
      if (data.baseRate             !== undefined) patch.base_rate             = data.baseRate;
      if (data.fridgePrice          !== undefined) patch.fridge_price          = data.fridgePrice;
      if (data.groutPrice            !== undefined) patch.grout_price            = data.groutPrice;
      if (data.windowsPrice         !== undefined) patch.windows_price         = data.windowsPrice;
      if (data.baseboardsPrice      !== undefined) patch.baseboards_price      = data.baseboardsPrice;
      if (data.deepCleanSurcharge   !== undefined) patch.deep_clean_surcharge  = data.deepCleanSurcharge;
      if (data.moveoutSurcharge     !== undefined) patch.moveout_surcharge     = data.moveoutSurcharge;

      const result = await supabase
        .from("settings")
        .upsert(patch, { onConflict: "id" })
        .select()
        .single();
      return mapSettings(assertNoError(result, "upsertSettings") as SettingsRow);
    },
  };
}
