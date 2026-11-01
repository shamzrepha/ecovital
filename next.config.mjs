/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["@electric-sql/pglite"],
  outputFileTracingIncludes: {
    "/api/**/*": [
      "./lib/pglite-shim.mjs",
      "./node_modules/@electric-sql/pglite/**/*"
    ],
    "/**/*": [
      "./lib/pglite-shim.mjs",
      "./node_modules/@electric-sql/pglite/**/*"
    ]
  }
};
export default nextConfig;
