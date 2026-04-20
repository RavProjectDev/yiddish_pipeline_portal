import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@google/generative-ai"],
  outputFileTracingRoot: path.join(__dirname)
};

export default nextConfig;
