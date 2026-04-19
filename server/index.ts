import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// ── CORS ──────────────────────────────────────────────────────────────────────
// Allows frontends to reach this Railway backend across origins.
// Both old (harryspottercleaning.ca) and new (harrietscleaning.ca) domains are
// listed during the brand transition so traffic continues without interruption.
// ALLOWED_ORIGINS env var can add additional origins if needed.
const DEFAULT_ORIGINS = [
  // New brand domains
  "https://harrietscleaning.ca",
  "https://www.harrietscleaning.ca",
  "https://quotes.harrietscleaning.ca",
  // Old brand domains — kept during transition
  "https://harryspottercleaning.ca",
  "https://quotes.harryspottercleaning.ca",
];
const envOrigins = (process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const allowedOrigins = Array.from(new Set([...DEFAULT_ORIGINS, ...envOrigins]));

app.use((req, res, next) => {
  const requestOrigin = req.headers.origin || "";
  if (allowedOrigins.length === 0) {
    // No origins configured — allow all (dev mode)
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (allowedOrigins.includes(requestOrigin)) {
    res.setHeader("Access-Control-Allow-Origin", requestOrigin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

// ── Request logger ────────────────────────────────────────────────────────────
export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }
      log(logLine);
    }
  });

  next();
});

(async () => {
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // In production (Railway), serve static assets only if SERVE_STATIC=true.
  // When frontend is on Netlify, this is false — Railway serves /api only.
  if (process.env.NODE_ENV === "production") {
    if (process.env.SERVE_STATIC === "true") {
      serveStatic(app);
    }
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
})();
