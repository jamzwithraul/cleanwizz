import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/ThemeProvider";
import Layout from "@/components/Layout";
import QuoteGenerator from "@/pages/QuoteGenerator";
import QuoteDetail from "@/pages/QuoteDetail";
import Dashboard from "@/pages/Dashboard";
import SettingsPage from "@/pages/SettingsPage";
import AvailabilityPage from "@/pages/AvailabilityPage";
import NotFound from "@/pages/not-found";

export default function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <Router hook={useHashLocation}>
          <Layout>
            <Switch>
              <Route path="/" component={QuoteGenerator} />
              <Route path="/quotes/:id" component={QuoteDetail} />
              <Route path="/dashboard" component={Dashboard} />
              <Route path="/availability" component={AvailabilityPage} />
              <Route path="/settings" component={SettingsPage} />
              <Route component={NotFound} />
            </Switch>
          </Layout>
        </Router>
        <Toaster />
      </QueryClientProvider>
    </ThemeProvider>
  );
}
