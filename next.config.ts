import type { NextConfig } from "next";

// Baseline security headers applied to every response.
// Deliberately conservative: we do NOT set a strict Content-Security-Policy or a
// feature-blocking Permissions-Policy here, because those can silently break
// working features (inline scripts, Supabase/web-push connections, the driver
// camera photo upload) and can't be verified without exercising every page.
// These four are safe across the whole app and cost nothing.
const securityHeaders = [
  // Force HTTPS for two years, including the hr./driver./production. subdomains.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  // Stop the app being framed by other sites (clickjacking).
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  // Don't let browsers MIME-sniff responses into a different type.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Send only the origin (not the full URL/query) on cross-site navigations.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const nextConfig: NextConfig = {
  // Don't advertise the framework/version in a response header.
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
