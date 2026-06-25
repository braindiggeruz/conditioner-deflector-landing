// Additional smoke tests:
//   T7: BUYO 5xx / 502 -> Lead NOT fired
//   T8: BUYO 200 ok:false (rejected) -> Lead NOT fired
//   T9: double tap submit -> single Lead fired

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let scenario = 'reject_500';
let leadCallCount = 0;

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, pixel_id: '0' }));
    return;
  }
  if (url.pathname === '/api/track') {
    res.writeHead(200); res.end('{"ok":true}'); return;
  }
  if (url.pathname === '/api/lead') {
    leadCallCount++;
    let chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      if (scenario === 'reject_500') {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'buyo_failed' }));
      } else if (scenario === 'rejected_200') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'buyo_rejected' }));
      } else if (scenario === 'success_once') {
        // First call -> accept, slow response; subsequent -> still accept
        setTimeout(() => {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, event_id: body.meta_event_id || 'srv_x' }));
        }, 500);
      }
    });
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, 'index.html'), 'utf8'));
    return;
  }
  res.writeHead(404); res.end();
});

function listen(port) { return new Promise(r => server.listen(port, '127.0.0.1', r)); }

async function runScenario(name, scen, cb) {
  scenario = scen;
  leadCallCount = 0;
  const puppeteer = await import('puppeteer-core');
  const browser = await puppeteer.default.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  const fbqCalls = [];
  await page.exposeFunction('__captureFbq', (args) => fbqCalls.push(args));
  await page.evaluateOnNewDocument(() => {
    window.fbq = function() {
      window.__captureFbq(Array.from(arguments).map(a => {
        if (a && typeof a === 'object') { try { return JSON.parse(JSON.stringify(a)); } catch { return String(a); } }
        return a;
      }));
    };
    window.fbq.queue = [];
  });
  await page.goto('http://127.0.0.1:3459/', { waitUntil: 'networkidle0', timeout: 30000 });
  await cb(page, fbqCalls);
  await browser.close();
}

async function main() {
  await listen(3459);
  console.log('stub server on 3459');

  console.log('\n--- T7: BUYO 502 -> NO Lead ---');
  await runScenario('T7', 'reject_500', async (page, fbqCalls) => {
    await page.click('[data-testid="hero-cta"]');
    await new Promise(r => setTimeout(r, 800));
    await page.evaluate(() => {
      document.getElementById('fname').value = 'TestAudit';
      document.getElementById('fphone').value = '+998 90 123 45 67';
      document.getElementById('orderForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 3000));
    const ic = fbqCalls.filter(c => c[0]==='track' && c[1]==='InitiateCheckout').length;
    const lead = fbqCalls.filter(c => c[0]==='track' && c[1]==='Lead').length;
    console.log(`  IC=${ic} Lead=${lead}`);
    if (ic !== 1) throw new Error(`T7 FAIL: IC=${ic} expected 1`);
    if (lead !== 0) throw new Error(`T7 FAIL: Lead=${lead} expected 0 (BUYO rejected)`);
    console.log('  ✅ IC fires once, Lead does NOT fire on BUYO 502');
  });

  console.log('\n--- T8: BUYO 200 ok:false -> NO Lead ---');
  await runScenario('T8', 'rejected_200', async (page, fbqCalls) => {
    await page.click('[data-testid="hero-cta"]');
    await new Promise(r => setTimeout(r, 800));
    await page.evaluate(() => {
      document.getElementById('fname').value = 'TestAudit';
      document.getElementById('fphone').value = '+998 90 123 45 67';
      document.getElementById('orderForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 3000));
    const lead = fbqCalls.filter(c => c[0]==='track' && c[1]==='Lead').length;
    if (lead !== 0) throw new Error(`T8 FAIL: Lead=${lead} expected 0`);
    console.log('  ✅ Lead does NOT fire on BUYO 200/ok:false');
  });

  console.log('\n--- T9: Double-tap submit -> 1 Lead ---');
  await runScenario('T9', 'success_once', async (page, fbqCalls) => {
    await page.click('[data-testid="hero-cta"]');
    await new Promise(r => setTimeout(r, 800));
    await page.evaluate(() => {
      document.getElementById('fname').value = 'TestAudit';
      document.getElementById('fphone').value = '+998 90 123 45 67';
    });
    // Fire submit twice in rapid succession
    await page.evaluate(() => {
      document.getElementById('orderForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      document.getElementById('orderForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 4000));
    const ic = fbqCalls.filter(c => c[0]==='track' && c[1]==='InitiateCheckout').length;
    const lead = fbqCalls.filter(c => c[0]==='track' && c[1]==='Lead').length;
    console.log(`  IC=${ic} Lead=${lead} apiCalls=${leadCallCount}`);
    if (ic !== 1) throw new Error(`T9 FAIL: IC=${ic} expected 1`);
    if (lead !== 1) throw new Error(`T9 FAIL: Lead=${lead} expected 1 (double-tap should not double-fire)`);
    if (leadCallCount !== 1) throw new Error(`T9 FAIL: /api/lead called ${leadCallCount} times — should be 1 (leadInFlight guard)`);
    console.log('  ✅ Double-tap creates one /api/lead and one Lead event');
  });

  server.close();
  console.log('\n=== ALL EDGE-CASE TESTS PASSED ===');
}

main().catch(e => { console.error('TEST FAILED:', e.message); try { server.close(); } catch {} process.exit(1); });
