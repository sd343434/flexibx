export interface CspOptions {
  readonly nonce: string;
  readonly isDevelopment: boolean;
  readonly upgradeInsecureRequests: boolean;
}

/**
 * Content-Security-Policy for HTML pages. Scripts require the per-request nonce
 * ('strict-dynamic' lets nonce-trusted scripts load Next.js chunks). Styles allow
 * 'unsafe-inline' because Next.js/next-font inject style tags; scripts never do.
 */
export function buildContentSecurityPolicy(options: CspOptions): string {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": [
      "'self'",
      `'nonce-${options.nonce}'`,
      "'strict-dynamic'",
      ...(options.isDevelopment ? ["'unsafe-eval'"] : []),
    ],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'", ...(options.isDevelopment ? ["ws:", "wss:"] : [])],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
    "manifest-src": ["'self'"],
    "worker-src": ["'self'", "blob:"],
  };

  const policy = Object.entries(directives).map(([name, values]) => `${name} ${values.join(" ")}`);
  if (options.upgradeInsecureRequests) policy.push("upgrade-insecure-requests");
  return policy.join("; ");
}

/** Strict policy for JSON API responses (no content is ever rendered). */
export const API_CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'";
