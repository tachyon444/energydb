#!/usr/bin/env node
'use strict';

/**
 * India BEE HVAC crawler (PDF + Approval Date version)
 *
 * Flow:
 * 1) Open SearchCompare
 * 2) Choose HVAC category
 * 3) Force all visible filter boxes to Select All
 * 4) Click left-panel green Submit button
 * 5) Wait for result cards / Export to PDF button
 * 6) Click Export to PDF and download PDF
 * 7) Parse PDF text and extract Approval Date as registrationDate
 * 8) Keep only rows within last 7 days / last 2 months window
 * 9) POST to GAS doPost endpoint
 *
 * Recommended runtime:
 * - self-hosted Windows runner or local PC
 * - GitHub hosted runner was observed to time out against beestarlabel.com
 *
 * Environment variables:
 *   GAS_WEBAPP_URL                required, GAS Web App /exec URL
 *   INDIA_INGEST_TOKEN            optional, must match GAS Script Property INDIA_INGEST_TOKEN if set
 *   INDIA_BASE_URL                default https://www.beestarlabel.com/SearchCompare
 *   INDIA_HEADLESS                default true
 *   INDIA_TIMEOUT_MS              default 60000
 *   INDIA_DOWNLOAD_TIMEOUT_MS     default 120000
 *   INDIA_POST_BATCH_SIZE         default 200
 *   INDIA_DEBUG_DIR               default ./artifacts/india_debug
 *   INDIA_TZ                      default Asia/Seoul
 *   INDIA_CATEGORIES              optional comma-separated labels overriding defaults
 */

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const pdfParse = require('pdf-parse');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

chromium.use(StealthPlugin());

const CONFIG = {
  baseUrl: process.env.INDIA_BASE_URL || 'https://www.beestarlabel.com/SearchCompare',
  gasUrl: process.env.GAS_WEBAPP_URL || '',
  token: process.env.INDIA_INGEST_TOKEN || '',
  headless: parseBoolean(process.env.INDIA_HEADLESS, true),
  timeoutMs: toPositiveInt(process.env.INDIA_TIMEOUT_MS, 60000),
  downloadTimeoutMs: toPositiveInt(process.env.INDIA_DOWNLOAD_TIMEOUT_MS, 120000),
  postBatchSize: toPositiveInt(process.env.INDIA_POST_BATCH_SIZE, 200),
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

const TYPE_HINTS = [
  'air conditioner',
  'window/unitary',
  'window unitary',
  'split air',
  'split',
  'cassette',
  'ceiling/floor',
  'ceiling / floor',
  'floor standing',
  'tower',
  'chiller',
  'cooler',
  'evaporative',
  'vrf',
  'vrv',
];

async function main() {
  if (!CONFIG.gasUrl) {
    throw new Error('GAS_WEBAPP_URL is required.');
  }

  await fs.mkdir(CONFIG.debugDir, { recursive: true });

  const browser = await chromium.launch({
    headless: CONFIG.headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-setuid-sandbox',
      '--no-sandbox',
    ],
  });

  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1440, height: 1200 },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();
  page.setDefaultTimeout(CONFIG.timeoutMs);
  page.setDefaultNavigationTimeout(CONFIG.timeoutMs);

  const reportWindow = buildReportWindow(CONFIG.reportTz);
  const runId = 'india-pdf-' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const categories = CONFIG.categories.length ? CONFIG.categories : DEFAULT_CATEGORIES;

  const allRecords = [];
  const scrapeSummary = [];

  try {
    for (const category of categories) {
      console.log(`\n[INDIA] category=${category.label}`);
      try {
        const result = await scrapeCategoryViaPdf(page, category, reportWindow, runId);
        allRecords.push(...result.records);
        scrapeSummary.push({
          categoryKey: category.key,
          categoryLabel: category.label,
          scrapedRows: result.scrapedRows,
          keptRows7d: result.keptRows7d,
          keptRows2m: result.records.length,
          pdfFile: path.basename(result.pdfPath || ''),
          status: result.status || 'ok',
          message: result.message || '',
        });
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        console.error(`[INDIA] category failed: ${category.label} / ${message}`);
        await saveDebugArtifacts(page, `${slugify(category.label)}_fatal`).catch(() => {});
        scrapeSummary.push({
          categoryKey: category.key,
          categoryLabel: category.label,
          scrapedRows: 0,
          keptRows7d: 0,
          keptRows2m: 0,
          pdfFile: '',
          status: 'error',
          message,
        });
      }
    }

    const deduped = dedupeBy(allRecords, (row) => row.rowKey);
    console.log(JSON.stringify({ runId, summary: scrapeSummary, keptRows: deduped.length }, null, 2));

    await postToGasInBatches(deduped, reportWindow, runId, scrapeSummary);
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

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function sha1(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

function parseFlexibleDate(text) {
  const raw = normalizeText(text);
  if (!raw) return null;

  let m = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return safeUtcDate(Number(m[1]), Number(m[2]), Number(m[3]));

  m = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    let yy = Number(m[3]);
    if (yy < 100) yy += 2000;
    return safeUtcDate(yy, Number(m[1]), Number(m[2]));
  }

  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }
  return null;
}

function safeUtcDate(year, month, day) {
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return dt;
}

function isWithinWindow(date, start, end) {
  if (!date) return false;
  return date.getTime() >= start.getTime() && date.getTime() <= end.getTime();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function jitter(minMs, maxMs) {
  const waitMs = minMs + Math.floor(Math.random() * Math.max(1, maxMs - minMs + 1));
  await new Promise((resolve) => setTimeout(resolve, waitMs));
}

async function gotoSearchCompare(page) {
  const urls = [
    CONFIG.baseUrl,
    CONFIG.baseUrl.endsWith('/') ? CONFIG.baseUrl : CONFIG.baseUrl + '/',
  ];

  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    for (const url of urls) {
      try {
        console.log(`[INDIA] opening ${url} (attempt ${attempt})`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeoutMs });
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await dismissCookieOrNotice(page);
        await jitter(800, 1300);
        return;
      } catch (err) {
        lastErr = err;
        console.warn(`[INDIA] open failed for ${url} (attempt ${attempt}): ${err.message}`);
      }
    }
  }
  throw lastErr || new Error('Failed to open SearchCompare');
}

async function dismissCookieOrNotice(page) {
  const labels = ['Accept', 'I Agree', 'Got it', 'Close', 'OK'];
  for (const label of labels) {
    const button = page.getByRole('button', { name: new RegExp(`^${escapeRegExp(label)}$`, 'i') }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 1500 }).catch(() => {});
      await jitter(200, 400);
    }
  }
}

async function selectEquipmentCategory(page, label) {
  const normalizedTarget = normalizeOptionKey(label);
  const match = await page.evaluate((target) => {
    function norm(v) {
      return String(v == null ? '' : v)
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    }
    const selects = Array.from(document.querySelectorAll('select'));
    const candidates = [];
    selects.forEach((select, index) => {
      const rect = select.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0;
      if (!visible) return;
      Array.from(select.options || []).forEach((opt) => {
        const text = norm(opt.textContent || opt.label || '');
        if (!text || !opt.value) return;
        let score = 0;
        if (text === target) score = 100;
        else if (text.includes(target)) score = 80;
        else if (target.includes(text)) score = 60;
        if (score) {
          candidates.push({ index, value: opt.value, score, width: rect.width, top: rect.top });
        }
      });
    });
    candidates.sort((a, b) => b.score - a.score || b.width - a.width || a.top - b.top);
    return candidates[0] || null;
  }, normalizedTarget);

  if (!match) {
    throw new Error(`Could not find category option: ${label}`);
  }

  const select = page.locator('select').nth(match.index);
  await select.selectOption(match.value);
  await jitter(600, 1000);
}

function normalizeOptionKey(text) {
  return normalizeText(text).toLowerCase();
}

async function waitForFilterPanel(page) {
  await page.waitForFunction(() => {
    function isVisible(el) {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    const selects = Array.from(document.querySelectorAll('select')).filter((el) => {
      if (!isVisible(el)) return false;
      const rect = el.getBoundingClientRect();
      const isLeftPanel = rect.left < 520 && rect.top > 180;
      const enoughOptions = (el.options || []).length >= 2;
      return isLeftPanel && enoughOptions;
    });

    const labels = Array.from(document.querySelectorAll('label,h4,h5,div,span')).some((el) => {
      if (!isVisible(el)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.left >= 520 || rect.top <= 180) return false;
      const text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
      return /^(Brand|Type|Model|FModel|Star Rating|Indian Seasonal Energy Efficiency Ratio|Nominal Marketing Capacity)/i.test(text);
    });

    return selects.length >= 2 || labels;
  }, { timeout: CONFIG.timeoutMs });

  await jitter(1200, 1800);
}

async function selectAllVisibleFilters(page) {
  const allPasses = [];

  for (let pass = 1; pass <= 2; pass++) {
    const result = await page.evaluate((passNo) => {
      function norm(v) {
        return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
      }
      function isVisible(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      }
      function fireChange(select) {
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        select.dispatchEvent(new Event('blur', { bubbles: true }));
      }

      const summary = [];
      const selects = Array.from(document.querySelectorAll('select')).filter((select) => {
        if (!isVisible(select)) return false;
        const rect = select.getBoundingClientRect();
        const isLeftPanel = rect.left < 520 && rect.top > 180;
        const notCategoryBox = rect.top > 250;
        const enoughOptions = (select.options || []).length >= 2;
        return isLeftPanel && notCategoryBox && enoughOptions;
      });

      selects.forEach((select, idx) => {
        const rect = select.getBoundingClientRect();
        const options = Array.from(select.options || []);

        const selectAllOpt = options.find((opt) => /^select all$/i.test(norm(opt.textContent || opt.label || opt.value || ''))) ||
                             options.find((opt) => /^all$/i.test(norm(opt.textContent || opt.label || opt.value || '')));

        options.forEach((opt) => { opt.selected = false; });

        let mode = 'select-all-sentinel';
        let selectedLabels = [];

        if (selectAllOpt) {
          // BEE 화면은 'Select All' 옵션을 별도 값으로 받는 구조에 가깝습니다.
          // 모든 개별 옵션 수천 개를 선택하면 결과가 로딩되지 않거나 Export 버튼이 안 뜰 수 있으므로,
          // 반드시 sentinel인 'Select All' 자체만 선택합니다.
          selectAllOpt.selected = true;
          selectedLabels = [norm(selectAllOpt.textContent || selectAllOpt.label || selectAllOpt.value || 'Select All')];
        } else {
          // 일부 카테고리에서 Select All 옵션이 없을 때만 fallback으로 모든 실제 옵션 선택.
          mode = 'fallback-all-options';
          options.forEach((opt) => {
            const text = norm(opt.textContent || opt.label || '');
            if (!text) return;
            if (/^select appliances\/equipment$/i.test(text)) return;
            opt.selected = true;
          });
          selectedLabels = options.filter((opt) => opt.selected).slice(0, 5).map((opt) => norm(opt.textContent || opt.label || opt.value || ''));
        }

        fireChange(select);

        summary.push({
          pass: passNo,
          idx,
          mode,
          selectedCount: options.filter((opt) => opt.selected).length,
          optionsCount: options.length,
          selectedLabels,
          top: Math.round(rect.top),
          left: Math.round(rect.left),
        });
      });

      return summary;
    }, pass);

    allPasses.push(...result);
    await page.waitForTimeout(pass === 1 ? 1800 : 900);
  }

  // 마지막 pass만 submit 위치 계산에 사용합니다.
  const latestPass = allPasses.filter((x) => x.pass === 2);
  const finalSummary = latestPass.length ? latestPass : allPasses;
  console.log(`[INDIA] selected all filters: ${JSON.stringify(finalSummary)}`);
  await jitter(700, 1200);
  return finalSummary;
}

async function clickIndiaFilterSubmit(page, selectedInfos) {
  await page.waitForTimeout(800);

  const lastTop = Array.isArray(selectedInfos) && selectedInfos.length
    ? Math.max.apply(null, selectedInfos.map((x) => Number(x.top || 0)))
    : 0;

  const leftMin = Array.isArray(selectedInfos) && selectedInfos.length
    ? Math.min.apply(null, selectedInfos.map((x) => Number(x.left || 9999)))
    : 0;

  const result = await page.evaluate(({ lastTop, leftMin }) => {
    function isVisible(el) {
      if (!el || !el.getBoundingClientRect) return false;
      const st = window.getComputedStyle(el);
      if (!st) return false;
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width >= 20 && r.height >= 20;
    }

    function labelOf(el) {
      return [
        el.value,
        el.innerText,
        el.textContent,
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.getAttribute('name'),
        el.id,
        el.className,
      ]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    const els = Array.from(document.querySelectorAll('input, button, a'));
    const candidates = [];

    for (const el of els) {
      if (!isVisible(el)) continue;

      const label = labelOf(el);
      const labelLc = label.toLowerCase();
      const r = el.getBoundingClientRect();

      if (el.id === 'btnSubscribeNews') continue;
      if (labelLc.includes('latest news')) continue;
      if (labelLc.includes('subscribe')) continue;
      if (labelLc.includes('notification')) continue;

      const looksSubmit =
        labelLc.includes('submit') ||
        labelLc.includes('btn-green') ||
        labelLc.includes('btn-success');

      if (!looksSubmit) continue;
      if (r.left > 500) continue;
      if (r.top < 250) continue;

      const score =
        Math.abs(r.top - (lastTop + 70)) +
        Math.abs(r.left - leftMin) * 0.25 +
        (r.top < lastTop - 40 ? 1000 : 0);

      candidates.push({
        el,
        score,
        info: {
          id: el.id || '',
          label,
          top: Math.round(r.top),
          left: Math.round(r.left),
          width: Math.round(r.width),
          height: Math.round(r.height),
        },
      });
    }

    if (!candidates.length) {
      return { ok: false, reason: 'no-candidate' };
    }

    candidates.sort((a, b) => a.score - b.score);
    const picked = candidates[0];

    try {
      picked.el.scrollIntoView({ block: 'center', inline: 'nearest' });
    } catch (e) {}

    picked.el.click();

    return {
      ok: true,
      picked: picked.info,
      top5: candidates.slice(0, 5).map((x) => x.info),
    };
  }, { lastTop, leftMin });

  if (!result || !result.ok) {
    throw new Error('Filter submit button not found');
  }

  console.log(`[INDIA] filter submit picked: ${JSON.stringify(result.picked)}`);
  await page.waitForTimeout(2000);
}

async function waitForResultsReady(page) {
  await Promise.race([
    page.locator('text=/Export to PDF/i').first().waitFor({ timeout: CONFIG.timeoutMs }).catch(() => null),
    page.locator('text=/Valid Till/i').first().waitFor({ timeout: CONFIG.timeoutMs }).catch(() => null),
    page.locator('text=/Approval Date/i').first().waitFor({ timeout: CONFIG.timeoutMs }).catch(() => null),
    page.locator('text=/Reviews\/Feedback/i').first().waitFor({ timeout: CONFIG.timeoutMs }).catch(() => null),
  ]);
  await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
  await jitter(1200, 1800);
}

async function clickIndiaExportToPdf(page) {
  const deadline = Date.now() + 30000;

  while (Date.now() < deadline) {
    const result = await page.evaluate(() => {
      function isVisible(el) {
        if (!el || !el.getBoundingClientRect) return false;
        const st = window.getComputedStyle(el);
        if (!st) return false;
        if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width >= 20 && r.height >= 20;
      }

      function labelOf(el) {
        return [
          el.value,
          el.innerText,
          el.textContent,
          el.getAttribute('aria-label'),
          el.getAttribute('title'),
          el.getAttribute('name'),
          el.id,
          el.className,
        ]
          .filter(Boolean)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
      }

      const els = Array.from(document.querySelectorAll('input, button, a'));
      const candidates = [];

      for (const el of els) {
        if (!isVisible(el)) continue;
        const label = labelOf(el);
        const labelLc = label.toLowerCase();
        const r = el.getBoundingClientRect();

        if (!(labelLc.includes('export') && labelLc.includes('pdf'))) continue;

        candidates.push({
          el,
          score: Math.abs(r.top - 140) + Math.abs(r.left - 1120) * 0.1,
          info: {
            id: el.id || '',
            label,
            top: Math.round(r.top),
            left: Math.round(r.left),
            width: Math.round(r.width),
            height: Math.round(r.height),
          },
        });
      }

      if (!candidates.length) {
        return { ok: false };
      }

      candidates.sort((a, b) => a.score - b.score);
      const picked = candidates[0];

      try {
        picked.el.scrollIntoView({ block: 'center', inline: 'nearest' });
      } catch (e) {}

      picked.el.click();
      return { ok: true, picked: picked.info };
    });

    if (result && result.ok) {
      console.log(`[INDIA] export pdf picked: ${JSON.stringify(result.picked)}`);
      await page.waitForTimeout(1500);
      return;
    }

    await page.waitForTimeout(1000);
  }

  throw new Error('Export to PDF button not found');
}

async function downloadCategoryPdf(page, category) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: CONFIG.downloadTimeoutMs }),
    clickIndiaExportToPdf(page),
  ]);

  const fileName = `${slugify(category.label)}_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}.pdf`;
  const pdfPath = path.join(CONFIG.debugDir, fileName);
  await download.saveAs(pdfPath);
  return pdfPath;
}

async function scrapeCategoryViaPdf(page, category, reportWindow, runId) {
  await gotoSearchCompare(page);
  await selectEquipmentCategory(page, category.label);
  await waitForFilterPanel(page);
  const selectedInfos = await selectAllVisibleFilters(page);
  await clickIndiaFilterSubmit(page, selectedInfos);
  await waitForResultsReady(page);
  await saveDebugArtifacts(page, `${slugify(category.label)}_results`);

  const pdfPath = await downloadCategoryPdf(page, category);
  console.log(`[INDIA] downloaded PDF: ${pdfPath}`);
  const parsed = await parseCategoryPdf(pdfPath, category);

  const records = [];
  let keptRows7d = 0;

  for (const row of parsed.rows) {
    const approvalDate = parseFlexibleDate(row.approvalDate || '');
    if (!approvalDate) continue;
    if (!isWithinWindow(approvalDate, reportWindow.start2m, reportWindow.today)) continue;

    const approvalYmd = formatYmd(approvalDate);
    const validTillDate = parseFlexibleDate(row.validTill || '');
    const validTill = validTillDate ? formatYmd(validTillDate) : '';
    const manufacturer = normalizeText(row.manufacturer || row.brand || '');
    const modelName = normalizeText(row.modelName || '');
    const productType = normalizeText(row.productType || '');
    const starRating = normalizeText(row.starRating || '');
    if (!manufacturer && !modelName) continue;

    const within7d = isWithinWindow(approvalDate, reportWindow.start7, reportWindow.today);
    if (within7d) keptRows7d++;

    records.push({
      rowKey: sha1([
        category.key,
        manufacturer.toLowerCase(),
        modelName.toLowerCase(),
        approvalYmd,
      ].join('|')),
      region: 'IN',
      source: 'BEE_SEARCHCOMPARE_EXPORT_PDF',
      categoryKey: category.key,
      categoryLabel: category.label,
      manufacturer,
      modelName,
      registrationDate: approvalYmd,
      rawRegistrationDate: normalizeText(row.approvalDate || ''),
      approvalDate: approvalYmd,
      validTill,
      productType,
      starRating,
      brand: manufacturer,
      permittee: manufacturer,
      detailUrl: '',
      sourceUrl: CONFIG.baseUrl,
      within7d,
      within2m: true,
      crawlerRunAt: reportWindow.nowIso,
      runId,
    });
  }

  return {
    status: 'ok',
    message: '',
    pdfPath,
    scrapedRows: parsed.rows.length,
    keptRows7d,
    records,
  };
}

async function parseCategoryPdf(pdfPath, category) {
  const buffer = await fs.readFile(pdfPath);
  const parsed = await pdfParse(buffer);
  const text = parsed && parsed.text ? parsed.text : '';
  const txtPath = pdfPath.replace(/\.pdf$/i, '.txt');
  await fs.writeFile(txtPath, text, 'utf8').catch(() => {});
  const rows = parseBeePdfText(text, category);
  return { rows, textPath: txtPath };
}

function parseBeePdfText(text, category) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => normalizeText(line))
    .filter(Boolean);

  const blocks = splitPdfLinesIntoRowBlocks(lines);
  const rows = [];
  for (const block of blocks) {
    const row = parsePdfRowBlock(block, category);
    if (row) rows.push(row);
  }
  return dedupeBy(rows, (row) => [row.manufacturer, row.modelName, row.approvalDate].join('|').toLowerCase());
}

function splitPdfLinesIntoRowBlocks(lines) {
  const blocks = [];
  let current = [];

  for (const line of lines) {
    if (isPdfNoiseLine(line)) continue;
    if (isPdfRowStartLine(line)) {
      if (current.length) {
        blocks.push(current);
        current = [];
      }
      current.push(line);
    } else if (current.length) {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current);
  return blocks;
}

function isPdfNoiseLine(line) {
  const lower = normalizeText(line).toLowerCase();
  if (!lower) return true;
  if (lower.includes('bureau of energy efficiency')) return true;
  if (lower.includes('ministry of power')) return true;
  if (lower.includes('star rating list for')) return true;
  if (lower.includes('approval date') || lower === 'approval') return true;
  if (lower === 'date') return true;
  if (lower.includes('valid till')) return true;
  if (lower.includes('s.no')) return true;
  if (lower === 'brand' || lower === 'type' || lower === 'model no') return true;
  if (lower.includes('nominal marketing capacity')) return true;
  if (lower.includes('cooling seasonal energy consumption')) return true;
  if (lower.includes('power consumption')) return true;
  if (lower.includes('cooling capacity')) return true;
  if (lower.includes('eer(w)')) return true;
  if (lower.includes('eer (w)')) return true;
  if (lower.includes('equivalent iseer')) return true;
  if (lower === 'star rating') return true;
  if (/^page\s+\d+/i.test(lower)) return true;
  return false;
}

function isPdfRowStartLine(line) {
  return /^\d+\b(?:\s+[A-Z][A-Z0-9&()./' -]+)?$/.test(line);
}

function parsePdfRowBlock(block, category) {
  if (!block || !block.length) return null;
  let lines = block.slice();
  let serial = '';
  let brand = '';

  const first = lines[0];
  let m = first.match(/^(\d+)\s+(.+)$/);
  if (m) {
    serial = m[1];
    brand = normalizeText(m[2]);
    lines = [brand].concat(lines.slice(1));
  } else if (/^\d+$/.test(first)) {
    serial = first;
    lines = lines.slice(1);
    brand = normalizeText(lines[0] || '');
  }

  const dateEntries = [];
  lines.forEach((line, idx) => {
    const matches = line.match(/\b\d{1,2}[/-]\d{1,2}[/-]\d{4}\b/g);
    if (matches) {
      matches.forEach((match) => dateEntries.push({ idx, value: match }));
    }
  });
  if (dateEntries.length < 2) return null;

  const approvalDate = dateEntries[0].value;
  const validTill = dateEntries[1].value;
  const firstDateIdx = dateEntries[0].idx;

  const preDateLines = lines.slice(0, firstDateIdx).filter(Boolean);
  const textOnly = preDateLines.filter((line) => !looksNumericLine(line));
  if (!textOnly.length) return null;

  if (!brand) brand = normalizeText(textOnly[0] || '');
  const rest = textOnly.slice(brand ? 1 : 0).map(cleanModelLine).filter(Boolean);

  let typeLines = [];
  let modelLines = [];
  let modelStarted = false;
  for (const line of rest) {
    if (!modelStarted && looksLikeTypeLine(line)) {
      typeLines.push(line);
      continue;
    }
    modelStarted = true;
    if (/^family of model/i.test(line)) continue;
    modelLines.push(line);
  }

  if (!typeLines.length) {
    const inferred = inferTypeFromCategory(category.label);
    if (inferred) typeLines = [inferred];
  }
  if (!modelLines.length && rest.length) {
    modelLines = rest.slice(typeLines.length);
  }
  if (!modelLines.length && rest.length) {
    modelLines = [rest[rest.length - 1]];
  }

  const starRating = parseStarRatingFromBlock(lines);
  const modelName = normalizeText(modelLines.join(' '));
  const productType = normalizeText(typeLines.join(' '));

  if (!brand && !modelName) return null;

  return {
    serial,
    manufacturer: normalizeText(brand),
    brand: normalizeText(brand),
    modelName,
    productType,
    approvalDate,
    validTill,
    starRating,
  };
}

function looksNumericLine(line) {
  const text = normalizeText(line);
  if (!text) return false;
  if (/^\d+(?:\.\d+)?$/.test(text)) return true;
  if (/^\d+[./-]\d+[./-]\d+$/.test(text)) return false;
  return false;
}

function cleanModelLine(line) {
  return normalizeText(line)
    .replace(/family of model'?s?:?/gi, '')
    .replace(/^model\s*no\s*:?/i, '')
    .trim();
}

function looksLikeTypeLine(line) {
  const lower = normalizeText(line).toLowerCase();
  if (!lower) return false;
  return TYPE_HINTS.some((hint) => lower.includes(hint));
}

function inferTypeFromCategory(label) {
  const lower = normalizeText(label).toLowerCase();
  if (!lower) return '';
  if (lower.includes('room air conditioner')) return 'Room air conditioner';
  if (lower.includes('light commercial')) return 'Light commercial air conditioner';
  if (lower.includes('chiller')) return 'Chiller';
  if (lower.includes('evaporative')) return 'Evaporative air cooler';
  return label;
}

function parseStarRatingFromBlock(lines) {
  for (const line of lines) {
    const m = normalizeText(line).match(/\b([1-5])\s*star\b/i);
    if (m) return m[1];
  }
  return '';
}

async function saveDebugArtifacts(page, tag) {
  const safe = slugify(tag);
  const screenshotPath = path.join(CONFIG.debugDir, `${safe}.png`);
  const htmlPath = path.join(CONFIG.debugDir, `${safe}.html`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  const html = await page.content().catch(() => '');
  if (html) await fs.writeFile(htmlPath, html, 'utf8').catch(() => {});
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
      source: 'BEE_SEARCHCOMPARE_EXPORT_PDF',
      schemaVersion: 2,
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
