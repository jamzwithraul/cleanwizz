import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Send,
  MoreHorizontal,
  Eye,
  TrendingUp,
  FileText,
  CheckCircle2,
  Clock,
  Plus,
  Loader2,
} from "lucide-react";
import { format } from "date-fns";
import type { Quote } from "@shared/schema";

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-muted text-muted-foreground" },
  sent: { label: "Sent", className: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300" },
  accepted: { label: "Accepted", className: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300" },
  expired: { label: "Expired", className: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300" },
};

export default function Dashboard() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: quotes = [], isLoading } = useQuery<Quote[]>({
    queryKey: ["/api/quotes"],
  });

  const sendEmail = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/quotes/${id}/send`, {});
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to send email");
      }
      return res.json();
    },
    onSuccess: (result, id) => {
      qc.invalidateQueries({ queryKey: ["/api/quotes"] });
      if (result.dev) {
        toast({ title: "Dev mode", description: "Email simulated. Add RESEND_API_KEY to send real emails." });
      } else {
        toast({ title: "Email sent!", description: `Quote ${id.slice(0, 8)} sent.` });
      }
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  // Stats
  const total = quotes.length;
  const sent = quotes.filter(q => q.status === "sent").length;
  const accepted = quotes.filter(q => q.status === "accepted").length;
  const totalRevenue = quotes.filter(q => q.status === "accepted").reduce((s, q) => s + q.total, 0);

  const sorted = [...quotes].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-muted-foreground mt-1">Track and manage all your quotes.</p>
        </div>
        <Button onClick={() => navigate("/")} data-testid="button-new-quote">
          <Plus size={16} className="mr-2" /> New Quote
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center gap-2 mb-1">
              <FileText size={16} className="text-muted-foreground" />
              <p className="text-xs text-muted-foreground">Total Quotes</p>
            </div>
            <p className="text-2xl font-bold" data-testid="stat-total">{total}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center gap-2 mb-1">
              <Send size={16} className="text-blue-500" />
              <p className="text-xs text-muted-foreground">Sent</p>
            </div>
            <p className="text-2xl font-bold text-blue-600 dark:text-blue-400" data-testid="stat-sent">{sent}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center gap-2 mb-1">
              <CheckCircle2 size={16} className="text-green-500" />
              <p className="text-xs text-muted-foreground">Accepted</p>
            </div>
            <p className="text-2xl font-bold text-green-600 dark:text-green-400" data-testid="stat-accepted">{accepted}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center gap-2 mb-1">
              <TrendingUp size={16} className="text-primary" />
              <p className="text-xs text-muted-foreground">Revenue</p>
            </div>
            <p className="text-2xl font-bold text-primary" data-testid="stat-revenue">${totalRevenue.toFixed(0)}</p>
          </CardContent>
        </Card>
      </div>

      {/* Quotes table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">All Quotes</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : sorted.length === 0 ? (
            <div className="text-center py-16">
              <Clock size={32} className="mx-auto text-muted-foreground mb-3" />
              <p className="text-muted-foreground text-sm">No quotes yet.</p>
              <Button variant="ghost" onClick={() => navigate("/")} className="mt-2">
                Create your first quote
              </Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">Quote ID</th>
                    <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">Date</th>
                    <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">Total</th>
                    <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">Expires</th>
                    <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">Status</th>
                    <th className="text-right text-xs font-medium text-muted-foreground px-4 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map(quote => {
                    const status = STATUS_LABELS[quote.status] ?? STATUS_LABELS.draft;
                    return (
                      <tr
                        key={quote.id}
                        className="border-b border-border/50 last:border-0 hover:bg-muted/20 transition-colors"
                        data-testid={`row-quote-${quote.id}`}
                      >
                        <td className="px-4 py-3 text-sm font-mono font-medium">
                          #{quote.id.slice(0, 8)}
                        </td>
                        <td className="px-4 py-3 text-sm text-muted-foreground">
                          {format(new Date(quote.createdAt), "MMM d, yyyy")}
                        </td>
                        <td className="px-4 py-3 text-sm font-semibold">
                          ${quote.total.toFixed(2)} CAD
                        </td>
                        <td className="px-4 py-3 text-sm text-muted-foreground">
                          {format(new Date(quote.expiresAt), "MMM d, yyyy")}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${status.className}`}>
                            {status.label}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => navigate(`/quotes/${quote.id}`)}
                              data-testid={`button-view-${quote.id}`}
                              className="h-7 px-2 text-xs"
                            >
                              <Eye size={13} className="mr-1" /> View
                            </Button>
                            {quote.status !== "expired" && quote.status !== "accepted" && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => sendEmail.mutate(quote.id)}
                                disabled={sendEmail.isPending}
                                data-testid={`button-send-${quote.id}`}
                                className="h-7 px-2 text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400"
                              >
                                {sendEmail.isPending ? (
                                  <Loader2 size={12} className="animate-spin mr-1" />
                                ) : (
                                  <Send size={12} className="mr-1" />
                                )}
                                {quote.status === "sent" ? "Resend" : "Send"}
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
