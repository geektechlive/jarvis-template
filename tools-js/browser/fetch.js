#!/usr/bin/env node
'use strict';

// Usage: browser-fetch <url> [max-chars]
// Fetches a URL using stealth Chromium, bypassing most bot detection (Reddit, Cloudflare, etc.)
// Run from this directory so Node resolves deps from ./node_modules

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

chromium.use(StealthPlugin());

async function main() {
  const url = process.argv[2];
  const maxChars = parseInt(process.argv[3] || '6000', 10);

  if (!url) {
    process.stderr.write('Usage: browser-fetch <url> [max-chars]\n');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      locale: 'en-US',
      timezoneId: 'America/Chicago',
    });
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (response && response.status() >= 400) {
      process.stderr.write(`browser-fetch: HTTP ${response.status()} for ${url}\n`);
      process.exit(1);
    }
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    const text = await page.evaluate(() => {
      document.querySelectorAll('script, style, noscript').forEach(el => el.remove());
      return (document.body?.innerText || document.body?.textContent || '').trim();
    });

    const cleaned = text.replace(/\n{3,}/g, '\n\n').trim();
    process.stdout.write(cleaned.slice(0, maxChars));
    if (cleaned.length > maxChars) {
      process.stdout.write(`\n[truncated — ${cleaned.length} chars total, showing first ${maxChars}]\n`);
    }
    process.stdout.write('\n');
  } finally {
    await browser.close();
  }
}

main().catch(e => {
  process.stderr.write('browser-fetch error: ' + e.message + '\n');
  process.exit(1);
});
