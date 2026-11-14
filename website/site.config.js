// One place for the facts the whole site repeats. The build (vite.config.js)
// writes these into every page, robots.txt and sitemap.xml.

// The public address, no trailing slash. Change this the day a custom domain
// goes live: canonical links, social previews and the sitemap all follow it.
export const SITE_URL = 'https://prompt-engineering-skeleton-seven.vercel.app';

// The Chrome Web Store listing. Leave empty until the listing is public: the
// page then shows manual install steps. Once set, every install button links
// to the store and the manual steps are dropped.
// Looks like: https://chromewebstore.google.com/detail/prompt-memory/<id>
export const STORE_URL = '';

// Pages search engines should list. Sign-in and the dashboards stay out.
export const INDEXED_PAGES = [
  { path: '/', priority: '1.0' },
  { path: '/privacy', priority: '0.3' },
];
