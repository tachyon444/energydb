#!/usr/bin/env node
'use strict';

/**
 * India BEE Star Label crawler
 *
 * Purpose:
 * - Open the public BEE Search & Compare portal with Playwright Extra + Stealth
 * - Scrape HVAC product rows from the selected equipment categories
 * - Keep only rows whose registration date is within:
 *     * last 7 days
 *     * current reporting 2-month window (previous month 1st ~ today)
 * - POST the normalized rows to a GAS Web App doPost endpoint
 *
 * Environment variables:
 *   GAS_WEBAPP_URL                required
 *   INDIA_INGEST_TOKEN            optional shared secret; if set, must match GAS Script Property INDIA_INGEST_TOKEN
 *   INDIA_BASE_URL                default https://www.beestarlabel.com/SearchCompare
 *   INDIA_HEADLESS                default true
 *   INDIA_MAX_PAGES_PER_CATEGORY  default 80
 *   INDIA_POST_BATCH_SIZE         default 200
 *   INDIA_TIMEOUT_MS              default 45000
 *   INDIA_DEBUG_DIR               default ./artifacts/india_debug
 *   INDIA_CATEGORIES              optional comma-separated labels overriding defaults
 *   INDIA_TZ                      default Asia/Seoul for reporting window alignment with GAS
 *
 * npm i playwright playwright-extra playwright-extra-plugin-stealth
 */

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('playwright-extra-plugin-stealth');

chromium.use(StealthPlugin());

const CONFIG = {
  baseUrl: process.env.INDIA_BASE_URL || 'https://www.beestarlabel.com/SearchCompare',
  gasUrl: process.env.GAS_WEBAPP_URL || '',
  token: process.env.INDIA_INGEST_TOKEN || '',
  headless: parseBoolean(process.env.INDIA_HEADLESS, true),
  maxPagesPerCategory: toPositiveInt(process.env.INDIA_MAX_PAGES_PER_CATEGORY, 80),
  postBatchSize: toPositiveInt(process.env.INDIA_POST_BATCH_SIZE, 200),
  timeoutMs: toPositiveInt(process.env.INDIA_TIMEOUT_MS, 45000),
  debugDir: process.env.INDIA_DEBUG_DIR || path.resolve(process.cwd(), 'artifacts/india_debug'),
  reportTz: process.env.INDIA_TZ || 'Asia/Seoul',
  categories: parseCategoryEnv(process.env.INDIA_CATEGORIES),
};

const DEFAULT_CATEGORIES = [
  { key: 'IN_RAC_FIXED', label: 'Room Air Conditioner (Fixed Speed)' },
  { key: 'IN_RAC_VARIABLE', label: 'Room Air Conditioner (Variable Speed)' },
  { key: 'IN_LIGHT_COMM_FIXED', label: 'Light Commercial Air Conditioners' },
  { key: 'IN_LIGHT_COMM_VARIABLE', label: 'Light Commercial AC Variable Speed' },
  { key: 'IN_CHILLERS', label: 'Chillers' },
  { key: 'IN_EVAP_AIR_COOLER', label: 'Evaporative Air Coolers' },
];

const HVAC_CATEGORY_MAP = DEFAULT_CATEGORIES.reduce((acc, item) => {
  acc[item.label.toLowerCase()] = item.key;
  return acc;
}, {});

const HEADER_ALIASES = {
  manufacturer: [
    'manufacturer', 'manufacturer name', 'company', 'company name', 'brand', 'brand/company name',
    'brand / company name', 'permittee', 'name of manufacturer', 'name of company', 'make', 'brand name'
  ],
  modelName: [
    'model', 'model name', 'model no', 'model no.', 'model number', 'model id', 'model identifier',
    'model name/no', 'model / type', 'type', 'product model'
  ],
  registrationDate: [
    'registration date', 'date of registration', 'approved date', 'date approved', 'approval date',
    'date of approval', 'registration dt', 'date', 'date of issue'
  ],
  starRating: ['star', 'star rating', 'rating'],
  brand: ['brand', 'brand name', 'make'],
  permittee: ['permittee', 'company', 'company name', 'brand/company name', 'brand / company name']
};

async function main() {
  if (!CONFIG.gasUrl) {
    throw new Error('GAS_WEBAPP_URL is required.');
  }

  await fs.mkdir(CONFIG.debugDir, { recursive: true });

  const browser = await chromium.launch({
    headless: CONFIG.headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-setuid-sandbox',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  await context.route('**/*', async (route) => {
    const req = route.request();
    const type = req.resourceType();
    if (type === 'image' || type === 'font' || type === 'media') {
      return route.abort();
    }
    return route.continue();
  });

  const page = await context.newPage();
  page.setDefaultTimeout(CONFIG.timeoutMs);
  page.setDefaultNavigationTimeout(CONFIG.timeoutMs);

  const runInfo = buildReportWindow(CONFIG.reportTz);
  const runId = 'india-' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);

  const allRecords = [];
  const scrapeSummary = [];

  try {
    for (const category of CONFIG.categories.length ? CONFIG.categories : DEFAULT_CATEGORIES) {
      const categoryResult = await scrapeCategory(page, category, runInfo, runId);
      allRecords.push(...categoryResult.records);
      scrapeSummary.push({
        categoryKey: category.key,
        categoryLabel: category.label,
        scrapedRows: categoryResult.scrapedRows,
        keptRows2m: categoryResult.records.length,
        pages: categoryResult.pages,
      });
    }

    const deduped = dedupeBy(allRecords, (row) => row.rowKey);
    console.log(JSON.stringify({ runId, summary: scrapeSummary, keptRows: deduped.length }, null, 2));

    if (deduped.length === 0) {
      console.warn('No India rows within reporting window were found. Sending empty payload to GAS for heartbeat.');
    }

    await postToGasInBatches(deduped, runInfo, runId, scrapeSummary);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

function parseBoolean(value, defaultValue) {
  if (value == null || value === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

function parseCategoryEnv(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((label) => ({ key: toCategoryKey(label), label }));
}

function toCategoryKey(label) {
  const key = HVAC_CATEGORY_MAP[String(label || '').trim().toLowerCase()];
  if (key) return key;
  return 'IN_' + String(label || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

function buildReportWindow(timeZone) {
  const now = new Date();
  const localParts = getZonedDateParts(now, timeZone);
  const todayLocal = new Date(Date.UTC(localParts.year, localParts.month - 1, localParts.day));
  const start7 = new Date(todayLocal.getTime() - 7 * 24 * 3600 * 1000);
  const start2m = new Date(Date.UTC(localParts.year, localParts.month - 2, 1));
  return {
    today: todayLocal,
    start7,
    start2m,
    todayStr: formatYmd(todayLocal),
    start7Str: formatYmd(start7),
    start2mStr: formatYmd(start2m),
    nowIso: now.toISOString(),
    timeZone,
  };
}

function getZonedDateParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  return {
    year: Number(parts.find((p) => p.type === 'year').value),
    month: Number(parts.find((p) => p.type === 'month').value),
    day: Number(parts.find((p) => p.type === 'day').value),
  };
}

function formatYmd(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function normalizeText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function normalizeHeader(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/\*/g, '')
    .replace(/[()]/g, ' ')
    .replace(/[^a-z0-9/ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseFlexibleDate(text) {
  const raw = normalizeText(text);
  if (!raw) return null;

  const direct = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (direct) {
    return safeUtcDate(Number(direct[1]), Number(direct[2]), Number(direct[3]));
  }

  const dmy = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (dmy) {
    let year = Number(dmy[3]);
    if (year < 100) year += 2000;
    return safeUtcDate(year, Number(dmy[2]), Number(dmy[1]));
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
  }
  return null;
}

function safeUtcDate(year, month, day) {
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null;
  }
  return dt;
}

function isWithinWindow(date, start, end) {
  if (!date) return false;
  return date.getTime() >= start.getTime() && date.getTime() <= end.getTime();
}

function sha1(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

async function jitter(minMs, maxMs) {
  const waitMs = minMs + Math.floor(Math.random() * Math.max(1, maxMs - minMs + 1));
  await new Promise((resolve) => setTimeout(resolve, waitMs));
}

async function scrapeCategory(page, category, reportWindow, runId) {
  console.log(`\n[INDIA] category=${category.label}`);
  await gotoSearchCompare(page);
  await selectEquipmentCategory(page, category.label);
  await clickSearchIfPresent(page);
  await waitForResults(page);
  await setLargestPageSizeIfPresent(page);

  const records = [];
  const seenKeys = new Set();
  const seenPageFingerprints = new Set();
  let pages = 0;
  let scrapedRows = 0;

  while (pages < CONFIG.maxPagesPerCategory) {
    pages += 1;
    await waitForResults(page);
    await jitter(400, 900);

    const pageData = await extractCurrentTable(page, category.label);
    if (!pageData || !pageData.rows.length) {
      console.warn(`[INDIA] No tabular rows found for ${category.label} on page ${pages}.`);
      await saveDebugArtifacts(page, `${slugify(category.label)}_page${pages}_notable`);
      break;
    }

    const pageFingerprint = sha1(JSON.stringify(pageData.rows.slice(0, 5)));
    if (seenPageFingerprints.has(pageFingerprint)) {
      console.warn(`[INDIA] Pagination loop detected for ${category.label}.`);
      break;
    }
    seenPageFingerprints.add(pageFingerprint);

    for (const row of pageData.rows) {
      scrapedRows += 1;
      const normalized = mapExtractedRow(category, row, reportWindow, runId);
      if (!normalized) continue;
      if (!seenKeys.has(normalized.rowKey)) {
        seenKeys.add(normalized.rowKey);
        records.push(normalized);
      }
    }

    const moved = await goToNextPage(page);
    if (!moved) break;
  }

  await saveDebugArtifacts(page, `${slugify(category.label)}_final`);

  return { records, scrapedRows, pages };
}

async function gotoSearchCompare(page) {
  await page.goto(CONFIG.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await dismissCookieOrNotice(page);
  await jitter(800, 1600);
}

async function dismissCookieOrNotice(page) {
  const dismissTexts = ['Accept', 'I Agree', 'Got it', 'Close', 'OK'];
  for (const text of dismissTexts) {
    const button = page.getByRole('button', { name: new RegExp(`^${escapeRegExp(text)}$`, 'i') }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 1500 }).catch(() => {});
      await jitter(200, 400);
    }
  }
}

async function selectEquipmentCategory(page, label) {
  const normalizedTarget = normalizeHeader(label);

  const match = await page.evaluate((target) => {
    function norm(v) {
      return String(v == null ? '' : v)
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
        .replace(/[()]/g, ' ')
        .replace(/[^a-z0-9/ ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    const selects = Array.from(document.querySelectorAll('select'));
    const candidates = [];

    selects.forEach((select, index) => {
      const options = Array.from(select.options || []);
      options.forEach((opt) => {
        const text = norm(opt.textContent || opt.label || '');
        if (!text || !opt.value) return;
        let score = 0;
        if (text === target) score = 100;
        else if (text.includes(target)) score = 80;
        else if (target.includes(text)) score = 50;
        if (score) {
          candidates.push({ index, value: opt.value, text, score });
        }
      });
    });

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0] || null;
  }, normalizedTarget);

  if (match) {
    const select = page.locator('select').nth(match.index);
    await select.selectOption(match.value);
    await jitter(500, 900);
    return;
  }

  const customTriggers = [
    page.getByRole('combobox').first(),
    page.locator('.select2-selection, .choices__inner, .dropdown-toggle').first(),
    page.locator('text=/Select Appliances|Equipment Category|Appliances\\/Equipment/i').first(),
  ];

  for (const trigger of customTriggers) {
    if (!(await trigger.isVisible().catch(() => false))) continue;
    await trigger.click({ timeout: 2500 }).catch(() => {});
    await jitter(300, 600);

    const option = page.getByText(new RegExp(escapeRegExp(label), 'i')).first();
    if (await option.isVisible().catch(() => false)) {
      await option.click({ timeout: 2500 }).catch(() => {});
      await jitter(500, 900);
      return;
    }
  }

  throw new Error(`Could not select category: ${label}`);
}

async function clickSearchIfPresent(page) {
  const candidates = [
    page.getByRole('button', { name: /search|submit|go/i }).first(),
    page.locator('input[type="submit"][value*="Search" i], button:has-text("Search")').first(),
  ];

  for (const locator of candidates) {
    if (await locator.isVisible().catch(() => false)) {
      await locator.click({ timeout: 1500 }).catch(() => {});
      await jitter(300, 600);
      return;
    }
  }
}

async function waitForResults(page) {
  await Promise.race([
    page.waitForSelector('table', { timeout: CONFIG.timeoutMs }).catch(() => null),
    page.waitForSelector('text=/No data|No records|No Result/i', { timeout: CONFIG.timeoutMs }).catch(() => null),
  ]);

  await page.waitForFunction(() => {
    const bodyText = document.body ? document.body.innerText || '' : '';
    return !/Please Wait/i.test(bodyText);
  }, { timeout: CONFIG.timeoutMs }).catch(() => {});

  await page.waitForLoadState('networkidle').catch(() => {});
}

async function setLargestPageSizeIfPresent(page) {
  const options = ['100', '50', '25'];
  const candidateSelectors = [
    'select[name*="length" i]',
    '.dataTables_length select',
    'select',
  ];

  for (const selector of candidateSelectors) {
    const select = page.locator(selector).first();
    if (!(await select.isVisible().catch(() => false))) continue;
    const available = await select.locator('option').allTextContents().catch(() => []);
    const wanted = options.find((v) => available.some((opt) => normalizeText(opt) === v));
    if (wanted) {
      await select.selectOption(wanted).catch(() => {});
      await jitter(300, 700);
      await waitForResults(page);
      return;
    }
  }
}

async function extractCurrentTable(page, categoryLabel) {
  const raw = await page.evaluate(() => {
    function isVisible(el) {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (!style) return false;
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) return false;
      return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    }

    function text(v) {
      return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    }

    return Array.from(document.querySelectorAll('table'))
      .filter((table) => isVisible(table))
      .map((table, tableIndex) => {
        const ths = Array.from(table.querySelectorAll('thead th'));
        let headers = ths.map((th) => text(th.innerText));
        let rows = Array.from(table.querySelectorAll('tbody tr')).filter((tr) => isVisible(tr));

        if (!headers.length) {
          const firstRow = Array.from(table.querySelectorAll('tr')).find((tr) => isVisible(tr));
          if (firstRow) {
            headers = Array.from(firstRow.querySelectorAll('th,td')).map((cell) => text(cell.innerText));
            rows = Array.from(table.querySelectorAll('tr')).filter((tr) => isVisible(tr)).slice(1);
          }
        }

        const mappedRows = rows.map((tr) => {
          const cells = Array.from(tr.querySelectorAll('th,td'));
          const values = cells.map((cell) => text(cell.innerText));
          const links = cells.map((cell) => {
            const a = cell.querySelector('a[href]');
            return a ? a.href : '';
          });
          return {
            values,
            links,
            html: tr.innerHTML,
          };
        });

        return {
          tableIndex,
          headers,
          rowCount: mappedRows.length,
          rows: mappedRows,
        };
      });
  });

  const scored = raw
    .map((table) => ({ ...table, score: scoreExtractedTable(table) }))
    .filter((table) => table.rowCount > 0)
    .sort((a, b) => b.score - a.score || b.rowCount - a.rowCount);

  const best = scored[0];
  if (!best) return null;

  const mappedRows = best.rows.map((row) => convertRawRow(best.headers, row));
  return {
    categoryLabel,
    headers: best.headers,
    rows: mappedRows,
  };
}

function scoreExtractedTable(table) {
  const headers = (table.headers || []).map((h) => normalizeHeader(h));
  let score = table.rowCount || 0;

  for (const header of headers) {
    if (HEADER_ALIASES.manufacturer.includes(header)) score += 50;
    if (HEADER_ALIASES.modelName.includes(header)) score += 50;
    if (HEADER_ALIASES.registrationDate.includes(header)) score += 50;
  }

  return score;
}

function convertRawRow(headers, row) {
  const normalizedHeaders = headers.map((h, idx) => normalizeHeader(h) || `col_${idx}`);
  const obj = { _headers: headers, _values: row.values, _links: row.links };

  normalizedHeaders.forEach((header, idx) => {
    obj[header] = normalizeText(row.values[idx] || '');
    if (row.links[idx]) obj[`${header}__link`] = row.links[idx];
  });

  obj._firstLink = row.links.find(Boolean) || '';
  return obj;
}

function pickField(row, aliases) {
  for (const alias of aliases) {
    const direct = row[alias];
    if (normalizeText(direct)) return normalizeText(direct);
  }
  for (const key of Object.keys(row)) {
    if (!aliases.includes(key)) continue;
    const value = normalizeText(row[key]);
    if (value) return value;
  }
  return '';
}

function mapExtractedRow(category, row, reportWindow, runId) {
  const manufacturer = pickField(row, HEADER_ALIASES.manufacturer) || pickField(row, HEADER_ALIASES.permittee);
  const modelName = pickField(row, HEADER_ALIASES.modelName);
  const registrationText = pickField(row, HEADER_ALIASES.registrationDate);
  const starRating = pickField(row, HEADER_ALIASES.starRating);
  const brand = pickField(row, HEADER_ALIASES.brand);
  const permittee = pickField(row, HEADER_ALIASES.permittee) || manufacturer;

  const registrationDate = parseFlexibleDate(registrationText);
  if (!registrationDate) return null;
  if (!isWithinWindow(registrationDate, reportWindow.start2m, reportWindow.today)) return null;

  const registrationYmd = formatYmd(registrationDate);
  const manufacturerSafe = manufacturer || brand || permittee || '';
  const modelSafe = modelName || '';
  if (!manufacturerSafe && !modelSafe) return null;

  const detailUrl = row._firstLink || '';
  const rowKey = sha1([
    category.key,
    normalizeText(manufacturerSafe).toLowerCase(),
    normalizeText(modelSafe).toLowerCase(),
    registrationYmd,
  ].join('|'));

  return {
    rowKey,
    region: 'IN',
    source: 'BEE_SEARCHCOMPARE',
    categoryKey: category.key,
    categoryLabel: category.label,
    manufacturer: manufacturerSafe,
    modelName: modelSafe,
    registrationDate: registrationYmd,
    rawRegistrationDate: registrationText,
    starRating,
    brand,
    permittee,
    detailUrl,
    sourceUrl: CONFIG.baseUrl,
    within7d: isWithinWindow(registrationDate, reportWindow.start7, reportWindow.today),
    within2m: true,
    crawlerRunAt: reportWindow.nowIso,
    runId,
  };
}

async function goToNextPage(page) {
  const candidates = [
    page.locator('.paginate_button.next:not(.disabled)').first(),
    page.locator('li.next:not(.disabled) a').first(),
    page.getByRole('link', { name: /^next$/i }).first(),
    page.getByRole('button', { name: /^next$/i }).first(),
    page.locator('a[aria-label*="Next" i], button[aria-label*="Next" i]').first(),
  ];

  for (const candidate of candidates) {
    if (!(await candidate.isVisible().catch(() => false))) continue;
    await candidate.click({ timeout: 2000 }).catch(() => {});
    await jitter(500, 900);
    return true;
  }

  return false;
}

async function saveDebugArtifacts(page, tag) {
  const safe = slugify(tag);
  const screenshotPath = path.join(CONFIG.debugDir, `${safe}.png`);
  const htmlPath = path.join(CONFIG.debugDir, `${safe}.html`);

  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  const html = await page.content().catch(() => '');
  if (html) {
    await fs.writeFile(htmlPath, html, 'utf8').catch(() => {});
  }
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dedupeBy(rows, keyFn) {
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const key = keyFn(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

async function postToGasInBatches(records, reportWindow, runId, scrapeSummary) {
  const batches = [];
  for (let i = 0; i < Math.max(records.length, 1); i += CONFIG.postBatchSize) {
    batches.push(records.slice(i, i + CONFIG.postBatchSize));
  }
  if (records.length === 0) batches[0] = [];

  for (let i = 0; i < batches.length; i++) {
    const payload = {
      action: 'india_ingest',
      source: 'BEE_SEARCHCOMPARE',
      schemaVersion: 1,
      token: CONFIG.token,
      runId,
      sentAt: new Date().toISOString(),
      reportWindow,
      scrapeSummary,
      batch: { index: i + 1, total: batches.length },
      records: batches[i],
    };

    const response = await fetch(CONFIG.gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`GAS POST failed (${response.status}): ${text}`);
    }
    console.log(`[INDIA] GAS batch ${i + 1}/${batches.length}: ${text}`);
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
