import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  productionBrowserSourceMaps: false,
  poweredByHeader: false,
  // Hosted demo (DEAL_DESK_DEMO=1): ship the seeded fictional workspace with
  // every server function so app/lib/demo.ts can copy it to the temp dir.
  outputFileTracingIncludes: { "/**": ["./demo/demo.db"] },
  devIndicators: false, // the dev-only corner chip overlaps the rail and pollutes review screenshots
  // proxy.ts buffers request bodies and cuts them at 10 MB by default; document
  // uploads are allowed up to 25 MB (app/lib/documentKinds.ts).
  experimental: { proxyClientMaxBodySize: "26mb" },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
