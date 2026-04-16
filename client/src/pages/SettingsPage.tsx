import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Settings, Tag, Plus, Trash2, Loader2, Save, DollarSign } from "lucide-react";
import { format } from "date-fns";
import type { Settings as SettingsType, PromoCode } from "@shared/schema";
import { useState } from "react";

// Pricing form schema
const pricingSchema = z.object({
  baseRate: z.number().min(0),
  pricePerSqft: z.number().min(0),
  fridgePrice: z.number().min(0),
  groutPrice: z.number().min(0),
  windowsPrice: z.number().min(0),
  baseboardsPrice: z.number().min(0),
  deepCleanSurcharge: z.number().min(0),
  moveoutSurcharge: z.number().min(0),
});
type PricingForm = z.infer<typeof pricingSchema>;

// Promo form schema
const promoSchema = z.object({
  code: z.string().min(1, "Code required").regex(/^[A-Z0-9]+$/, "Uppercase letters/numbers only"),
  type: z.enum(["percent", "fixed"]),
  value: z.number().min(0.01, "Value must be > 0"),
  validFrom: z.string().optional(),
  validTo: z.string().optional(),
});
type PromoForm = z.infer<typeof promoSchema>;

function PricingField({ label, name, form, prefix = "$" }: { label: string; name: keyof PricingForm; form: any; prefix?: string }) {
  return (
    <div className="flex items-center justify-between py-2">
      <Label className="text-sm font-normal">{label}</Label>
      <div className="flex items-center gap-1">
        <span className="text-sm text-muted-foreground">{prefix}</span>
        <Input
          data-testid={`input-pricing-${name}`}
          type="number"
          min="0"
          step="0.01"
          className="w-24 h-8 text-right"
          {...form.register(name, { valueAsNumber: true })}
        />
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [promoDialogOpen, setPromoDialogOpen] = useState(false);

  // Fetch settings
  const { data: settings, isLoading: settingsLoading } = useQuery<SettingsType>({
    queryKey: ["/api/settings"],
  });

  const pricingForm = useForm<PricingForm>({
    resolver: zodResolver(pricingSchema),
    defaultValues: {
      baseRate: 80,
      pricePerSqft: 0.25,
      fridgePrice: 25,
      groutPrice: 35,
      windowsPrice: 40,
      baseboardsPrice: 30,
      deepCleanSurcharge: 60,
      moveoutSurcharge: 100,
    },
    values: settings ? {
      baseRate: settings.baseRate,
      pricePerSqft: settings.pricePerSqft,
      fridgePrice: settings.fridgePrice,
      groutPrice: settings.groutPrice ?? 35,
      windowsPrice: settings.windowsPrice,
      baseboardsPrice: settings.baseboardsPrice,
      deepCleanSurcharge: settings.deepCleanSurcharge,
      moveoutSurcharge: settings.moveoutSurcharge,
    } : undefined,
  });

  const savePricing = useMutation({
    mutationFn: async (data: PricingForm) => {
      const res = await apiRequest("PUT", "/api/settings", data);
      if (!res.ok) throw new Error("Failed to save settings");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({ title: "Settings saved!", description: "Pricing updated successfully." });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  // Promo codes
  const { data: promoCodes = [], isLoading: promoLoading } = useQuery<PromoCode[]>({
    queryKey: ["/api/promo-codes"],
  });

  const promoForm = useForm<PromoForm>({
    resolver: zodResolver(promoSchema),
    defaultValues: {
      code: "",
      type: "percent",
      value: 10,
      validFrom: "",
      validTo: "",
    },
  });

  const createPromo = useMutation({
    mutationFn: async (data: PromoForm) => {
      const res = await apiRequest("POST", "/api/promo-codes", data);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to create promo");
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/promo-codes"] });
      toast({ title: "Promo code created!" });
      promoForm.reset();
      setPromoDialogOpen(false);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const togglePromo = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      const res = await apiRequest("PUT", `/api/promo-codes/${id}`, { active });
      if (!res.ok) throw new Error("Failed to update");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/promo-codes"] });
    },
  });

  const deletePromo = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/promo-codes/${id}`, undefined);
      if (!res.ok) throw new Error("Failed to delete");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/promo-codes"] });
      toast({ title: "Promo code deleted." });
    },
  });

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground mt-1">Manage pricing rates and promo codes.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Pricing Settings */}
        <div className="lg:col-span-1">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <DollarSign size={16} className="text-primary" />
                Pricing Configuration
              </CardTitle>
              <CardDescription>These rates are used dynamically when generating quotes.</CardDescription>
            </CardHeader>
            <CardContent>
              {settingsLoading ? (
                <div className="space-y-3">
                  {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
                </div>
              ) : (
                <form onSubmit={pricingForm.handleSubmit(d => savePricing.mutate(d))}>
                  <div className="space-y-1">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Base Rates</p>
                    <PricingField label="Base Rate (daytime)" name="baseRate" form={pricingForm} />
                    <PricingField label="Price per Sq Ft" name="pricePerSqft" form={pricingForm} />

                    <Separator className="my-3" />
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Service Surcharges</p>
                    <PricingField label="Deep Clean Surcharge" name="deepCleanSurcharge" form={pricingForm} />
                    <PricingField label="Move-in/out Surcharge" name="moveoutSurcharge" form={pricingForm} />

                    <Separator className="my-3" />
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Add-on Prices</p>
                    <PricingField label="Inside Fridge" name="fridgePrice" form={pricingForm} />
                    <PricingField label="Grout Scrubbing" name="groutPrice" form={pricingForm} />
                    <PricingField label="Interior Windows" name="windowsPrice" form={pricingForm} />
                    <PricingField label="Baseboards" name="baseboardsPrice" form={pricingForm} />
                  </div>

                  {settings?.updatedAt && (
                    <p className="text-xs text-muted-foreground mt-3">
                      Last updated {format(new Date(settings.updatedAt), "MMM d, yyyy 'at' h:mm a")}
                    </p>
                  )}

                  <Button
                    type="submit"
                    className="w-full mt-4"
                    disabled={savePricing.isPending}
                    data-testid="button-save-pricing"
                  >
                    {savePricing.isPending ? (
                      <><Loader2 size={14} className="animate-spin mr-2" /> Saving…</>
                    ) : (
                      <><Save size={14} className="mr-2" /> Save Pricing</>
                    )}
                  </Button>
                </form>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Promo Codes */}
        <div className="lg:col-span-1">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Tag size={16} className="text-primary" />
                    Promo Codes
                  </CardTitle>
                  <CardDescription className="mt-0.5">Manage discount codes for your clients.</CardDescription>
                </div>
                <Dialog open={promoDialogOpen} onOpenChange={setPromoDialogOpen}>
                  <DialogTrigger asChild>
                    <Button size="sm" data-testid="button-add-promo">
                      <Plus size={14} className="mr-1" /> Add Code
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>New Promo Code</DialogTitle>
                    </DialogHeader>
                    <Form {...promoForm}>
                      <form onSubmit={promoForm.handleSubmit(d => createPromo.mutate(d))} className="space-y-4">
                        <FormField
                          control={promoForm.control}
                          name="code"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Code</FormLabel>
                              <FormControl>
                                <Input
                                  data-testid="input-promo-code"
                                  placeholder="SAVE10"
                                  className="uppercase"
                                  {...field}
                                  onChange={e => field.onChange(e.target.value.toUpperCase())}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <div className="grid grid-cols-2 gap-4">
                          <FormField
                            control={promoForm.control}
                            name="type"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Type</FormLabel>
                                <Select onValueChange={field.onChange} value={field.value}>
                                  <FormControl>
                                    <SelectTrigger data-testid="select-promo-type">
                                      <SelectValue />
                                    </SelectTrigger>
                                  </FormControl>
                                  <SelectContent>
                                    <SelectItem value="percent">Percentage</SelectItem>
                                    <SelectItem value="fixed">Fixed Amount</SelectItem>
                                  </SelectContent>
                                </Select>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          <FormField
                            control={promoForm.control}
                            name="value"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Value</FormLabel>
                                <FormControl>
                                  <Input
                                    data-testid="input-promo-value"
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    {...field}
                                    value={field.value === 0 ? '' : field.value}
                                    onFocus={e => { if (Number(e.target.value) === 0) field.onChange(''); }}
                                    onChange={e => field.onChange(parseFloat(e.target.value) || 0)}
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <FormField
                            control={promoForm.control}
                            name="validFrom"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Valid From (optional)</FormLabel>
                                <FormControl>
                                  <Input type="date" data-testid="input-promo-valid-from" {...field} />
                                </FormControl>
                              </FormItem>
                            )}
                          />
                          <FormField
                            control={promoForm.control}
                            name="validTo"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Valid To (optional)</FormLabel>
                                <FormControl>
                                  <Input type="date" data-testid="input-promo-valid-to" {...field} />
                                </FormControl>
                              </FormItem>
                            )}
                          />
                        </div>
                        <Button
                          type="submit"
                          className="w-full"
                          disabled={createPromo.isPending}
                          data-testid="button-create-promo"
                        >
                          {createPromo.isPending ? <Loader2 size={14} className="animate-spin mr-2" /> : null}
                          Create Promo Code
                        </Button>
                      </form>
                    </Form>
                  </DialogContent>
                </Dialog>
              </div>
            </CardHeader>
            <CardContent>
              {promoLoading ? (
                <div className="space-y-3">
                  {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
                </div>
              ) : promoCodes.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No promo codes yet.</p>
              ) : (
                <div className="space-y-2">
                  {promoCodes.map(pc => (
                    <div
                      key={pc.id}
                      data-testid={`promo-row-${pc.id}`}
                      className="flex items-center gap-3 p-3 border border-border rounded-lg"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-semibold text-sm">{pc.code}</span>
                          <Badge variant="outline" className="text-xs">
                            {pc.type === "percent" ? `${pc.value}%` : `$${pc.value}`} off
                          </Badge>
                          {!pc.active && (
                            <Badge variant="secondary" className="text-xs">Inactive</Badge>
                          )}
                        </div>
                        {(pc.validFrom || pc.validTo) && (
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {pc.validFrom ? `From ${format(new Date(pc.validFrom), "MMM d")}` : ""}
                            {pc.validFrom && pc.validTo ? " – " : ""}
                            {pc.validTo ? `to ${format(new Date(pc.validTo), "MMM d, yyyy")}` : ""}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Switch
                          checked={pc.active}
                          onCheckedChange={v => togglePromo.mutate({ id: pc.id, active: v })}
                          data-testid={`toggle-promo-${pc.id}`}
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive hover:text-destructive"
                          onClick={() => deletePromo.mutate(pc.id)}
                          data-testid={`delete-promo-${pc.id}`}
                        >
                          <Trash2 size={13} />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
