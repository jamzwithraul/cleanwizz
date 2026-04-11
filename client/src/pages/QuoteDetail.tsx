import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ArrowLeft,
  Send,
  CheckCircle2,
  Clock,
  FileText,
  User,
  Loader2,
  ExternalLink,
} from "lucide-react";
import { format } from "date-fns";
import type { Quote, QuoteItem, Client } from "@shared/schema";

type QuoteDetailData = {
  quote: Quote;
  items: QuoteItem[];
  client: Client;
};

const STATUS_MAP: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  draft: { label: "Draft", variant: "secondary" },
  sent: { label: "Sent", variant: "default" },
  accepted: { label: "Accepted", variant: "default" },
  expired: { label: "Expired", variant: "destructive" },
};

export default function QuoteDetail() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery<QuoteDetailData>({
    queryKey: ["/api/quotes", id],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/quotes/${id}`);
      if (!res.ok) throw new Error("Quote not found");
      return res.json();
    },
  });

  const sendEmail = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/quotes/${id}/send`, {});
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to send email");
      }
      return res.json();
    },
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["/api/quotes"] });
      qc.invalidateQueries({ queryKey: ["/api/quotes", id] });
      if (result.dev) {
        toast({ title: "Dev mode", description: "Email simulated — add RESEND_API_KEY to send real emails." });
      } else {
        toast({ title: "Email sent!", description: `Quote sent to ${data?.client.email}` });
      }
    },
    onError: (err: Error) => {
      toast({ title: "Error sending email", description: err.message, variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="text-center py-16">
        <p className="text-muted-foreground">Quote not found.</p>
        <Button variant="ghost" onClick={() => navigate("/")}>Go back</Button>
      </div>
    );
  }

  const { quote, items, client } = data;
  const status = STATUS_MAP[quote.status] ?? STATUS_MAP.draft;
  const expiresAt = format(new Date(quote.expiresAt), "MMMM d, yyyy");
  const createdAt = format(new Date(quote.createdAt), "MMMM d, yyyy 'at' h:mm a");
  const addons: string[] = JSON.parse(quote.addons || "[]");
  const services: string[] = JSON.parse(quote.services || "[]");

  const serviceLabel = services[0] === "deep" ? "Deep Clean"
    : services[0] === "moveout" ? "Move-in/out"
    : "Standard Clean";

  const addonLabels: Record<string, string> = {
    fridge: "Inside Fridge", oven: "Inside Oven", windows: "Interior Windows", baseboards: "Baseboards"
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-8">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate("/dashboard")}
          data-testid="button-back"
        >
          <ArrowLeft size={18} />
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold">Quote #{quote.id.slice(0, 8)}</h1>
            <Badge
              variant={status.variant}
              className={
                quote.status === "accepted" ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300" :
                quote.status === "sent" ? "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300" : ""
              }
              data-testid="status-badge"
            >
              {quote.status === "accepted" && <CheckCircle2 size={12} className="mr-1" />}
              {status.label}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">Created {createdAt}</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            asChild
            data-testid="button-email-preview"
          >
            <a href={`/api/quotes/${id}/email-preview`} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={14} className="mr-1" /> Preview Email
            </a>
          </Button>
          {quote.status !== "expired" && quote.status !== "accepted" && (
            <Button
              size="sm"
              onClick={() => sendEmail.mutate()}
              disabled={sendEmail.isPending}
              data-testid="button-send-email"
            >
              {sendEmail.isPending ? (
                <Loader2 size={14} className="animate-spin mr-1" />
              ) : (
                <Send size={14} className="mr-1" />
              )}
              {quote.status === "sent" ? "Resend" : "Send Quote"}
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">

          {/* Line Items */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <FileText size={16} className="text-primary" />
                Quote Details
              </CardTitle>
            </CardHeader>
            <CardContent>
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left text-xs font-medium text-muted-foreground pb-2">Service</th>
                    <th className="text-right text-xs font-medium text-muted-foreground pb-2">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(item => (
                    <tr key={item.id} className="border-b border-border/50 last:border-0">
                      <td className="py-2.5 text-sm">{item.label}</td>
                      <td className="py-2.5 text-sm text-right font-medium">${item.lineTotal.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="mt-4 space-y-2 pt-4 border-t border-border">
                <div className="flex justify-between text-sm text-muted-foreground">
                  <span>Subtotal</span>
                  <span>${quote.subtotal.toFixed(2)} CAD</span>
                </div>
                {quote.discount > 0 && (
                  <div className="flex justify-between text-sm text-green-600">
                    <span>Promo ({quote.promoCode})</span>
                    <span>−${quote.discount.toFixed(2)} CAD</span>
                  </div>
                )}
                <div className="flex justify-between font-bold text-base pt-1 border-t border-border">
                  <span>Total</span>
                  <span className="text-primary text-lg">${quote.total.toFixed(2)} CAD</span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Property Info */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Property & Services</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
                <div>
                  <p className="text-muted-foreground text-xs">Property Type</p>
                  <p className="font-medium capitalize">{quote.propertyType}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Square Footage</p>
                  <p className="font-medium">{quote.squareFootage > 0 ? `${quote.squareFootage} sq ft` : "—"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Bedrooms / Baths</p>
                  <p className="font-medium">{quote.bedrooms} bed / {quote.bathrooms} bath</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Service Type</p>
                  <p className="font-medium">{serviceLabel}</p>
                </div>
                {addons.length > 0 && (
                  <div className="col-span-2">
                    <p className="text-muted-foreground text-xs">Add-ons</p>
                    <p className="font-medium">{addons.map(a => addonLabels[a] || a).join(", ")}</p>
                  </div>
                )}
              </div>
              {quote.specialNotes && (
                <>
                  <Separator className="my-3" />
                  <div>
                    <p className="text-muted-foreground text-xs mb-1">Special Notes</p>
                    <p className="text-sm">{quote.specialNotes}</p>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Sidebar info */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <User size={16} className="text-primary" />
                Client
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="font-semibold">{client.name}</p>
              <p className="text-muted-foreground">{client.email}</p>
              {client.phone && <p className="text-muted-foreground">{client.phone}</p>}
              {client.address && <p className="text-muted-foreground">{client.address}</p>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Clock size={16} className="text-primary" />
                Validity
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Expires</span>
                <span className="font-medium">{expiresAt}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Currency</span>
                <span className="font-medium">CAD</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Status</span>
                <Badge
                  variant={status.variant}
                  className={
                    quote.status === "accepted" ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300 text-xs" :
                    quote.status === "sent" ? "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300 text-xs" : "text-xs"
                  }
                >
                  {status.label}
                </Badge>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
