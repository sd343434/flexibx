import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

import { API_CONTENT_SECURITY_POLICY } from "./src/security/csp";
import { INVITATION_URL_PATTERN } from "./src/server/redact";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const isProduction = process.env.NODE_ENV === "production";

// Static security headers for every response. The page Content-Security-Policy is
// per-request (nonce) and set in src/proxy.ts; API routes get a strict static CSP below.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  },
  // Ignored by browsers over plain HTTP, so it is safe for local `next start` too.
  ...(isProduction
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]
    : []),
];

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  // Media uploads (images up to 10 MiB, src/server/marketing/media-service.ts) are the
  // only large server-action bodies; the service enforces the exact per-file limit.
  experimental: { serverActions: { bodySizeLimit: "11mb" } },
  // `next dev` prints every request URL (and server-action calls on it). URLs that can
  // carry a one-time invitation token are left out; `next start` has no request log.
  logging: { incomingRequests: { ignore: [INVITATION_URL_PATTERN] } },
  headers() {
    return Promise.resolve([
      { source: "/:path*", headers: securityHeaders },
      {
        source: "/api/:path*",
        headers: [
          { key: "Content-Security-Policy", value: API_CONTENT_SECURITY_POLICY },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ]);
  },
};

export default withNextIntl(nextConfig);
