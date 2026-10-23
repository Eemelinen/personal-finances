import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Minimal self-contained server build for the Docker image.
  output: "standalone",
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    // CSV uploads (F-012) go through Server Actions; the import page allows
    // 4 MB files (src/app/(app)/import/limits.ts) plus multipart overhead.
    serverActions: { bodySizeLimit: "5mb" },
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
