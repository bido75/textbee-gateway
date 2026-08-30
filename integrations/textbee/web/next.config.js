/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',

  async redirects() {
    return [
      {
        source: '/',
        destination: '/dashboard',
        permanent: true,
      },
      {
        source: '/android',
        destination: 'https://dl.textbee.dev',
        permanent: false,
      },
      // The invite itself lives behind textbee.dev/discord, so it can rotate
      // in one place.
      {
        source: '/discord',
        destination: 'https://textbee.dev/discord',
        permanent: false,
      },
    ]
  },
}



module.exports = nextConfig;
