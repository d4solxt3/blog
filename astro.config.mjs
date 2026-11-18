// @ts-check
import { normalizeSiteUrl } from './scripts/site-url.mjs';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import node from '@astrojs/node';
import { unified } from '@astrojs/markdown-remark';
import { shikiConfig, remarkPlugins, rehypePlugins, remarkRehype } from './plugins/markdown.mjs';
import localAdmin from './plugins/admin-integration.mjs';

// Everything you'd want to change lives in site.config.json.
const site = JSON.parse(readFileSync(new URL('./site.config.json', import.meta.url), 'utf8'));
const address = normalizeSiteUrl(site.siteUrl);
const siteUrl = address ? new URL(address) : null;

export default defineConfig({
  // Your public address (siteUrl in site.config.json). Optional until you deploy.
  site: siteUrl?.href,

  // Behind a host's proxy (Railway, Render…), trust its forwarded headers for
  // your own domain only, so the comment rate limit sees each visitor's real IP.
  security: {
    allowedDomains: siteUrl ? [{ protocol: siteUrl.protocol.replace(':', ''), hostname: siteUrl.hostname }] : [],
  },

  // Pages are pre-built static HTML. Only /api/comments runs on a server,
  // which is why a Node adapter is configured (see CUSTOMIZING.md → Deploying).
  adapter: node({ mode: 'standalone' }),

  // localAdmin adds the /_admin editor to `npm run dev` only — never to builds.
  integrations: [mdx(), localAdmin()],

  // The dev toolbar floats bottom-centre, right over the light/dark switch.
  devToolbar: { enabled: false },

  markdown: {
    shikiConfig,
    processor: unified({ remarkPlugins, rehypePlugins, remarkRehype }),
  },
});
