/** @type {import('next').NextConfig} */
const nextConfig = {
  // Self-contained server bundle — the Docker image copies .next/standalone
  // instead of all of node_modules.
  output: 'standalone',
  // Pin the workspace root so the standalone bundle lands at
  // .next/standalone/server.js even when a parent directory has a lockfile.
  turbopack: { root: import.meta.dirname },
}

export default nextConfig
