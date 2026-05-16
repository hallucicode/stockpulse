/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: { enabled: true },
    instrumentationHook: true,
  },
};

module.exports = nextConfig;
