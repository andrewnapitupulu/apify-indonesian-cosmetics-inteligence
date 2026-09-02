import crypto from 'node:crypto';
import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const BASE_URL = 'https://cekbpom.pom.go.id/produk-kosmetika';
const SNAPSHOT_VERSION = 1;

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const isoNow = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stableHash(record) {
    const fields = [
        'registrationNumber', 'productName', 'brand', 'registrant', 'packaging',
        'dosageForm', 'composition', 'applicationDate', 'issuedDate', 'expiryDate', 'status',
    ];
    const payload = Object.fromEntries(fields.map((key) => [key, clean(record[key])]));
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function normalizeKey(label) {
    return clean(label)
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function mapDetails(rawPairs = {}) {
    const normalized = Object.fromEntries(
        Object.entries(rawPairs).map(([key, value]) => [normalizeKey(key), clean(value)]),
    );

    const pick = (...candidates) => {
        for (const candidate of candidates) {
            const target = normalizeKey(candidate);
            if (normalized[target]) return normalized[target];
            const fuzzy = Object.entries(normalized).find(([key]) => key.includes(target) || target.includes(key));
            if (fuzzy?.[1]) return fuzzy[1];
        }
        return '';
    };

    return {
        registrationNumber: pick('nomor registrasi', 'nomor izin edar', 'nie'),
        productName: pick('nama produk'),
        brand: pick('merk', 'merek'),
        packaging: pick('kemasan'),
        dosageForm: pick('bentuk sediaan'),
        composition: pick('komposisi'),
        applicationDate: pick('tanggal permohonan'),
        issuedDate: pick('tanggal terbit'),
        expiryDate: pick('tanggal expired', 'tanggal kedaluwarsa'),
        registrant: pick('nama pendaftar', 'pendaftar'),
        status: pick('status'),
    };
}

function buildJobs(input) {
    const jobs = [];
    const add = (kind, values = []) => {
        for (const raw of values || []) {
            const value = clean(raw);
            if (value) jobs.push({ kind, value });
        }
    };

    add('brand', input.brands);
    add('registrant', input.registrants);
    add('productName', input.productNames);
    add('registrationNumber', input.registrationNumbers);
    add('composition', input.compositions);

    if (!jobs.length) jobs.push({ kind: 'all', value: '' });
    return jobs;
}

function inputPlaceholderFor(kind) {
    return {
        registrationNumber: 'Masukkan Nomor Registrasi',
        productName: 'Masukkan Nama Produk',
        brand: 'Masukkan Merk',
        composition: 'Masukkan Komposisi',
        registrant: 'Masukkan Nama Pendaftar',
    }[kind];
}

async function visibleLocator(locator) {
    const count = await locator.count();
    for (let i = count - 1; i >= 0; i--) {
        const item = locator.nth(i);
        if (await item.isVisible().catch(() => false)) return item;
    }
    return null;
}

async function applyFilter(page, job, requestDelayMs, log) {
    if (job.kind === 'all') return;

    const openFilter = await visibleLocator(page.getByRole('button', { name: /^Filter$/i }));
    if (!openFilter) throw new Error('BPOM Filter button was not found.');
    await openFilter.click();
    await sleep(requestDelayMs);

    const placeholder = inputPlaceholderFor(job.kind);
    if (!placeholder) throw new Error(`Unsupported query kind: ${job.kind}`);

    const field = await visibleLocator(page.locator(`input[placeholder="${placeholder}"]`));
    if (!field) throw new Error(`BPOM filter field was not found: ${placeholder}`);
    await field.fill(job.value);

    const applyFilterButton = await visibleLocator(page.getByRole('button', { name: /^Filter$/i }));
    if (!applyFilterButton) throw new Error('BPOM apply Filter button was not found.');

    const before = clean(await page.locator('table tbody').first().innerText().catch(() => ''));
    await applyFilterButton.click();
    await sleep(Math.max(300, requestDelayMs));

    await page.waitForFunction(
        (previous) => {
            const body = document.querySelector('table tbody');
            if (!body) return false;
            const current = (body.textContent || '').replace(/\s+/g, ' ').trim();
            return current !== previous || current.length > 0;
        },
        before,
        { timeout: 20000 },
    ).catch(() => log.debug('Table text did not visibly change after applying filter; continuing.'));
}

async function waitForTable(page) {
    await page.waitForSelector('table', { timeout: 30000 });
    await page.waitForFunction(() => {
        const table = document.querySelector('table');
        if (!table) return false;
        const body = table.querySelector('tbody');
        if (!body) return true;
        return body.querySelectorAll('tr').length > 0 || /tidak|data|kosong/i.test(body.textContent || '');
    }, { timeout: 30000 }).catch(() => undefined);
}

async function extractDetailPairs(dialog) {
    return dialog.evaluate((root) => {
        const result = {};
        const put = (key, value) => {
            const k = String(key || '').replace(/\s+/g, ' ').replace(/:$/, '').trim();
            const v = String(value || '').replace(/\s+/g, ' ').trim();
            if (k && v && k !== v && !result[k]) result[k] = v;
        };

        root.querySelectorAll('tr').forEach((tr) => {
            const cells = [...tr.querySelectorAll('th,td')].map((el) => el.textContent?.trim() || '').filter(Boolean);
            if (cells.length >= 2) put(cells[0], cells.slice(1).join(' '));
        });

        root.querySelectorAll('dt').forEach((dt) => {
            const dd = dt.nextElementSibling;
            if (dd?.tagName?.toLowerCase() === 'dd') put(dt.textContent, dd.textContent);
        });

        root.querySelectorAll('label').forEach((label) => {
            const container = label.parentElement;
            if (!container) return;
            const value = [...container.children]
                .filter((el) => el !== label)
                .map((el) => el.textContent?.trim() || el.getAttribute?.('value') || '')
                .filter(Boolean)
                .join(' ');
            put(label.textContent, value);
        });

        // Generic fallback for Bootstrap-like two-column rows.
        root.querySelectorAll('.row').forEach((row) => {
            const children = [...row.children].map((el) => el.textContent?.trim() || '').filter(Boolean);
            if (children.length === 2 && children[0].length < 80) put(children[0], children[1]);
        });

        return result;
    });
}

async function getVisibleDialog(page) {
    const candidates = page.locator('.modal:visible, [role="dialog"]:visible');
    const count = await candidates.count();
    for (let i = count - 1; i >= 0; i--) {
        const candidate = candidates.nth(i);
        const text = clean(await candidate.innerText().catch(() => ''));
        if (/detail produk/i.test(text) || text.length > 20) return candidate;
    }
    return null;
}

async function enrichFromRow(page, row, requestDelayMs, log) {
    const clickable = row.locator('a,button');
    const clickableCount = await clickable.count();

    try {
        if (clickableCount > 0) await clickable.last().click();
        else await row.click();

        await sleep(Math.max(250, requestDelayMs));
        const dialog = await getVisibleDialog(page);
        if (!dialog) return {};

        const rawPairs = await extractDetailPairs(dialog);
        const details = mapDetails(rawPairs);

        const closeButton = await visibleLocator(dialog.getByRole('button', { name: /^(Close|Tutup)$/i }));
        if (closeButton) await closeButton.click().catch(() => undefined);
        else await page.keyboard.press('Escape').catch(() => undefined);

        await sleep(Math.min(requestDelayMs, 500));
        return details;
    } catch (error) {
        log.debug(`Could not open/parse product detail: ${error.message}`);
        await page.keyboard.press('Escape').catch(() => undefined);
        return {};
    }
}

async function extractCurrentPage(page, job, options, log) {
    const { includeDetails, maxRemaining, requestDelayMs } = options;
    const table = page.locator('table').first();
    const rows = table.locator('tbody tr');
    const rowCount = await rows.count();
    const results = [];

    for (let i = 0; i < rowCount && results.length < maxRemaining; i++) {
        const row = rows.nth(i);
        const cells = (await row.locator('td').allTextContents()).map(clean).filter(Boolean);
        if (cells.length < 3) continue;
        if (/tidak ada data|no data|data tidak/i.test(cells.join(' '))) continue;

        const listRecord = {
            productType: cells[0] || 'KO',
            registrationNumber: cells[1] || '',
            productName: cells[2] || '',
            registrant: cells[3] || '',
        };

        const detail = includeDetails
            ? await enrichFromRow(page, row, requestDelayMs, log)
            : {};

        const record = {
            ...listRecord,
            ...Object.fromEntries(Object.entries(detail).filter(([, value]) => clean(value))),
            registrationNumber: clean(detail.registrationNumber || listRecord.registrationNumber),
            productName: clean(detail.productName || listRecord.productName),
            registrant: clean(detail.registrant || listRecord.registrant),
            category: 'Kosmetika',
            source: 'BPOM RI - Cek Produk',
            sourceUrl: BASE_URL,
            matchedBy: { type: job.kind, value: job.value },
            scrapedAt: isoNow(),
        };

        // A result without an NIE is too unstable for deduplication and monitoring.
        if (!record.registrationNumber) continue;
        results.push(record);
    }

    return results;
}

async function clickNext(page, requestDelayMs, log) {
    const next = await visibleLocator(page.getByRole('button', { name: /Selanjutnya/i }));
    if (!next) return false;

    const disabled = await next.isDisabled().catch(() => false)
        || (await next.getAttribute('disabled')) !== null
        || (await next.getAttribute('aria-disabled')) === 'true';
    if (disabled) return false;

    const before = clean(await page.locator('table tbody tr').first().innerText().catch(() => ''));
    await next.click();
    await sleep(Math.max(300, requestDelayMs));

    const changed = await page.waitForFunction(
        (previous) => {
            const first = document.querySelector('table tbody tr');
            const current = (first?.textContent || '').replace(/\s+/g, ' ').trim();
            return Boolean(current) && current !== previous;
        },
        before,
        { timeout: 15000 },
    ).then(() => true).catch(() => false);

    if (!changed) log.debug('Next page did not visibly change; stopping pagination to avoid a loop.');
    return changed;
}

function diffFields(previous, current) {
    const fields = [
        'productName', 'brand', 'registrant', 'packaging', 'dosageForm', 'composition',
        'applicationDate', 'issuedDate', 'expiryDate', 'status',
    ];
    return fields.filter((key) => clean(previous?.[key]) !== clean(current?.[key]));
}

function shouldEmit(mode, eventType) {
    if (mode === 'new') return eventType === 'NEW';
    if (mode === 'changes') return eventType === 'NEW' || eventType === 'CHANGED';
    return true;
}

await Actor.init();

try {
    const input = await Actor.getInput() ?? {};
    const jobs = buildJobs(input);
    const maxItemsPerQuery = Number(input.maxItemsPerQuery ?? 100);
    const maxPagesPerQuery = Number(input.maxPagesPerQuery ?? 20);
    const includeDetails = input.includeDetails !== false;
    const detectChanges = input.detectChanges !== false;
    const emit = input.emit ?? 'all';
    const requestDelayMs = Number(input.requestDelayMs ?? 500);
    const debug = Boolean(input.debug);

    Actor.log.info(`Starting ${jobs.length} BPOM cosmetics query job(s).`);

    const collected = new Map();
    const failedJobs = [];

    const crawler = new PlaywrightCrawler({
        maxConcurrency: 1,
        requestHandlerTimeoutSecs: 240,
        navigationTimeoutSecs: 60,
        maxRequestRetries: 2,
        launchContext: {
            launchOptions: { headless: true },
        },
        async requestHandler({ page, request, log }) {
            const job = request.userData.job;
            log.info(`Querying BPOM: ${job.kind}=${job.value || '(all)'}`);

            await waitForTable(page);
            await applyFilter(page, job, requestDelayMs, log);
            await waitForTable(page);

            let pageNumber = 1;
            let queryCount = 0;

            while (pageNumber <= maxPagesPerQuery && queryCount < maxItemsPerQuery) {
                const items = await extractCurrentPage(page, job, {
                    includeDetails,
                    maxRemaining: maxItemsPerQuery - queryCount,
                    requestDelayMs,
                }, log);

                for (const item of items) {
                    queryCount += 1;
                    const key = item.registrationNumber;
                    const existing = collected.get(key);
                    if (!existing) {
                        collected.set(key, item);
                    } else {
                        const matches = Array.isArray(existing.matches) ? existing.matches : [existing.matchedBy].filter(Boolean);
                        matches.push(item.matchedBy);
                        collected.set(key, { ...existing, matches });
                    }
                    if (queryCount >= maxItemsPerQuery) break;
                }

                if (queryCount >= maxItemsPerQuery) break;
                const moved = await clickNext(page, requestDelayMs, log);
                if (!moved) break;
                pageNumber += 1;
            }

            log.info(`Collected ${queryCount} row(s) for ${job.kind}=${job.value || '(all)'}.`);
        },
        async failedRequestHandler({ request, log }, error) {
            const job = request.userData.job;
            failedJobs.push({ job, error: error?.message || String(error) });
            log.error(`Query failed: ${job.kind}=${job.value || '(all)'}`, { error: error?.message });

            if (debug) {
                // Crawlee may already have closed the page here, so only persist metadata.
                const key = `DEBUG_FAILED_${crypto.createHash('md5').update(request.uniqueKey).digest('hex')}`;
                await Actor.setValue(key, { url: request.url, job, error: error?.message || String(error), at: isoNow() });
            }
        },
    });

    const requests = jobs.map((job) => ({
        url: BASE_URL,
        uniqueKey: `${job.kind}:${job.value || 'all'}`,
        userData: { job },
    }));

    await crawler.run(requests);

    const stateStoreName = clean(input.stateStoreName || 'indonesian-cosmetics-intelligence-state');
    const stateKey = clean(input.stateKey || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
    const stateStore = await Actor.openKeyValueStore(stateStoreName);
    const previousState = detectChanges
        ? (await stateStore.getValue(`SNAPSHOT_${stateKey}`) ?? { version: SNAPSHOT_VERSION, records: {} })
        : { version: SNAPSHOT_VERSION, records: {} };

    const previousRecords = previousState.records ?? {};
    const nextRecords = {};
    let newCount = 0;
    let changedCount = 0;
    let unchangedCount = 0;
    let emittedCount = 0;

    for (const record of collected.values()) {
        const id = record.registrationNumber;
        const hash = stableHash(record);
        const previousEntry = previousRecords[id];
        let eventType = 'UNCHANGED';
        let changedFields = [];
        let previous = undefined;

        if (!detectChanges || !previousEntry) {
            eventType = 'NEW';
        } else if (previousEntry.hash !== hash) {
            eventType = 'CHANGED';
            previous = previousEntry.record;
            changedFields = diffFields(previousEntry.record, record);
        }

        if (eventType === 'NEW') newCount += 1;
        else if (eventType === 'CHANGED') changedCount += 1;
        else unchangedCount += 1;

        const output = {
            eventType,
            ...record,
            detectedAt: isoNow(),
            changedFields,
            ...(previous ? { previous } : {}),
        };

        if (shouldEmit(emit, eventType)) {
            await Actor.pushData(output);
            emittedCount += 1;
        }

        nextRecords[id] = { hash, record };
    }

    if (detectChanges && failedJobs.length === 0) {
        await stateStore.setValue(`SNAPSHOT_${stateKey}`, {
            version: SNAPSHOT_VERSION,
            updatedAt: isoNow(),
            records: nextRecords,
        });
    } else if (detectChanges && failedJobs.length > 0) {
        Actor.log.warning('Snapshot was NOT updated because one or more query jobs failed. This prevents false change baselines.');
    }

    const summary = {
        totalUniqueRecords: collected.size,
        emittedRecords: emittedCount,
        newRecords: newCount,
        changedRecords: changedCount,
        unchangedRecords: unchangedCount,
        queryJobs: jobs.length,
        failedJobs,
        snapshotUpdated: detectChanges && failedJobs.length === 0,
        stateStoreName,
        stateKey,
        finishedAt: isoNow(),
    };

    await Actor.setValue('OUTPUT', summary);
    Actor.log.info('Run finished.', summary);
} finally {
    await Actor.exit();
}
