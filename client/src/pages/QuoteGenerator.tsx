import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { quoteFormSchema, type QuoteFormValues } from "@shared/schema";
import type { Settings } from "@shared/schema";

import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  User,
  Home,
  Wrench,
  Tag,
  Calculator,
  Loader2,
  CheckCircle2,
  ChevronRight,
  Lock,
  Mail,
} from "lucide-react";

// ── CASL consent copy (keep in sync with server default) ─────────────────────
export const INLINE_CONSENT_TEXT =
  "Email me promotional offers from Harry Spotter Cleaning Co. Unsubscribe anytime.";
export const POPUP_CONSENT_TEXT =
  "By submitting, you agree to receive promotional emails from Harry Spotter Cleaning Co. Unsubscribe anytime.";

const SERVICE_OPTIONS = [
  {
    value: "standard",
    label: "Standard Clean",
    description: "Flat-rate — bathrooms, kitchen, living areas, bedrooms, stairs",
  },
  {
    value: "deep",
    label: "Deep Clean",
    description: "Flat-rate — everything in Standard + inside fridge, cabinets, baseboards, windows, grout, clean kitchen sink",
  },
  {
    value: "moveout",
    label: "Move-In / Move-Out",
    description: "Flat-rate — everything in Deep + behind fridge/stove, grout scrubbing, all interior windows, clean kitchen sink",
  },
] as const;

const ADDON_OPTIONS = [
  { id: "fridge",     label: "Inside Fridge ($25)" },
  { id: "windows",   label: "Interior Windows ($40)" },
  { id: "baseboards",label: "Baseboards ($30)" },
  { id: "grout",     label: "Grout Scrubbing ($35)" },
] as const;

const PROPERTY_TYPES = [
  { value: "house", label: "House" },
  { value: "condo", label: "Condo" },
  { value: "apartment", label: "Apartment" },
  { value: "townhouse", label: "Townhouse" },
  { value: "commercial", label: "Commercial" },
  { value: "other", label: "Other" },
];

function useLivePrice(values: QuoteFormValues, settings: Settings | undefined) {
  if (!settings) return { items: [], subtotal: 0, discount: 0, total: 0 };

  const s = settings;
  const items: { label: string; amount: number }[] = [];

  items.push({ label: "Base rate", amount: s.baseRate });

  if (values.squareFootage > 0) {
    items.push({
      label: `Sq ft (${values.squareFootage} × $${s.pricePerSqft})`,
      amount: parseFloat((values.squareFootage * s.pricePerSqft).toFixed(2)),
    });
  }

  if (values.serviceType === "deep") {
    items.push({ label: "Deep clean surcharge", amount: s.deepCleanSurcharge });
  } else if (values.serviceType === "moveout") {
    items.push({ label: "Move-in/out surcharge", amount: s.moveoutSurcharge });
  }

  const addonMap: Record<string, { label: string; price: number }> = {
    fridge:     { label: "Inside fridge",   price: s.fridgePrice },
    windows:    { label: "Interior windows", price: s.windowsPrice },
    baseboards: { label: "Baseboards",       price: s.baseboardsPrice },
    grout:      { label: "Grout scrubbing",  price: s.groutPrice ?? 35 },
  };

  for (const addon of values.addons) {
    const a = addonMap[addon];
    if (a) items.push({ label: a.label, amount: a.price });
  }

  const subtotal = items.reduce((s, i) => s + i.amount, 0);
  return { items, subtotal, discount: 0, total: subtotal };
}

const QUOTE_DRAFT_KEY = 'cw_quote_draft';

function loadDraft(): Partial<QuoteFormValues> {
  try {
    const raw = localStorage.getItem(QUOTE_DRAFT_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

export default function QuoteGenerator() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [promoApplied, setPromoApplied] = useState<{ code: string; type: string; value: number } | null>(null);
  const [promoInput, setPromoInput] = useState("");
  const [promoLoading, setPromoLoading] = useState(false);

  // ── CASL email-marketing consent (session-scoped gate for ALL discounts) ──
  const [consentChecked, setConsentChecked]   = useState(false);
  const [consentEmail, setConsentEmail]       = useState("");
  const [consentSubmitting, setConsentSubmitting] = useState(false);
  const [emailConsentGranted, setEmailConsentGranted] = useState(false);
  const [emailConsentId, setEmailConsentId]   = useState<string | null>(null);
  const [emailConsentSource, setEmailConsentSource] =
    useState<"inline_checkbox" | "promo_popup" | null>(null);
  const [emailConsentText, setEmailConsentText]   = useState<string | null>(null);
  const [promoOpen, setPromoOpen]             = useState(false);
  const [popupEmail, setPopupEmail]           = useState("");
  const [popupSubmitting, setPopupSubmitting] = useState(false);

  const { data: settings } = useQuery<Settings>({
    queryKey: ["/api/settings"],
  });

  const draft = loadDraft();

  const form = useForm<QuoteFormValues>({
    resolver: zodResolver(quoteFormSchema),
    defaultValues: {
      name: "",
      email: "",
      phone: "",
      address: "",
      propertyType: (draft.propertyType as QuoteFormValues['propertyType']) ?? "house",
      squareFootage: draft.squareFootage ?? 0,
      bedrooms: draft.bedrooms ?? 1,
      bathrooms: draft.bathrooms ?? 1,
      specialNotes: "",
      serviceType: (draft.serviceType as QuoteFormValues['serviceType']) ?? "standard",
      addons: draft.addons ?? [],
      promoCode: "",
    },
  });

  const values = form.watch();

  // Persist non-PII fields to localStorage as the user types
  useEffect(() => {
    const { propertyType, squareFootage, bedrooms, bathrooms, serviceType, addons } = values;
    try {
      localStorage.setItem(QUOTE_DRAFT_KEY, JSON.stringify({ propertyType, squareFootage, bedrooms, bathrooms, serviceType, addons }));
    } catch { /* quota exceeded or private mode */ }
  }, [values.propertyType, values.squareFootage, values.bedrooms, values.bathrooms, values.serviceType, values.addons]);

  const { items, subtotal } = useLivePrice(values, settings);

  // Raw discounts (computed exactly as before — pricing math is unchanged).
  const promoDiscountRaw = promoApplied
    ? (promoApplied.type === "percent"
        ? parseFloat((subtotal * promoApplied.value / 100).toFixed(2))
        : promoApplied.value)
    : 0;

  // All discounts are CASL-gated: zero them out until the user has consented.
  const discount = emailConsentGranted ? promoDiscountRaw : 0;
  const discountLocked = !emailConsentGranted && promoDiscountRaw > 0;
  const total = parseFloat((subtotal - discount).toFixed(2));

  const submitConsent = async (
    email: string,
    source: "inline_checkbox" | "promo_popup",
    consentText: string,
  ) => {
    const res = await apiRequest("POST", "/api/email-signups", {
      email: email.trim(),
      source,
      consentText,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Signup failed" }));
      throw new Error(err.error || "Signup failed");
    }
    const data = await res.json();
    setEmailConsentGranted(true);
    setEmailConsentId(data.id ?? null);
    setEmailConsentSource(source);
    setEmailConsentText(consentText);
    // Mirror into the quote form's email field so the server-side
    // consent-email check lines up.
    if (!form.getValues("email")) form.setValue("email", email.trim());
  };

  const handleInlineUnlock = async () => {
    if (!consentChecked) {
      toast({ title: "Please tick the consent box first", variant: "destructive" });
      return;
    }
    if (!consentEmail.trim()) {
      toast({ title: "Email required", variant: "destructive" });
      return;
    }
    setConsentSubmitting(true);
    try {
      await submitConsent(consentEmail, "inline_checkbox", INLINE_CONSENT_TEXT);
      toast({ title: "Signed up!", description: "Discounts unlocked for this quote." });
    } catch (e: any) {
      toast({ title: "Could not sign up", description: e.message, variant: "destructive" });
    } finally {
      setConsentSubmitting(false);
    }
  };

  const handlePopupSubmit = async () => {
    if (!popupEmail.trim()) return;
    setPopupSubmitting(true);
    try {
      await submitConsent(popupEmail, "promo_popup", POPUP_CONSENT_TEXT);
      setPromoOpen(false);
      setPopupEmail("");
      toast({ title: "Signed up!", description: "Discounts unlocked for this quote." });
    } catch (e: any) {
      toast({ title: "Could not sign up", description: e.message, variant: "destructive" });
    } finally {
      setPopupSubmitting(false);
    }
  };

  const applyPromo = async () => {
    if (!promoInput.trim()) return;
    setPromoLoading(true);
    try {
      const res = await apiRequest("POST", "/api/promo-codes/validate", { code: promoInput.toUpperCase() });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: "Invalid promo code", description: data.error, variant: "destructive" });
        return;
      }
      setPromoApplied({ code: data.code, type: data.type, value: data.value });
      form.setValue("promoCode", data.code);
      toast({ title: "Promo applied!", description: `${data.code} — ${data.type === "percent" ? `${data.value}% off` : `$${data.value} off`}` });
    } catch {
      toast({ title: "Error", description: "Could not validate promo code", variant: "destructive" });
    } finally {
      setPromoLoading(false);
    }
  };

  const createQuote = useMutation({
    mutationFn: async (data: QuoteFormValues) => {
      const payload = {
        ...data,
        emailConsent: emailConsentGranted,
        emailConsentId: emailConsentId,
        emailConsentSource: emailConsentSource,
        emailConsentText: emailConsentText,
      };
      const res = await apiRequest("POST", "/api/quotes", payload);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to create quote");
      }
      return res.json();
    },
    onSuccess: ({ quote }) => {
      toast({ title: "Quote created!", description: `Quote #${quote.id.slice(0, 8)} has been created.` });
      navigate(`/quotes/${quote.id}`);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-foreground">New Quote</h1>
        <p className="text-muted-foreground mt-1">Fill in the client details and services to generate a quote.</p>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(d => createQuote.mutate(d))} className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left column: form */}
            <div className="lg:col-span-2 space-y-6">

              {/* Client Intake */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <User size={16} className="text-primary" />
                    Client Information
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="name"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Full Name *</FormLabel>
                          <FormControl>
                            <Input data-testid="input-name" placeholder="Jane Smith" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="email"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Email *</FormLabel>
                          <FormControl>
                            <Input data-testid="input-email" type="email" placeholder="jane@example.com" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="phone"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Phone</FormLabel>
                          <FormControl>
                            <Input data-testid="input-phone" placeholder="(416) 555-0123" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="address"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Address</FormLabel>
                          <FormControl>
                            <Input data-testid="input-address" placeholder="123 Main St, Toronto" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                </CardContent>
              </Card>

              {/* Property Details */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Home size={16} className="text-primary" />
                    Property Details
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="propertyType"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Property Type</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value}>
                            <FormControl>
                              <SelectTrigger data-testid="select-property-type">
                                <SelectValue placeholder="Select type" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {PROPERTY_TYPES.map(p => (
                                <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="squareFootage"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Sq. ft. of areas to be cleaned</FormLabel>
                          <FormControl>
                            <Input
                              data-testid="input-sqft"
                              type="number"
                              min={0}
                              placeholder="e.g. 900"
                              {...field}
                              value={field.value === 0 ? '' : field.value}
                              onFocus={e => { if (Number(e.target.value) === 0) field.onChange(''); }}
                              onChange={e => field.onChange(parseFloat(e.target.value) || 0)}
                            />
                          </FormControl>
                          <p className="text-xs text-muted-foreground">Only include rooms to be cleaned — not your entire home</p>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="bedrooms"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Bedrooms</FormLabel>
                          <FormControl>
                            <Input
                              data-testid="input-bedrooms"
                              type="number"
                              min={0}
                              max={20}
                              placeholder="e.g. 2"
                              {...field}
                              value={field.value === 0 ? '' : field.value}
                              onFocus={e => { if (Number(e.target.value) === 0) field.onChange(''); }}
                              onChange={e => field.onChange(parseInt(e.target.value) || 0)}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="bathrooms"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Bathrooms</FormLabel>
                          <FormControl>
                            <Input
                              data-testid="input-bathrooms"
                              type="number"
                              min={0}
                              max={20}
                              placeholder="e.g. 1"
                              {...field}
                              value={field.value === 0 ? '' : field.value}
                              onFocus={e => { if (Number(e.target.value) === 0) field.onChange(''); }}
                              onChange={e => field.onChange(parseInt(e.target.value) || 0)}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                  <FormField
                    control={form.control}
                    name="specialNotes"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Special Notes</FormLabel>
                        <FormControl>
                          <Textarea
                            data-testid="input-notes"
                            placeholder="Pets, access instructions, specific areas to focus on..."
                            rows={3}
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </CardContent>
              </Card>

              {/* Services */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Wrench size={16} className="text-primary" />
                    Service Type
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <FormField
                    control={form.control}
                    name="serviceType"
                    render={({ field }) => (
                      <FormItem>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                          {SERVICE_OPTIONS.map(opt => (
                            <button
                              key={opt.value}
                              type="button"
                              data-testid={`service-${opt.value}`}
                              onClick={() => field.onChange(opt.value)}
                              className={`p-4 rounded-lg border-2 text-left transition-all ${
                                field.value === opt.value
                                  ? "border-primary bg-accent"
                                  : "border-border hover:border-primary/40"
                              }`}
                            >
                              <p className="font-semibold text-sm">{opt.label}</p>
                              <p className="text-xs text-muted-foreground mt-1">{opt.description}</p>
                            </button>
                          ))}
                        </div>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <Separator />

                  {/* Add-ons: only shown for Standard (deep/moveout include everything) */}
                  {values.serviceType === "standard" ? (
                    <div>
                      <p className="text-sm font-medium mb-1">Add-ons <span className="text-xs text-muted-foreground font-normal">(Standard only — included in Deep &amp; Move-In/Out)</span></p>
                      <FormField
                        control={form.control}
                        name="addons"
                        render={() => (
                          <FormItem>
                            <div className="grid grid-cols-2 gap-3">
                              {ADDON_OPTIONS.map(addon => (
                                <FormField
                                  key={addon.id}
                                  control={form.control}
                                  name="addons"
                                  render={({ field }) => (
                                    <FormItem className="flex items-center gap-3 p-3 border border-border rounded-lg">
                                      <FormControl>
                                        <Checkbox
                                          data-testid={`addon-${addon.id}`}
                                          checked={field.value?.includes(addon.id as any)}
                                          onCheckedChange={(checked) => {
                                            const current = field.value || [];
                                            if (checked) {
                                              field.onChange([...current, addon.id]);
                                            } else {
                                              field.onChange(current.filter((v: string) => v !== addon.id));
                                            }
                                          }}
                                        />
                                      </FormControl>
                                      <FormLabel className="font-normal cursor-pointer text-sm">
                                        {addon.label}
                                      </FormLabel>
                                    </FormItem>
                                  )}
                                />
                              ))}
                            </div>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">All add-ons are included in your selected package.</p>
                  )}
                </CardContent>
              </Card>

              {/* Promo Code + Discount Signup */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Tag size={16} className="text-primary" />
                    Promo Code &amp; Discounts
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {promoApplied ? (
                    <div className="flex items-center gap-3">
                      <CheckCircle2 size={18} className="text-green-600" />
                      <span className="text-sm font-medium text-green-700 dark:text-green-400">
                        {promoApplied.code} applied — {promoApplied.type === "percent" ? `${promoApplied.value}%` : `$${promoApplied.value}`} off
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="ml-auto text-muted-foreground"
                        onClick={() => { setPromoApplied(null); setPromoInput(""); form.setValue("promoCode", ""); }}
                      >
                        Remove
                      </Button>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <Input
                        data-testid="input-promo"
                        placeholder="Enter promo code"
                        value={promoInput}
                        onChange={e => setPromoInput(e.target.value.toUpperCase())}
                        onKeyDown={e => e.key === "Enter" && (e.preventDefault(), applyPromo())}
                        className="uppercase"
                      />
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={applyPromo}
                        disabled={promoLoading || !promoInput.trim()}
                        data-testid="button-apply-promo"
                      >
                        {promoLoading ? <Loader2 size={14} className="animate-spin" /> : "Apply"}
                      </Button>
                    </div>
                  )}

                  <Separator />

                  {/* Inline CASL consent — gates ALL discounts (A) */}
                  {emailConsentGranted ? (
                    <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400" data-testid="consent-granted">
                      <CheckCircle2 size={16} />
                      <span>&#10003; Signed up &mdash; discounts active</span>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <label className="flex items-start gap-3 cursor-pointer">
                        <Checkbox
                          data-testid="checkbox-consent"
                          checked={consentChecked}
                          onCheckedChange={c => setConsentChecked(c === true)}
                        />
                        <span className="text-sm leading-relaxed">
                          {INLINE_CONSENT_TEXT}
                        </span>
                      </label>

                      <div className="flex gap-2">
                        <Input
                          data-testid="input-consent-email"
                          type="email"
                          placeholder="you@email.com"
                          value={consentEmail}
                          onChange={e => setConsentEmail(e.target.value)}
                          disabled={!consentChecked}
                        />
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={handleInlineUnlock}
                          disabled={!consentChecked || !consentEmail.trim() || consentSubmitting}
                          data-testid="button-unlock-discount"
                        >
                          {consentSubmitting ? <Loader2 size={14} className="animate-spin" /> : "Unlock discount"}
                        </Button>
                      </div>

                      <div className="pt-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="px-0 h-auto text-primary hover:underline"
                          onClick={() => setPromoOpen(true)}
                          data-testid="button-open-promo-popup"
                        >
                          Get 15% off &mdash; sign up here
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Right column: price summary */}
            <div className="lg:col-span-1">
              <div className="sticky top-8 space-y-4">
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Calculator size={16} className="text-primary" />
                      Price Summary
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {items.length === 0 ? (
                      <p className="text-sm text-muted-foreground">Fill in the form to see pricing.</p>
                    ) : (
                      <>
                        {items.map((item, i) => (
                          <div key={i} className="flex justify-between text-sm">
                            <span className="text-muted-foreground">{item.label}</span>
                            <span className="font-medium">${item.amount.toFixed(2)}</span>
                          </div>
                        ))}

                        <Separator className="my-2" />

                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">Subtotal</span>
                          <span>${subtotal.toFixed(2)}</span>
                        </div>

                        {discount > 0 && (
                          <div className="flex justify-between text-sm">
                            <span className="text-green-600">Discount</span>
                            <span className="text-green-600">−${discount.toFixed(2)}</span>
                          </div>
                        )}

                        {discountLocked && (
                          <div className="flex justify-between text-sm opacity-60" data-testid="discount-locked">
                            <span className="flex items-center gap-1 text-muted-foreground line-through">
                              <Lock size={12} /> Discount
                            </span>
                            <span className="text-muted-foreground text-xs font-normal">
                              Sign up to unlock
                            </span>
                          </div>
                        )}

                        <div className="flex justify-between font-bold text-base pt-1 border-t border-border">
                          <span>Total</span>
                          <span className="text-primary">${total.toFixed(2)} CAD</span>
                        </div>

                        <p className="text-xs text-muted-foreground pt-1">Valid for 14 days from creation</p>
                      </>
                    )}
                  </CardContent>
                </Card>

                <Button
                  type="submit"
                  className="w-full"
                  size="lg"
                  disabled={createQuote.isPending}
                  data-testid="button-create-quote"
                >
                  {createQuote.isPending ? (
                    <><Loader2 size={16} className="animate-spin mr-2" /> Creating…</>
                  ) : (
                    <>Create Quote <ChevronRight size={16} className="ml-2" /></>
                  )}
                </Button>

                {settings && (
                  <div className="rounded-lg bg-muted p-3">
                    <p className="text-xs font-medium text-muted-foreground mb-1">Using current rates</p>
                    <p className="text-xs text-muted-foreground">Base: ${settings.baseRate} · Sq ft: ${settings.pricePerSqft}/sq ft</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </form>
      </Form>

      {/* Promo popup (B) — click-triggered only, no auto-open.
          Ghosted placeholder copy was removed; proper email input + real consent
          disclosure below the input. */}
      <Dialog open={promoOpen} onOpenChange={setPromoOpen}>
        <DialogContent data-testid="promo-popup">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Mail size={16} className="text-primary" />
              Get 15% off your first clean
            </DialogTitle>
            <DialogDescription>
              Enter your email below to unlock the welcome discount.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <Input
              data-testid="input-popup-email"
              type="email"
              placeholder="you@email.com"
              value={popupEmail}
              onChange={e => setPopupEmail(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handlePopupSubmit();
                }
              }}
            />
            <p className="text-xs text-muted-foreground leading-relaxed">
              {POPUP_CONSENT_TEXT}
            </p>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setPromoOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handlePopupSubmit}
              disabled={!popupEmail.trim() || popupSubmitting}
              data-testid="button-popup-submit"
            >
              {popupSubmitting ? <Loader2 size={14} className="animate-spin" /> : "Unlock discount"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
