import { sqliteTable, text, real, integer } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ── clients ──────────────────────────────────────────────────────────────────
export const clients = sqliteTable("clients", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  phone: text("phone").notNull().default(""),
  address: text("address").notNull().default(""),
  createdAt: text("created_at").notNull(),
});

export const insertClientSchema = createInsertSchema(clients).omit({ createdAt: true });
export type InsertClient = z.infer<typeof insertClientSchema>;
export type Client = typeof clients.$inferSelect;

// ── quotes ───────────────────────────────────────────────────────────────────
export const quotes = sqliteTable("quotes", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull(),
  subtotal: real("subtotal").notNull(),
  discount: real("discount").notNull().default(0),
  total: real("total").notNull(),
  currency: text("currency").notNull().default("CAD"),
  promoCode: text("promo_code"),
  expiresAt: text("expires_at").notNull(),
  status: text("status").notNull().default("draft"), // draft | sent | accepted | expired
  createdAt: text("created_at").notNull(),
  // snapshot of inputs for display
  propertyType: text("property_type").notNull().default(""),
  squareFootage: real("square_footage").notNull().default(0),
  bedrooms: integer("bedrooms").notNull().default(0),
  bathrooms: integer("bathrooms").notNull().default(0),
  specialNotes: text("special_notes").notNull().default(""),
  services: text("services").notNull().default("[]"), // JSON array
  addons: text("addons").notNull().default("[]"),      // JSON array
  paymentIntentId: text("payment_intent_id"),           // Stripe PI for capture
});

export const insertQuoteSchema = createInsertSchema(quotes).omit({ createdAt: true, expiresAt: true });
export type InsertQuote = z.infer<typeof insertQuoteSchema>;
export type Quote = typeof quotes.$inferSelect;

// ── quote_items ───────────────────────────────────────────────────────────────
export const quoteItems = sqliteTable("quote_items", {
  id: text("id").primaryKey(),
  quoteId: text("quote_id").notNull(),
  label: text("label").notNull(),
  quantity: real("quantity").notNull().default(1),
  unitPrice: real("unit_price").notNull(),
  lineTotal: real("line_total").notNull(),
});

export const insertQuoteItemSchema = createInsertSchema(quoteItems);
export type InsertQuoteItem = z.infer<typeof insertQuoteItemSchema>;
export type QuoteItem = typeof quoteItems.$inferSelect;

// ── promo_codes ───────────────────────────────────────────────────────────────
export const promoCodes = sqliteTable("promo_codes", {
  id: text("id").primaryKey(),
  code: text("code").notNull(),
  type: text("type").notNull(), // percent | fixed
  value: real("value").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  validFrom: text("valid_from"),
  validTo: text("valid_to"),
});

export const insertPromoCodeSchema = createInsertSchema(promoCodes);
export type InsertPromoCode = z.infer<typeof insertPromoCodeSchema>;
export type PromoCode = typeof promoCodes.$inferSelect;

// ── settings ─────────────────────────────────────────────────────────────────
export const settings = sqliteTable("settings", {
  id: text("id").primaryKey().default("default"),
  pricePerSqft: real("price_per_sqft").notNull().default(0.30),
  baseRate: real("base_rate").notNull().default(100),
  perBedroom: real("per_bedroom").notNull().default(15),
  perBathroom: real("per_bathroom").notNull().default(20),
  fridgePrice: real("fridge_price").notNull().default(25),
  groutPrice: real("grout_price").notNull().default(35),
  windowsPrice: real("windows_price").notNull().default(40),
  baseboardsPrice: real("baseboards_price").notNull().default(30),
  deepCleanSurcharge: real("deep_clean_surcharge").notNull().default(60),
  moveoutSurcharge: real("moveout_surcharge").notNull().default(100),
  updatedAt: text("updated_at").notNull(),
});

export const insertSettingsSchema = createInsertSchema(settings).omit({ updatedAt: true });
export type InsertSettings = z.infer<typeof insertSettingsSchema>;
export type Settings = typeof settings.$inferSelect;

// ── combined quote form (used on frontend) ────────────────────────────────────
export const quoteFormSchema = z.object({
  // client
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Valid email required"),
  phone: z.string().default(""),
  address: z.string().default(""),
  // property
  propertyType: z.enum(["house", "condo", "apartment", "townhouse", "commercial", "other"]),
  squareFootage: z.number().min(0).default(0),
  bedrooms: z.number().int().min(0).max(20).default(1),
  bathrooms: z.number().int().min(0).max(20).default(1),
  specialNotes: z.string().default(""),
  // services
  serviceType: z.enum(["standard", "deep", "moveout"]).default("standard"),
  addons: z.array(z.enum(["fridge", "windows", "baseboards", "grout"])).default([]),
  // promo
  promoCode: z.string().default(""),
});

export type QuoteFormValues = z.infer<typeof quoteFormSchema>;
