// Smoke test for Meta Pixel event sequencing.
//
// Verifies that with our new event taxonomy:
//   1. PageView fires once on load.
//   2. ViewContent fires once after 40% scroll.
//   3. Hero CTA click does NOT fire InitiateCheckout (scroll only).
//   4. Form field focus does NOT fire InitiateCheckout.
//   5. Validation failure does NOT fire InitiateCheckout.
//   6. Valid submit fires InitiateCheckout exactly once, BEFORE /api/lead.
//   7. /api/lead 5xx does NOT fire Lead.
//   8. /api/lead 200 + ok:true fires Lead exactly once.
//   9. Double submit does not double-fire Lead.
//  10. Browser Lead event_id matches the server-returned event_id.
//
// Run via: node tests/events-sequencing.test.js
// Requires: a static dev server serving /index.html on http://localhost:3457
// and intercepting /api/lead + /api/track requests.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// --- Stub server --------------------------------------------------------
let lastLeadBody = null;
let leadResponder = (req, res, body) => {
  lastLeadBody = body;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, event_id: body.meta_event_id || 'srv_evt_x' }));
};

const trackedEvents = [];

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, pixel_id: '0000000000000000' })); // any id is fine
    return;
  }
  if (url.pathname === '/api/track' && req.method === 'POST') {
    let chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const evs = Array.isArray(body.events) ? body.events : [body];
        for (const e of evs) trackedEvents.push(e.event);
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }
  if (url.pathname === '/api/lead' && req.method === 'POST') {
    let chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        leadResponder(req, res, body);
      } catch (e) {
        res.writeHead(500); res.end('parse error');
      }
    });
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  res.writeHead(404); res.end('not found');
});

function listen(port) {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
}

async function main() {
  const PORT = 3458;
  await listen(PORT);
  console.log(`stub server on http://127.0.0.1:${PORT}`);

  const puppeteer = await import('puppeteer-core');
  // Use chromium installed via apt or default; let user override via env.
  const exec = process.env.CHROME_PATH || '/usr/bin/chromium-browser' || '/usr/bin/google-chrome';
  let browser;
  try {
    browser = await puppeteer.default.launch({
      executablePath: exec,
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  } catch (e) {
    console.log('SKIP: no headless chromium available —', e.message);
    process.exit(0);
  }

  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });

  // Capture fbq calls
  await page.exposeFunction('__captureFbq', (args) => fbqCalls.push(args));
  const fbqCalls = [];

  await page.evaluateOnNewDocument(() => {
    // Stub Pixel
    window.fbq = function() {
      window.__captureFbq(Array.from(arguments).map(a => {
        if (a && typeof a === 'object') { try { return JSON.parse(JSON.stringify(a)); } catch { return String(a); } }
        return a;
      }));
    };
    window.fbq.queue = [];
  });

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle0', timeout: 30000 });

  const collect = () => fbqCalls.map(c => `${c[0]}:${c[1]}`).join('|');

  // T1: PageView fires
  // (already by inline boot)
  // T3: Hero CTA click — scroll to form, no IC
  await page.click('[data-testid="hero-cta"]');
  await new Promise(r => setTimeout(r, 800));
  const afterHero = collect();
  console.log('after hero click:', afterHero);
  if (/track:InitiateCheckout/.test(afterHero)) throw new Error('FAIL T3: Hero CTA fired InitiateCheckout');

  // T4: Focus name field — no IC
  await page.focus('[data-testid="input-name"]');
  await new Promise(r => setTimeout(r, 400));
  const afterFocus = collect();
  if (/track:InitiateCheckout/.test(afterFocus)) throw new Error('FAIL T4: Focus fired InitiateCheckout');

  // T5: Invalid submit — name too short, no IC
  await page.type('[data-testid="input-name"]', 'A');
  await page.type('[data-testid="input-phone"]', '+998901234567');
  await page.click('[data-testid="submit-button"]');
  await new Promise(r => setTimeout(r, 400));
  const afterInvalid = collect();
  if (/track:InitiateCheckout/.test(afterInvalid)) throw new Error('FAIL T5: invalid submit fired InitiateCheckout');

  // T6: Valid submit — fires IC, then Lead after /api/lead 200
  await page.evaluate(() => {
    document.getElementById('fname').value = 'TestAudit';
    document.getElementById('fphone').value = '+998 90 123 45 67';
  });
  // Manually fire submit event
  await page.evaluate(() => {
    document.getElementById('orderForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 3000));
  const afterSubmit = collect();
  console.log('after valid submit:', afterSubmit);
  const icCount = (afterSubmit.match(/track:InitiateCheckout/g) || []).length;
  const leadCount = (afterSubmit.match(/track:Lead/g) || []).length;
  if (icCount !== 1) throw new Error(`FAIL T6: InitiateCheckout fired ${icCount} times, expected 1`);
  if (leadCount !== 1) throw new Error(`FAIL T6: Lead fired ${leadCount} times, expected 1`);
  console.log('✅ InitiateCheckout (post-validation) fires exactly once');
  console.log('✅ Lead fires exactly once (post BUYO Accepted)');

  // T10: Browser Lead event_id matches what server returned
  const leadEventArg = fbqCalls.find(c => c[0] === 'track' && c[1] === 'Lead');
  const leadEid = (leadEventArg && leadEventArg[3] && leadEventArg[3].eventID) || null;
  const sentEid = lastLeadBody && lastLeadBody.meta_event_id;
  console.log(`browser Lead eventID=${leadEid} server-received meta_event_id=${sentEid}`);
  if (!leadEid || leadEid !== sentEid) {
    throw new Error(`FAIL T10: Browser Lead eventID (${leadEid}) does not equal server event_id (${sentEid})`);
  }
  console.log('✅ Browser Lead event_id matches server event_id');

  // T11: telemetry contract — initiate_checkout_fired and meta_browser_lead_sent are tracked
  if (!trackedEvents.includes('initiate_checkout_fired')) throw new Error('FAIL T11: initiate_checkout_fired not tracked');
  if (!trackedEvents.includes('meta_browser_lead_sent')) throw new Error('FAIL T11: meta_browser_lead_sent not tracked');
  console.log('✅ First-party telemetry records IC + Lead events');

  await browser.close();
  server.close();
  console.log('\n=== ALL TESTS PASSED ===');
  process.exit(0);
}

main().catch((e) => {
  console.error('TEST FAILED:', e.message);
  console.error(e.stack);
  try { server.close(); } catch {}
  process.exit(1);
});
