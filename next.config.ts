import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // pdf-parse dynamically requires a bundled pdf.js build; mark it external so
    // Next doesn't attempt to bundle those assets and instead resolves them at
    // runtime from node_modules.
    serverComponentsExternalPackages: ["pdf-parse"],
  },
};

export default nextConfig;
