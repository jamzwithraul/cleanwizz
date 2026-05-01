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
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { CalendarOff, Plus, Trash2, Loader2, Clock, CalendarDays } from "lucide-react";
import { format } from "date-fns";

interface BlockEvent {
  id: string;
  summary: string;
  reason: string;
  allDay: boolean;
  start: string;
  end: string;
  htmlLink: string;
}

// Hours selectable in the form (matches SLOT_WINDOWS: 8-11, 13-19)
const HOUR_OPTIONS = [
  { value: 8,  label: "8 AM" },
  { value: 9,  label: "9 AM" },
  { value: 10, label: "10 AM" },
  { value: 11, label: "11 AM" },
  { value: 12, label: "12 PM" },
  { value: 13, label: "1 PM" },
  { value: 14, label: "2 PM" },
  { value: 15, label: "3 PM" },
  { value: 16, label: "4 PM" },
  { value: 17, label: "5 PM" },
  { value: 18, label: "6 PM" },
  { value: 19, label: "7 PM" },
];

const blockSchema = z.object({
  reason: z.string().min(1, "Reason required").max(200),
  mode: z.enum(["allDay", "timed"]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date required"),
  startHour: z.number().min(0).max(23),
  endHour: z.number().min(1).max(23),
}).refine(d => d.mode === "allDay" || d.endHour > d.startHour, {
  message: "End time must be after start time",
  path: ["endHour"],
});
type BlockForm = z.infer<typeof blockSchema>;

function formatBlockRange(b: BlockEvent): string {
  if (b.allDay) {
    // Google all-day events: end is exclusive — display as inclusive single day
    const startDate = new Date(`${b.start}T12:00:00`);
    const endDateObj = new Date(`${b.end}T12:00:00`);
    endDateObj.setDate(endDateObj.getDate() - 1);
    if (b.start === format(endDateObj, "yyyy-MM-dd")) {
      return `${format(startDate, "EEE, MMM d, yyyy")} (all day)`;
    }
    return `${format(startDate, "MMM d")} – ${format(endDateObj, "MMM d, yyyy")} (all day)`;
  }
  const start = new Date(b.start);
  const end   = new Date(b.end);
  return `${start.toLocaleString("en-CA", { timeZone: "America/Toronto", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })} – ${end.toLocaleString("en-CA", { timeZone: "America/Toronto", hour: "numeric", minute: "2-digit", hour12: true })}`;
}

export default function AvailabilityPage() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: blocks = [], isLoading } = useQuery<BlockEvent[]>({
    queryKey: ["/api/availability/blocks"],
  });

  const form = useForm<BlockForm>({
    resolver: zodResolver(blockSchema),
    defaultValues: {
      reason: "",
      mode: "allDay",
      date: "",
      startHour: 8,
      endHour: 11,
    },
  });

  const mode = form.watch("mode");

  const createBlock = useMutation({
    mutationFn: async (data: BlockForm) => {
      const payload =
        data.mode === "allDay"
          ? { reason: data.reason, allDay: true, date: data.date }
          : { reason: data.reason, allDay: false, date: data.date, startHour: data.startHour, endHour: data.endHour };
      const res = await apiRequest("POST", "/api/availability/blocks", payload);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/availability/blocks"] });
      toast({ title: "Block created", description: "Time has been marked unavailable." });
      form.reset({ reason: "", mode: "allDay", date: "", startHour: 8, endHour: 11 });
    },
    onError: (err: Error) => {
      toast({ title: "Could not create block", description: err.message, variant: "destructive" });
    },
  });

  const removeBlock = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/availability/blocks/${id}`, undefined);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/availability/blocks"] });
      toast({ title: "Block removed" });
    },
    onError: (err: Error) => {
      toast({ title: "Could not delete", description: err.message, variant: "destructive" });
    },
  });

  // Today's date in YYYY-MM-DD for the date picker min
  const todayStr = new Date().toISOString().slice(0, 10);

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Availability</h1>
        <p className="text-muted-foreground mt-1">Block off time on the booking calendar — vacation, appointments, etc. Blocked time stops new bookings.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Add block */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Plus size={16} className="text-primary" />
              New Block
            </CardTitle>
            <CardDescription>Mark a day or time range as unavailable.</CardDescription>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(d => createBlock.mutate(d))} className="space-y-4">
                <FormField
                  control={form.control}
                  name="reason"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Reason</FormLabel>
                      <FormControl>
                        <Input
                          data-testid="input-block-reason"
                          placeholder="Vacation, doctor appt…"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="mode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Type</FormLabel>
                      <FormControl>
                        <RadioGroup
                          value={field.value}
                          onValueChange={field.onChange}
                          className="flex gap-4"
                        >
                          <div className="flex items-center gap-2">
                            <RadioGroupItem value="allDay" id="mode-allday" data-testid="radio-mode-allday" />
                            <Label htmlFor="mode-allday" className="font-normal cursor-pointer">Whole day</Label>
                          </div>
                          <div className="flex items-center gap-2">
                            <RadioGroupItem value="timed" id="mode-timed" data-testid="radio-mode-timed" />
                            <Label htmlFor="mode-timed" className="font-normal cursor-pointer">Specific slots</Label>
                          </div>
                        </RadioGroup>
                      </FormControl>
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="date"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Date</FormLabel>
                      <FormControl>
                        <Input
                          type="date"
                          min={todayStr}
                          data-testid="input-block-date"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {mode === "timed" && (
                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="startHour"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Start</FormLabel>
                          <Select
                            value={String(field.value)}
                            onValueChange={v => field.onChange(parseInt(v, 10))}
                          >
                            <FormControl>
                              <SelectTrigger data-testid="select-block-start">
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {HOUR_OPTIONS.slice(0, -1).map(o => (
                                <SelectItem key={o.value} value={String(o.value)}>{o.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="endHour"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>End</FormLabel>
                          <Select
                            value={String(field.value)}
                            onValueChange={v => field.onChange(parseInt(v, 10))}
                          >
                            <FormControl>
                              <SelectTrigger data-testid="select-block-end">
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {HOUR_OPTIONS.slice(1).map(o => (
                                <SelectItem key={o.value} value={String(o.value)}>{o.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                )}

                <Button
                  type="submit"
                  className="w-full"
                  disabled={createBlock.isPending}
                  data-testid="button-create-block"
                >
                  {createBlock.isPending ? (
                    <><Loader2 size={14} className="animate-spin mr-2" /> Creating…</>
                  ) : (
                    <><Plus size={14} className="mr-2" /> Create Block</>
                  )}
                </Button>
              </form>
            </Form>
          </CardContent>
        </Card>

        {/* Existing blocks */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <CalendarOff size={16} className="text-primary" />
              Active Blocks
            </CardTitle>
            <CardDescription>Upcoming unavailable time on the booking calendar.</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">
                {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
              </div>
            ) : blocks.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No blocks scheduled.</p>
            ) : (
              <div className="space-y-2">
                {blocks.map(b => (
                  <div
                    key={b.id}
                    data-testid={`block-row-${b.id}`}
                    className="flex items-start gap-3 p-3 border border-border rounded-lg"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-sm truncate">{b.reason || "Blocked"}</span>
                        <Badge variant={b.allDay ? "secondary" : "outline"} className="text-xs shrink-0">
                          {b.allDay ? <CalendarDays size={10} className="mr-1" /> : <Clock size={10} className="mr-1" />}
                          {b.allDay ? "All day" : "Timed"}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">{formatBlockRange(b)}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive hover:text-destructive shrink-0"
                      onClick={() => removeBlock.mutate(b.id)}
                      disabled={removeBlock.isPending}
                      data-testid={`delete-block-${b.id}`}
                    >
                      <Trash2 size={13} />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
