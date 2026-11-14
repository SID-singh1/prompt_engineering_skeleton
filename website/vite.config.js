import { defineConfig } from 'vite';
import { resolve } from 'path';
import { SITE_URL, STORE_URL, INDEXED_PAGES } from './site.config.js';

const PAGES = ['privacy', 'builder', 'login', 'dashboard'];

// Fills the placeholders the pages share, and keeps only the install block
// that matches whether the store listing exists yet.
function siteFacts() {
  const onStore = Boolean(STORE_URL);
  const drop = onStore ? 'manual' : 'store';
  return {
    name: 'site-facts',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return html
          .replace(new RegExp(`<!--if:${drop}-->[\\s\\S]*?<!--/if:${drop}-->`, 'g'), '')
          .replace(/<!--\/?if:(store|manual)-->/g, '')
          .replaceAll('__SITE_URL__', SITE_URL)
          .replaceAll('__INSTALL_HREF__', onStore ? STORE_URL : '/#install')
          .replaceAll('__INSTALL_LABEL__', onStore ? 'Add to Chrome' : 'Get the extension');
      },
    },
  };
}

// Vercel serves /login for login.html (cleanUrls). Do the same in dev and
// preview so links behave the same everywhere.
function cleanUrls() {
  const rewrite = (req, _res, next) => {
    const [path, query] = (req.url || '').split('?');
    const name = path.replace(/^\/|\/$/g, '');
    if (PAGES.includes(name)) req.url = `/${name}.html${query ? `?${query}` : ''}`;
    next();
  };
  return {
    name: 'clean-urls',
    configureServer(server) { server.middlewares.use(rewrite); },
    configurePreviewServer(server) { server.middlewares.use(rewrite); },
  };
}

// robots.txt and sitemap.xml, written from site.config.js at build time.
function crawlerFiles() {
  return {
    name: 'crawler-files',
    generateBundle() {
      const today = new Date().toISOString().slice(0, 10);
      const urls = INDEXED_PAGES.map(({ path, priority }) =>
        `  <url><loc>${SITE_URL}${path}</loc><lastmod>${today}</lastmod><priority>${priority}</priority></url>`
      ).join('\n');
      this.emitFile({
        type: 'asset',
        fileName: 'sitemap.xml',
        source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
      });
      this.emitFile({
        type: 'asset',
        fileName: 'robots.txt',
        source: `User-agent: *\nAllow: /\nDisallow: /builder\n\nSitemap: ${SITE_URL}/sitemap.xml\n`,
      });
    },
  };
}

export default defineConfig({
  root: '.',
  appType: 'mpa',
  plugins: [siteFacts(), cleanUrls(), crawlerFiles()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        privacy: resolve(__dirname, 'privacy.html'),
        builder: resolve(__dirname, 'builder.html'),
        login: resolve(__dirname, 'login.html'),
        dashboard: resolve(__dirname, 'dashboard.html'),
        notfound: resolve(__dirname, '404.html'),
      },
    },
  },
  server: {
    port: 3000,
    strictPort: true,
  },
});
