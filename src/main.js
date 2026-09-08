import crypto from 'node:crypto';
import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const BASE_URL = 'https://cekbpom.pom.go.id/produk-kosmetika';
const SNAPSHOT_VERSION = 6;
const ACTOR_VERSION = '0.2.5';
const DAY_MS = 24 * 60 * 60 * 1000;

const LISTING_FIELDS = [
    'registrationNumber',
    'issuedDate',
    'productName',
    'brand',
    'packaging',
    'registrant',
    'registrantLocation',
];

const LISTING_CHANGE_FIELDS = [
    'issuedDate',
    'productName',
    'brand',
    'packaging',
    'registrant',
    'registrantLocation',
];

const DETAIL_FIELDS = [
    'composition',
    'cosmeticsManufacturer',
    'primaryPackagingManufacturer',
    'secondaryPackagingManufacturer',
    'kits',
    'issuedBy',
    'dosageForm',
    'applicationDate',
    'expiryDate',
    'status',
];

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const isoNow = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function textLines(value) {
    return String(value ?? '')
        .split(/\r?\n/)
        .map(clean)
        .filter(Boolean);
}

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripEmbeddedLabels(value, labels) {
    const text = clean(value);
    if (!text) return '';

    const pattern = labels
        .map(escapeRegex)
        .join('|');

    return clean(
        text.replace(
            new RegExp(`\\s+(?:${pattern})\\b.*$`, 'i'),
            '',
        ),
    );
}

function sanitizeRegistrant(value) {
    return stripEmbeddedLabels(
        value,
        [
            'Industri Pengemas Primer',
            'Industri Pengemas Sekunder',
            'Industri Kosmetika',
            'Kits',
            'Diterbitkan Oleh',
        ],
    );
}

function sanitizeCosmeticsManufacturer(value) {
    return stripEmbeddedLabels(
        value,
        [
            'Industri Pengemas Primer',
            'Industri Pengemas Sekunder',
            'Kits',
            'Diterbitkan Oleh',
        ],
    );
}

function canonicalizeLegacyRecord(record = {}) {
    return {
        ...record,
        registrant: sanitizeRegistrant(record.registrant),
        cosmeticsManufacturer: sanitizeCosmeticsManufacturer(
            record.cosmeticsManufacturer,
        ),
    };
}

function parseRegistrationCell(value) {
    const text = clean(value);

    return {
        registrationNumber:
            text.match(/\b[A-Z]{2,3}\d{8,}\b/i)?.[0] || '',
        issuedDate:
            text.match(/Terbit\s*:\s*(\d{4}-\d{2}-\d{2})/i)?.[1] || '',
    };
}

function parseProductCell(value) {
    const lines = textLines(value);
    let brand = '';
    let packaging = '';
    const productNameLines = [];

    for (const line of lines) {
        if (/^Merk\s*:/i.test(line)) {
            brand = clean(line.replace(/^Merk\s*:/i, ''));
        } else if (/^Merek\s*:/i.test(line)) {
            brand = clean(line.replace(/^Merek\s*:/i, ''));
        } else if (/^Kemasan\s*:/i.test(line)) {
            packaging = clean(line.replace(/^Kemasan\s*:/i, ''));
        } else {
            productNameLines.push(line);
        }
    }

    const fullText = clean(value);

    if (!brand) {
        brand =
            fullText.match(/Merk\s*:\s*(.*?)(?=Kemasan\s*:|$)/i)?.[1]?.trim()
            || '';
    }

    if (!packaging) {
        packaging =
            fullText.match(/Kemasan\s*:\s*(.*)$/i)?.[1]?.trim()
            || '';
    }

    return {
        productName: clean(
            productNameLines
                .join(' ')
                .replace(/Merk\s*:.*$/i, '')
                .replace(/Merek\s*:.*$/i, ''),
        ),
        brand: clean(brand),
        packaging: clean(packaging),
    };
}

function parseRegistrantCell(value) {
    const lines = textLines(value);

    if (lines.length >= 2) {
        return {
            registrant: sanitizeRegistrant(lines[0]),
            registrantLocation: clean(lines.slice(1).join(' ')),
        };
    }

    return {
        registrant: sanitizeRegistrant(value),
        registrantLocation: '',
    };
}

function hashFields(record, fields) {
    const payload = Object.fromEntries(
        fields.map((key) => [key, clean(record?.[key])]),
    );

    return crypto
        .createHash('sha256')
        .update(JSON.stringify(payload))
        .digest('hex');
}

function stableHash(record) {
    return hashFields(record, [...LISTING_FIELDS, ...DETAIL_FIELDS]);
}

function basicHash(record) {
    return hashFields(record, LISTING_FIELDS);
}

function detailHash(record) {
    return hashFields(record, DETAIL_FIELDS);
}

function inferDetailKnown(record = {}) {
    return DETAIL_FIELDS.some((field) => clean(record[field]) !== '');
}

function previousKnownDetailFields(previousEntry) {
    if (!previousEntry) return new Set();

    if (Array.isArray(previousEntry.detailKnownFields)) {
        return new Set(
            previousEntry.detailKnownFields
                .filter((field) => DETAIL_FIELDS.includes(field)),
        );
    }

    const record = canonicalizeLegacyRecord(
        previousEntry.record ?? {},
    );

    return new Set(
        DETAIL_FIELDS.filter((field) => clean(record[field]) !== ''),
    );
}

function previousDetailKnown(previousEntry) {
    if (!previousEntry) return false;

    if (typeof previousEntry.detailKnown === 'boolean') {
        return previousEntry.detailKnown;
    }

    return previousKnownDetailFields(previousEntry).size > 0
        || inferDetailKnown(
            canonicalizeLegacyRecord(previousEntry.record ?? {}),
        );
}

function normalizeKey(label) {
    return clean(label)
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function mapDetails(raw = {}) {
    const normalized = Object.fromEntries(
        Object.entries(raw).map(([key, value]) => [
            normalizeKey(key),
            clean(value),
        ]),
    );

    const pick = (...candidates) => {
        for (const candidate of candidates) {
            const target = normalizeKey(candidate);

            if (normalized[target]) {
                return normalized[target];
            }

            const fuzzy = Object.entries(normalized).find(
                ([key]) => key.includes(target) || target.includes(key),
            );

            if (fuzzy?.[1]) return fuzzy[1];
        }

        return '';
    };

    return {
        registrationNumber: pick(
            'nomor registrasi',
            'nomor izin edar',
            'nie',
        ),
        productName: pick('nama produk'),
        brand: pick('merk', 'merek'),
        packaging: pick('kemasan'),
        dosageForm: pick('bentuk sediaan'),
        composition: pick('komposisi'),
        applicationDate: pick('tanggal permohonan'),
        issuedDate: pick('tanggal terbit'),
        expiryDate: pick('tanggal expired', 'tanggal kedaluwarsa'),
        registrant: pick('nama pendaftar', 'pendaftar'),

        cosmeticsManufacturer: sanitizeCosmeticsManufacturer(
            pick('industri kosmetika'),
        ),

        primaryPackagingManufacturer:
            pick('industri pengemas primer'),

        secondaryPackagingManufacturer:
            pick('industri pengemas sekunder'),

        kits: pick('kits'),
        issuedBy: pick('diterbitkan oleh'),
        status: pick('status'),
    };
}

function buildJobs(input) {
    const jobs = [];

    const add = (kind, values = []) => {
        for (const raw of values || []) {
            const value = clean(raw);

            if (value) {
                jobs.push({
                    kind,
                    value,
                });
            }
        }
    };

    add('brand', input.brands);
    add('registrant', input.registrants);
    add('productName', input.productNames);
    add('registrationNumber', input.registrationNumbers);
    add('composition', input.compositions);

    if (!jobs.length) {
        throw new Error(
            'At least one monitoring criterion is required: brand, registrant, product name, registration number, or composition keyword.',
        );
    }

    return jobs;
}

function buildWatchSignature(jobs) {
    const normalized = jobs
        .map((job) => ({
            kind: job.kind,
            value: clean(job.value).toLowerCase(),
        }))
        .sort(
            (a, b) =>
                `${a.kind}:${a.value}`
                    .localeCompare(
                        `${b.kind}:${b.value}`,
                    ),
        );

    return crypto
        .createHash('sha256')
        .update(JSON.stringify(normalized))
        .digest('hex');
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

function issuedAgeDays(
    issuedDate,
    referenceIso,
) {
    const value = clean(issuedDate);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return null;
    }

    const issuedMs =
        Date.parse(
            `${value}T00:00:00Z`,
        );

    const referenceMs =
        Date.parse(referenceIso);

    if (
        !Number.isFinite(issuedMs)
        || !Number.isFinite(referenceMs)
    ) {
        return null;
    }

    return Math.floor(
        (referenceMs - issuedMs)
        / DAY_MS,
    );
}

function isoDateOnly(value) {
    return clean(value)
        .match(
            /^(\d{4}-\d{2}-\d{2})/,
        )?.[1]
        || '';
}

function compareDateOnly(
    left,
    right,
) {
    const a = isoDateOnly(left);
    const b = isoDateOnly(right);

    if (!a || !b) {
        return null;
    }

    if (a === b) {
        return 0;
    }

    return a < b
        ? -1
        : 1;
}

function earliestFirstSeenAt(
    records = {},
) {
    const values =
        Object.values(records)
            .map(
                (entry) =>
                    clean(
                        entry?.firstSeenAt
                        || entry?.record?.scrapedAt,
                    ),
            )
            .filter(
                (value) =>
                    Number.isFinite(
                        Date.parse(value),
                    ),
            )
            .sort(
                (a, b) =>
                    Date.parse(a)
                    - Date.parse(b),
            );

    return values[0] || '';
}

function previousObservationCount(
    previousEntry,
) {
    if (!previousEntry) {
        return 0;
    }

    const value =
        Number(
            previousEntry.observationCount,
        );

    return (
        Number.isFinite(value)
        && value >= 0
    )
        ? value
        : 1;
}

function previousConsecutiveMisses(
    previousEntry,
) {
    const value =
        Number(
            previousEntry?.consecutiveMisses,
        );

    return (
        Number.isFinite(value)
        && value >= 0
    )
        ? value
        : 0;
}

function diffFields(
    previous,
    current,
    fields,
) {
    return fields.filter(
        (key) =>
            clean(previous?.[key])
            !== clean(current?.[key]),
    );
}

function diffListingFields(
    previous,
    current,
) {
    return diffFields(
        previous,
        current,
        LISTING_CHANGE_FIELDS,
    );
}

function diffKnownDetailFields(
    previous,
    current,
    previousKnownFields,
    currentKnownFields,
) {
    return DETAIL_FIELDS.filter(
        (key) =>
            previousKnownFields.has(key)
            && currentKnownFields.has(key)
            && clean(previous?.[key])
                !== clean(current?.[key]),
    );
}

function calculateEnrichedFields(
    previous,
    current,
    previousKnownFields,
    currentKnownFields,
) {
    return DETAIL_FIELDS.filter(
        (key) =>
            !previousKnownFields.has(key)
            && currentKnownFields.has(key)
            && Boolean(
                clean(current?.[key]),
            ),
    );
}

function shouldEmit(
    mode,
    eventType,
) {
    if (mode === 'new') {
        return eventType === 'NEW';
    }

    if (mode === 'changes') {
        return (
            eventType === 'NEW'
            || eventType === 'CHANGED'
        );
    }

    return true;
}

async function visibleLocator(
    locator,
) {
    const count =
        await locator.count();

    for (
        let i = count - 1;
        i >= 0;
        i--
    ) {
        const item =
            locator.nth(i);

        if (
            await item
                .isVisible()
                .catch(
                    () => false,
                )
        ) {
            return item;
        }
    }

    return null;
}

async function getProductTable(
    page,
) {
    const tables =
        page
            .locator('table')
            .filter({
                hasText:
                    /Nomor Registrasi/i,
            })
            .filter({
                hasText:
                    /Nama Produk/i,
            });

    let fallback = null;

    const count =
        await tables.count();

    for (
        let i = 0;
        i < count;
        i++
    ) {
        const table =
            tables.nth(i);

        if (
            !await table
                .isVisible()
                .catch(
                    () => false,
                )
        ) {
            continue;
        }

        if (!fallback) {
            fallback = table;
        }

        if (
            await table
                .locator('tbody tr')
                .count()
            > 0
        ) {
            return table;
        }
    }

    if (fallback) {
        return fallback;
    }

    throw new Error(
        'BPOM product result table was not found.',
    );
}

async function waitForTable(
    page,
) {
    await page.waitForSelector(
        'table',
        {
            timeout:
                30000,
        },
    );

    await page.waitForFunction(
        () =>
            [
                ...document
                    .querySelectorAll(
                        'table',
                    ),
            ].some(
                (table) => {
                    const headers =
                        (
                            table
                                .querySelector(
                                    'thead',
                                )
                                ?.textContent
                            || ''
                        )
                            .replace(
                                /\s+/g,
                                ' ',
                            )
                            .trim();

                    if (
                        !/Nomor Registrasi/i
                            .test(headers)
                        || !/Nama Produk/i
                            .test(headers)
                    ) {
                        return false;
                    }

                    const rows =
                        table
                            .querySelectorAll(
                                'tbody tr',
                            );

                    if (
                        rows.length > 0
                    ) {
                        return true;
                    }

                    const body =
                        (
                            table
                                .querySelector(
                                    'tbody',
                                )
                                ?.textContent
                            || ''
                        )
                            .replace(
                                /\s+/g,
                                ' ',
                            )
                            .trim();

                    return (
                        /tidak ada data|no data|data kosong/i
                            .test(body)
                    );
                },
            ),
        {
            timeout:
                30000,
        },
    ).catch(
        () => undefined,
    );
}

async function applyFilter(
    page,
    job,
    delay,
    crawlerLog,
) {
    const open =
        await visibleLocator(
            page.getByRole(
                'button',
                {
                    name:
                        /^Filter$/i,
                },
            ),
        );

    if (!open) {
        throw new Error(
            'BPOM Filter button was not found.',
        );
    }

    await open.click();

    await sleep(delay);

    const placeholder =
        inputPlaceholderFor(
            job.kind,
        );

    const field =
        placeholder
            ? await visibleLocator(
                page.locator(
                    `input[placeholder="${placeholder}"]`,
                ),
            )
            : null;

    if (!field) {
        throw new Error(
            `BPOM filter field was not found: ${placeholder || job.kind}`,
        );
    }

    await field.fill(job.value);

    const apply =
        await visibleLocator(
            page.getByRole(
                'button',
                {
                    name:
                        /^Filter$/i,
                },
            ),
        );

    if (!apply) {
        throw new Error(
            'BPOM apply Filter button was not found.',
        );
    }

    await apply.click();

    await sleep(
        Math.max(
            300,
            delay,
        ),
    );

    await page.waitForFunction(
        () =>
            [
                ...document
                    .querySelectorAll(
                        'table',
                    ),
            ].some(
                (table) => {
                    const headers =
                        (
                            table
                                .querySelector(
                                    'thead',
                                )
                                ?.textContent
                            || ''
                        )
                            .replace(
                                /\s+/g,
                                ' ',
                            )
                            .trim();

                    return (
                        /Nomor Registrasi/i
                            .test(headers)
                        && /Nama Produk/i
                            .test(headers)
                        && table
                            .querySelectorAll(
                                'tbody tr',
                            )
                            .length
                            > 0
                    );
                },
            ),
        {
            timeout:
                20000,
        },
    ).catch(
        () =>
            crawlerLog.debug(
                'Filtered table did not signal readiness; continuing.',
            ),
    );
}

async function extractDetailPairs(
    dialog,
) {
    return dialog.evaluate(
        (root) => {
            const result = {};

            const cleanText =
                (value) =>
                    String(
                        value ?? '',
                    )
                        .replace(
                            /\u00a0/g,
                            ' ',
                        )
                        .replace(
                            /[ \t]+/g,
                            ' ',
                        )
                        .trim();

            const normalize =
                (value) =>
                    cleanText(value)
                        .replace(
                            /:$/,
                            '',
                        )
                        .toLowerCase();

            const labels = [
                'Nomor Registrasi',
                'Nomor Izin Edar',
                'NIE',
                'Nama Produk',
                'Merk',
                'Merek',
                'Kemasan',
                'Bentuk Sediaan',
                'Komposisi',
                'Tanggal Permohonan',
                'Tanggal Terbit',
                'Tanggal Expired',
                'Tanggal Kedaluwarsa',
                'Nama Pendaftar',
                'Pendaftar',
                'Industri Kosmetika',
                'Industri Pengemas Primer',
                'Industri Pengemas Sekunder',
                'Kits',
                'Diterbitkan Oleh',
                'Status',
            ];

            const known =
                new Map(
                    labels.map(
                        (label) => [
                            normalize(label),
                            label,
                        ],
                    ),
                );

            const put =
                (
                    key,
                    value,
                ) => {
                    const normalizedKey =
                        cleanText(key)
                            .replace(
                                /:$/,
                                '',
                            );

                    const normalizedValue =
                        cleanText(value);

                    if (
                        normalizedKey
                        && normalizedValue
                        && normalizedKey
                            !== normalizedValue
                        && !result[
                            normalizedKey
                        ]
                    ) {
                        result[
                            normalizedKey
                        ] =
                            normalizedValue;
                    }
                };

            root
                .querySelectorAll(
                    'tr',
                )
                .forEach(
                    (tr) => {
                        const cells =
                            [
                                ...tr
                                    .querySelectorAll(
                                        ':scope > th, :scope > td',
                                    ),
                            ]
                                .map(
                                    (el) =>
                                        cleanText(
                                            el.innerText
                                            || el.textContent,
                                        ),
                                )
                                .filter(Boolean);

                        if (
                            cells.length >= 2
                        ) {
                            put(
                                cells[0],
                                cells
                                    .slice(1)
                                    .join(' '),
                            );
                        }
                    },
                );

            const lines =
                (
                    root.innerText
                    || root.textContent
                    || ''
                )
                    .split(/\r?\n/)
                    .map(cleanText)
                    .filter(Boolean)
                    .filter(
                        (line) =>
                            !/^Detail Produk$/i
                                .test(line)
                            && !/^Close$/i
                                .test(line)
                            && line !== '×',
                    );

            for (
                let i = 0;
                i < lines.length;
                i++
            ) {
                const line =
                    lines[i];

                const colon =
                    line.match(
                        /^([^:]{2,50})\s*:\s*(.+)$/,
                    );

                if (
                    colon
                    && known.has(
                        normalize(
                            colon[1],
                        ),
                    )
                ) {
                    put(
                        known.get(
                            normalize(
                                colon[1],
                            ),
                        ),
                        colon[2],
                    );

                    continue;
                }

                const label =
                    known.get(
                        normalize(line),
                    );

                if (!label) {
                    continue;
                }

                const values = [];

                for (
                    let j = i + 1;
                    j < lines.length;
                    j++
                ) {
                    const candidate =
                        lines[j];

                    if (
                        known.has(
                            normalize(candidate),
                        )
                    ) {
                        break;
                    }

                    const nextColon =
                        candidate.match(
                            /^([^:]{2,50})\s*:/,
                        );

                    if (
                        nextColon
                        && known.has(
                            normalize(
                                nextColon[1],
                            ),
                        )
                    ) {
                        break;
                    }

                    values.push(
                        candidate,
                    );
                }

                if (
                    values.length
                ) {
                    put(
                        label,
                        values.join(' '),
                    );
                }
            }

            return result;
        },
    );
}

async function getVisibleDialog(
    page,
) {
    const candidates =
        page.locator(
            '.modal:visible, [role="dialog"]:visible',
        );

    const count =
        await candidates.count();

    for (
        let i = count - 1;
        i >= 0;
        i--
    ) {
        const dialog =
            candidates.nth(i);

        const text =
            clean(
                await dialog
                    .innerText()
                    .catch(
                        () => '',
                    ),
            );

        if (
            /detail produk/i
                .test(text)
            || text.length > 20
        ) {
            return dialog;
        }
    }

    return null;
}

async function enrichFromRow(
    page,
    row,
    delay,
    crawlerLog,
) {
    try {
        const clickable =
            row.locator(
                'a, button, [role="button"]',
            );

        const count =
            await clickable.count();

        crawlerLog.debug(
            'Opening BPOM product detail.',
            {
                clickableCount:
                    count,
            },
        );

        if (
            count > 0
        ) {
            await clickable
                .first()
                .click();
        } else {
            await row.click();
        }

        await page.waitForTimeout(
            Math.max(
                800,
                delay,
            ),
        );

        const dialog =
            await getVisibleDialog(
                page,
            );

        if (!dialog) {
            return {
                __detailFetched:
                    false,
            };
        }

        const dialogText =
            clean(
                await dialog
                    .innerText()
                    .catch(
                        () => '',
                    ),
            );

        crawlerLog.debug(
            'BPOM product detail dialog detected.',
            {
                textPreview:
                    dialogText
                        .slice(
                            0,
                            2000,
                        ),
            },
        );

        const rawPairs =
            await extractDetailPairs(
                dialog,
            );

        const details =
            mapDetails(
                rawPairs,
            );

        crawlerLog.debug(
            'BPOM product detail raw fields.',
            {
                rawPairs,
            },
        );

        crawlerLog.debug(
            'BPOM mapped product details.',
            {
                details,
            },
        );

        const close =
            await visibleLocator(
                dialog.getByRole(
                    'button',
                    {
                        name:
                            /^(Close|Tutup)$/i,
                    },
                ),
            );

        if (
            close
        ) {
            await close
                .click()
                .catch(
                    () => undefined,
                );
        } else {
            await page.keyboard
                .press(
                    'Escape',
                )
                .catch(
                    () => undefined,
                );
        }

        await page.waitForTimeout(
            300,
        );

        return {
            ...details,

            __detailFetched:
                true,
        };
    } catch (
        error
    ) {
        crawlerLog.warning(
            'Could not open/parse BPOM product detail.',
            {
                error:
                    error?.message
                    || String(error),
            },
        );

        await page.keyboard
            .press(
                'Escape',
            )
            .catch(
                () => undefined,
            );

        return {
            __detailFetched:
                false,
        };
    }
}

async function extractCurrentPage(
    page,
    job,
    {
        detailStrategy,
        detectChanges,
        previousRecords,
        maxRemaining,
        requestDelayMs,
        detailStats,
        detailDecisionRegistrationNumbers,
    },
    crawlerLog,
) {
    const table =
        await getProductTable(page);

    const rows =
        table.locator(
            'tbody tr',
        );

    const results = [];

    const rowCount =
        await rows.count();

    for (
        let i = 0;
        i < rowCount
            && results.length
                < maxRemaining;
        i++
    ) {
        const row =
            rows.nth(i);

        const cells =
            await row
                .locator('td')
                .allInnerTexts();

        if (
            cells.length < 3
        ) {
            continue;
        }

        if (
            /tidak ada data|no data|data tidak/i
                .test(
                    cells
                        .map(clean)
                        .join(' '),
                )
        ) {
            continue;
        }

        const registration =
            parseRegistrationCell(
                cells[1]
                || '',
            );

        const product =
            parseProductCell(
                cells[2]
                || '',
            );

        const registrant =
            parseRegistrantCell(
                cells[3]
                || '',
            );

        const list = {
            productType:
                clean(
                    cells[0],
                )
                || 'KO',

            registrationNumber:
                registration
                    .registrationNumber,

            issuedDate:
                registration
                    .issuedDate,

            productName:
                product
                    .productName,

            brand:
                product.brand,

            packaging:
                product.packaging,

            registrant:
                registrant
                    .registrant,

            registrantLocation:
                registrant
                    .registrantLocation,
        };

        if (
            !list
                .registrationNumber
        ) {
            continue;
        }

        const previousEntry =
            previousRecords[
                list
                    .registrationNumber
            ];

        const previousRecord =
            previousEntry?.record
                ? canonicalizeLegacyRecord(
                    previousEntry.record,
                )
                : null;

        const currentBasicHash =
            basicHash(list);

        const previousBasicHash =
            previousRecord
                ? basicHash(
                    previousRecord,
                )
                : '';

        const listingChanged =
            previousRecord
                ? previousBasicHash
                    !== currentBasicHash
                : true;

        let shouldFetchDetail =
            false;

        if (
            !detailDecisionRegistrationNumbers
                .has(
                    list
                        .registrationNumber,
                )
        ) {
            if (
                detailStrategy
                    === 'always'
            ) {
                shouldFetchDetail =
                    true;
            } else if (
                detailStrategy
                    === 'changesOnly'
                && detectChanges
                && (
                    !previousRecord
                    || listingChanged
                )
            ) {
                shouldFetchDetail =
                    true;
            }

            detailDecisionRegistrationNumbers
                .add(
                    list
                        .registrationNumber,
                );

            if (
                shouldFetchDetail
            ) {
                detailStats
                    .requested++;
            } else {
                detailStats
                    .skipped++;
            }
        }

        const detail =
            shouldFetchDetail
                ? await enrichFromRow(
                    page,
                    row,
                    requestDelayMs,
                    crawlerLog,
                )
                : {
                    __detailFetched:
                        false,
                };

        const priorDetailKnown =
            previousDetailKnown(
                previousEntry,
            );

        const currentKnownDetailFields =
            previousKnownDetailFields(
                previousEntry,
            );

        const detailValues = {};

        for (
            const field
            of DETAIL_FIELDS
        ) {
            const previousValue =
                clean(
                    previousRecord?.[field],
                );

            const currentValue =
                clean(
                    detail[field],
                );

            detailValues[field] =
                currentValue
                || previousValue;

            if (
                detail.__detailFetched
                    === true
                && currentValue
            ) {
                currentKnownDetailFields
                    .add(field);
            }
        }

        const currentDetailKnown =
            Boolean(
                priorDetailKnown
                || detail
                    .__detailFetched
                    === true
                || currentKnownDetailFields
                    .size
                    > 0,
            );

        /*
         * Listing fields are canonical.
         * Modal detail hanya untuk enrichment.
         * Modal tidak boleh overwrite:
         * - productName
         * - brand
         * - issuedDate
         * - packaging
         * - registrant
         * - registrantLocation
         */
        const record = {
            ...list,

            ...detailValues,

            category:
                'Kosmetika',

            source:
                'BPOM RI - Cek Produk',

            sourceUrl:
                BASE_URL,

            matchedBy: {
                type:
                    job.kind,

                value:
                    job.value,
            },

            scrapedAt:
                isoNow(),

            __basicHash:
                currentBasicHash,

            __detailHash:
                detailHash(
                    detailValues,
                ),

            __detailKnown:
                currentDetailKnown,

            __detailKnownFields:
                [
                    ...currentKnownDetailFields,
                ],

            __detailFetched:
                detail
                    .__detailFetched
                === true,
        };

        results.push(record);
    }

    return results;
}

async function clickNext(
    page,
    delay,
) {
    const next =
        await visibleLocator(
            page.getByRole(
                'button',
                {
                    name:
                        /Selanjutnya/i,
                },
            ),
        );

    if (!next) {
        return false;
    }

    const disabled =
        await next
            .isDisabled()
            .catch(
                () => false,
            )
        || await next
            .getAttribute(
                'disabled',
            ) !== null
        || await next
            .getAttribute(
                'aria-disabled',
            ) === 'true';

    if (disabled) {
        return false;
    }

    const table =
        await getProductTable(
            page,
        )
            .catch(
                () => null,
            );

    const before =
        table
            ? clean(
                await table
                    .locator(
                        'tbody tr',
                    )
                    .first()
                    .innerText()
                    .catch(
                        () => '',
                    ),
            )
            : '';

    await next.click();

    await sleep(
        Math.max(
            300,
            delay,
        ),
    );

    return page
        .waitForFunction(
            (previous) =>
                [
                    ...document
                        .querySelectorAll(
                            'table',
                        ),
                ].some(
                    (
                        tableElement,
                    ) => {
                        const headers =
                            (
                                tableElement
                                    .querySelector(
                                        'thead',
                                    )
                                    ?.textContent
                                || ''
                            )
                                .replace(
                                    /\s+/g,
                                    ' ',
                                )
                                .trim();

                        if (
                            !/Nomor Registrasi/i
                                .test(headers)
                            || !/Nama Produk/i
                                .test(headers)
                        ) {
                            return false;
                        }

                        const current =
                            (
                                tableElement
                                    .querySelector(
                                        'tbody tr',
                                    )
                                    ?.textContent
                                || ''
                            )
                                .replace(
                                    /\s+/g,
                                    ' ',
                                )
                                .trim();

                        return (
                            Boolean(current)
                            && current
                                !== previous
                        );
                    },
                ),
            before,
            {
                timeout:
                    15000,
            },
        )
        .then(
            () => true,
        )
        .catch(
            () => false,
        );
}

await Actor.main(
    async () => {
        const runStartedAt =
            isoNow();

        const input =
            await Actor.getInput()
            ?? {};

        const jobs =
            buildJobs(input);

        const watchSignature =
            buildWatchSignature(
                jobs,
            );

        const maxItemsPerQuery =
            Number(
                input
                    .maxItemsPerQuery
                ?? 0,
            );

        const maxPagesPerQuery =
            Number(
                input
                    .maxPagesPerQuery
                ?? 100,
            );

        const baselineWarmupRuns =
            Number(
                input
                    .baselineWarmupRuns
                ?? 3,
            );

        const newProductWindowDays =
            Number(
                input
                    .newProductWindowDays
                ?? 30,
            );

        const requestDelayMs =
            Number(
                input
                    .requestDelayMs
                ?? 800,
            );

        if (
            !Number.isInteger(
                baselineWarmupRuns,
            )
            || baselineWarmupRuns
                < 1
        ) {
            throw new Error(
                'baselineWarmupRuns must be an integer >= 1.',
            );
        }

        if (
            !Number.isInteger(
                newProductWindowDays,
            )
            || newProductWindowDays
                < 1
        ) {
            throw new Error(
                'newProductWindowDays must be an integer >= 1.',
            );
        }

        const detailStrategy =
            clean(
                input
                    .detailStrategy
                || 'changesOnly',
            );

        const allowedDetailStrategies =
            new Set([
                'always',
                'changesOnly',
                'never',
            ]);

        if (
            !allowedDetailStrategies
                .has(
                    detailStrategy,
                )
        ) {
            throw new Error(
                `Invalid detailStrategy: ${detailStrategy}`,
            );
        }

        const detectChanges =
            input
                .detectChanges
            !== false;

        const emit =
            input.emit
            ?? 'changes';

        const allowPartialSnapshotUpdate =
            Boolean(
                input
                    .allowPartialSnapshotUpdate,
            );

        const debug =
            Boolean(
                input.debug,
            );

        const itemLimit =
            maxItemsPerQuery > 0
                ? maxItemsPerQuery
                : Infinity;

        if (debug) {
            log.setLevel(
                log.LEVELS.DEBUG,
            );
        }

        const stateStoreName =
            clean(
                input
                    .stateStoreName
                || 'indonesian-cosmetics-intelligence-state',
            );

        const stateKey =
            clean(
                input
                    .stateKey
                || 'default',
            )
                .replace(
                    /[^a-zA-Z0-9._-]/g,
                    '_',
                );

        const stateStore =
            await Actor
                .openKeyValueStore(
                    stateStoreName,
                );

        const rawPreviousState =
            detectChanges
                ? await stateStore
                    .getValue(
                        `SNAPSHOT_${stateKey}`,
                    )
                : null;

        const watchlistMatchesPreviousState =
            Boolean(
                detectChanges
                && rawPreviousState
                    ?.watchSignature
                && rawPreviousState
                    .watchSignature
                    === watchSignature,
            );

        const previousRecordsForDetail =
            watchlistMatchesPreviousState
                ? rawPreviousState
                    .records
                    ?? {}
                : {};

        log.info(
            'Actor input loaded.',
            {
                version:
                    ACTOR_VERSION,

                jobs:
                    jobs.length,

                detailStrategy,

                detectChanges,

                emit,

                maxItemsPerQuery,

                maxPagesPerQuery,

                baselineWarmupRuns,

                newProductWindowDays,

                allowPartialSnapshotUpdate,

                debug,
            },
        );

        const collected =
            new Map();

        const failedJobs =
            [];

        const querySummaries =
            new Map();

        const detailStats = {
            requested:
                0,

            skipped:
                0,
        };

        const detailDecisionRegistrationNumbers =
            new Set();

        const crawler =
            new PlaywrightCrawler({
                maxConcurrency:
                    1,

                requestHandlerTimeoutSecs:
                    1800,

                navigationTimeoutSecs:
                    90,

                maxRequestRetries:
                    5,

                launchContext: {
                    launchOptions: {
                        headless:
                            true,
                    },
                },

                preNavigationHooks: [
                    async (
                        {
                            page,
                            request,
                            log:
                                crawlerLog,
                        },
                        gotoOptions,
                    ) => {
                        const retry =
                            request
                                .retryCount
                            ?? 0;

                        if (
                            retry > 0
                        ) {
                            const delayMs =
                                Math.min(
                                    15000,
                                    2000
                                        * (
                                            2
                                            ** (
                                                retry
                                                - 1
                                            )
                                        ),
                                );

                            crawlerLog.warning(
                                `Retrying BPOM after ${delayMs} ms backoff.`,
                                {
                                    retryCount:
                                        retry,
                                },
                            );

                            await page
                                .waitForTimeout(
                                    delayMs,
                                );
                        }

                        await page
                            .setExtraHTTPHeaders({
                                'Accept-Language':
                                    'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',

                                Accept:
                                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',

                                'Upgrade-Insecure-Requests':
                                    '1',
                            });

                        gotoOptions
                            .waitUntil =
                            'domcontentloaded';

                        gotoOptions
                            .timeout =
                            90000;
                    },
                ],

                async requestHandler({
                    page,
                    request,
                    log:
                        crawlerLog,
                }) {
                    const job =
                        request
                            .userData
                            .job;

                    crawlerLog.info(
                        `Querying BPOM: ${job.kind}=${job.value}`,
                    );

                    await waitForTable(
                        page,
                    );

                    await applyFilter(
                        page,
                        job,
                        requestDelayMs,
                        crawlerLog,
                    );

                    await waitForTable(
                        page,
                    );

                    let pageNumber =
                        1;

                    let queryCount =
                        0;

                    let duplicateRows =
                        0;

                    let stopReason =
                        'unknown';

                    let coverageComplete =
                        false;

                    const seenRegistrationNumbers =
                        new Set();

                    const duplicateRegistrationNumbers =
                        new Set();

                    while (
                        pageNumber
                            <= maxPagesPerQuery
                        && queryCount
                            < itemLimit
                    ) {
                        const maxRemaining =
                            Number
                                .isFinite(
                                    itemLimit,
                                )
                                ? itemLimit
                                    - queryCount
                                : Number
                                    .MAX_SAFE_INTEGER;

                        const items =
                            await extractCurrentPage(
                                page,
                                job,
                                {
                                    detailStrategy,

                                    detectChanges,

                                    previousRecords:
                                        previousRecordsForDetail,

                                    maxRemaining,

                                    requestDelayMs,

                                    detailStats,

                                    detailDecisionRegistrationNumbers,
                                },
                                crawlerLog,
                            );

                        for (
                            const item
                            of items
                        ) {
                            queryCount++;

                            const key =
                                item
                                    .registrationNumber;

                            if (
                                seenRegistrationNumbers
                                    .has(key)
                            ) {
                                duplicateRows++;

                                duplicateRegistrationNumbers
                                    .add(key);
                            } else {
                                seenRegistrationNumbers
                                    .add(key);
                            }

                            const existing =
                                collected
                                    .get(key);

                            if (!existing) {
                                collected
                                    .set(
                                        key,
                                        item,
                                    );
                            } else {
                                const matches =
                                    Array
                                        .isArray(
                                            existing
                                                .matches,
                                        )
                                        ? existing
                                            .matches
                                        : [
                                            existing
                                                .matchedBy,
                                        ].filter(
                                            Boolean,
                                        );

                                if (
                                    !matches.some(
                                        (match) =>
                                            match.type
                                                === item
                                                    .matchedBy
                                                    .type
                                            && match.value
                                                === item
                                                    .matchedBy
                                                    .value,
                                    )
                                ) {
                                    matches.push(
                                        item
                                            .matchedBy,
                                    );
                                }

                                collected
                                    .set(
                                        key,
                                        {
                                            ...existing,

                                            matches,
                                        },
                                    );
                            }

                            if (
                                queryCount
                                    >= itemLimit
                            ) {
                                break;
                            }
                        }

                        if (
                            queryCount
                                >= itemLimit
                        ) {
                            stopReason =
                                'item_limit';

                            break;
                        }

                        if (
                            pageNumber
                                >= maxPagesPerQuery
                        ) {
                            stopReason =
                                'page_limit';

                            break;
                        }

                        const moved =
                            await clickNext(
                                page,
                                requestDelayMs,
                            );

                        if (!moved) {
                            coverageComplete =
                                true;

                            stopReason =
                                'end_of_results';

                            break;
                        }

                        pageNumber++;
                    }

                    const querySummary = {
                        queryId:
                            request
                                .uniqueKey,

                        kind:
                            job.kind,

                        value:
                            job.value,

                        rawRowsCollected:
                            queryCount,

                        uniqueProducts:
                            seenRegistrationNumbers
                                .size,

                        duplicateRows,

                        duplicateRegistrationNumberCount:
                            duplicateRegistrationNumbers
                                .size,

                        duplicateRegistrationNumbers:
                            [
                                ...duplicateRegistrationNumbers,
                            ].slice(
                                0,
                                100,
                            ),

                        pagesVisited:
                            pageNumber,

                        coverageComplete,

                        stopReason,
                    };

                    querySummaries
                        .set(
                            request
                                .uniqueKey,
                            querySummary,
                        );

                    crawlerLog.info(
                        `Collected ${queryCount} raw row(s) / ${seenRegistrationNumbers.size} unique product(s) for ${job.kind}=${job.value}.`,
                        querySummary,
                    );
                },

                async failedRequestHandler(
                    {
                        request,
                        log:
                            crawlerLog,
                    },
                    error,
                ) {
                    const job =
                        request
                            .userData
                            .job;

                    failedJobs.push({
                        job,

                        error:
                            error?.message
                            || String(error),
                    });

                    querySummaries.set(
                        request
                            .uniqueKey,
                        {
                            queryId:
                                request
                                    .uniqueKey,

                            kind:
                                job.kind,

                            value:
                                job.value,

                            rawRowsCollected:
                                0,

                            uniqueProducts:
                                0,

                            duplicateRows:
                                0,

                            duplicateRegistrationNumberCount:
                                0,

                            duplicateRegistrationNumbers:
                                [],

                            pagesVisited:
                                0,

                            coverageComplete:
                                false,

                            stopReason:
                                'request_failed',
                        },
                    );

                    crawlerLog.error(
                        `Query failed: ${job.kind}=${job.value}`,
                        {
                            error:
                                error
                                    ?.message,
                        },
                    );
                },
            });

        await crawler.run(
            jobs.map(
                (job) => ({
                    url:
                        BASE_URL,

                    uniqueKey:
                        `${job.kind}:${job.value}`,

                    userData: {
                        job,
                    },
                }),
            ),
        );

        const querySummaryList =
            jobs.map(
                (job) =>
                    querySummaries
                        .get(
                            `${job.kind}:${job.value}`,
                        ),
            );

        const overallCoverageComplete =
            failedJobs.length === 0
            && querySummaryList
                .every(
                    (query) =>
                        query
                            ?.coverageComplete
                        === true,
                );

        let baselineReset =
            false;

        let baselineResetReason =
            '';

        let previousState =
            rawPreviousState
            ?? {
                version:
                    SNAPSHOT_VERSION,

                watchSignature,

                successfulRuns:
                    0,

                baselineReady:
                    false,

                records:
                    {},
            };

        if (
            detectChanges
            && rawPreviousState
                ?.watchSignature
            && rawPreviousState
                .watchSignature
                !== watchSignature
        ) {
            baselineReset =
                true;

            baselineResetReason =
                'WATCHLIST_CHANGED';

            previousState = {
                version:
                    SNAPSHOT_VERSION,

                watchSignature,

                successfulRuns:
                    0,

                baselineReady:
                    false,

                records:
                    {},
            };

            log.warning(
                'Watchlist changed for this stateKey; starting a fresh trusted baseline.',
                {
                    stateKey,
                },
            );
        }

        const previousRecords =
            previousState
                .records
            ?? {};

        const successfulRunsBefore =
            Number(
                previousState
                    .successfulRuns
                ?? previousState
                    .runCount
                ?? 0,
            );

        const baselineReadyBeforeRun =
            Boolean(
                previousState
                    .baselineReady
                    === true
                || successfulRunsBefore
                    >= baselineWarmupRuns,
            );

        let baselineStartedAtBefore =
            clean(
                previousState
                    .baselineStartedAt,
            );

        if (
            !baselineStartedAtBefore
            && successfulRunsBefore > 0
        ) {
            baselineStartedAtBefore =
                earliestFirstSeenAt(
                    previousRecords,
                )
                || clean(
                    previousState
                        .updatedAt,
                );
        }

        let baselineReadyAtBefore =
            clean(
                previousState
                    .baselineReadyAt,
            );

        let legacyBaselineBoundaryApplied =
            false;

        if (
            baselineReadyBeforeRun
            && !baselineReadyAtBefore
        ) {
            baselineReadyAtBefore =
                clean(
                    previousState
                        .updatedAt,
                )
                || runStartedAt;

            legacyBaselineBoundaryApplied =
                true;

            log.warning(
                'Existing trusted baseline has no baselineReadyAt timestamp. Using the previous snapshot updatedAt as a conservative migration boundary.',
                {
                    stateKey,

                    baselineReadyAt:
                        baselineReadyAtBefore,
                },
            );
        }

        const observedRecords = {};

        let baselineCount =
            0;

        let discoveredCount =
            0;

        let newCount =
            0;

        let changedCount =
            0;

        let unchangedCount =
            0;

        let enrichedCount =
            0;

        let snapshotCount =
            0;

        let emittedCount =
            0;

        let reappearedCount =
            0;

        let firstSeenCount =
            0;

        const newCandidates =
            [];

        const discoveredCandidates =
            [];

        const changedCandidates =
            [];

        const enrichedCandidates =
            [];

        for (
            const internalRecord
            of collected.values()
        ) {
            const currentBasicHash =
                internalRecord
                    .__basicHash
                || basicHash(
                    internalRecord,
                );

            const currentDetailHash =
                internalRecord
                    .__detailHash
                || detailHash(
                    internalRecord,
                );

            const currentDetailKnown =
                Boolean(
                    internalRecord
                        .__detailKnown,
                );

            const currentKnownDetailFields =
                new Set(
                    Array
                        .isArray(
                            internalRecord
                                .__detailKnownFields,
                        )
                        ? internalRecord
                            .__detailKnownFields
                        : DETAIL_FIELDS
                            .filter(
                                (field) =>
                                    clean(
                                        internalRecord[
                                            field
                                        ],
                                    )
                                    !== '',
                            ),
                );

            const record = {
                ...internalRecord,
            };

            delete record
                .__basicHash;

            delete record
                .__detailHash;

            delete record
                .__detailKnown;

            delete record
                .__detailKnownFields;

            delete record
                .__detailFetched;

            record.registrant =
                sanitizeRegistrant(
                    record.registrant,
                );

            record
                .cosmeticsManufacturer =
                sanitizeCosmeticsManufacturer(
                    record
                        .cosmeticsManufacturer,
                );

            const id =
                record
                    .registrationNumber;

            const previousEntry =
                previousRecords[id];

            const previousRecord =
                previousEntry?.record
                    ? canonicalizeLegacyRecord(
                        previousEntry
                            .record,
                    )
                    : null;

            const previousWasDetailKnown =
                previousDetailKnown(
                    previousEntry,
                );

            const previousKnownDetailFieldsSet =
                previousKnownDetailFields(
                    previousEntry,
                );

            const priorMisses =
                previousConsecutiveMisses(
                    previousEntry,
                );

            const ageDays =
                issuedAgeDays(
                    record
                        .issuedDate,
                    runStartedAt,
                );

            if (
                previousEntry
                && priorMisses > 0
            ) {
                reappearedCount++;
            }

            const listingChangedFields =
                previousRecord
                    ? diffListingFields(
                        previousRecord,
                        record,
                    )
                    : [];

            const detailChangedFields =
                (
                    previousRecord
                    && previousWasDetailKnown
                    && currentDetailKnown
                )
                    ? diffKnownDetailFields(
                        previousRecord,
                        record,
                        previousKnownDetailFieldsSet,
                        currentKnownDetailFields,
                    )
                    : [];

            const enrichedFields =
                previousRecord
                    ? calculateEnrichedFields(
                        previousRecord,
                        record,
                        previousKnownDetailFieldsSet,
                        currentKnownDetailFields,
                    )
                    : [];

            const actualChangedFields =
                [
                    ...new Set([
                        ...listingChangedFields,

                        ...detailChangedFields,
                    ]),
                ];

            let eventType;

            let classificationReason;

            let previous;

            if (
                !detectChanges
            ) {
                eventType =
                    'SNAPSHOT';

                classificationReason =
                    'CHANGE_DETECTION_DISABLED';

                snapshotCount++;
            } else if (
                !previousEntry
            ) {
                firstSeenCount++;

                if (
                    !baselineReadyBeforeRun
                ) {
                    eventType =
                        'BASELINE';

                    classificationReason =
                        'TRUSTED_BASELINE_WARMUP';

                    baselineCount++;
                } else {
                    const boundaryComparison =
                        compareDateOnly(
                            record
                                .issuedDate,
                            baselineReadyAtBefore,
                        );

                    if (
                        ageDays === null
                    ) {
                        eventType =
                            'DISCOVERED';

                        classificationReason =
                            'FIRST_SEEN_WITH_UNKNOWN_ISSUED_DATE';

                        discoveredCount++;
                    } else if (
                        boundaryComparison
                            === null
                    ) {
                        eventType =
                            'DISCOVERED';

                        classificationReason =
                            'FIRST_SEEN_WITH_UNKNOWN_BASELINE_BOUNDARY';

                        discoveredCount++;
                    } else if (
                        boundaryComparison
                            < 0
                    ) {
                        eventType =
                            'DISCOVERED';

                        classificationReason =
                            'FIRST_SEEN_BEFORE_BASELINE_BOUNDARY';

                        discoveredCount++;
                    } else if (
                        ageDays < -1
                    ) {
                        eventType =
                            'DISCOVERED';

                        classificationReason =
                            'FIRST_SEEN_WITH_FUTURE_ISSUED_DATE';

                        discoveredCount++;
                    } else if (
                        ageDays
                            > newProductWindowDays
                    ) {
                        eventType =
                            'DISCOVERED';

                        classificationReason =
                            'FIRST_SEEN_OUTSIDE_NEW_PRODUCT_WINDOW';

                        discoveredCount++;
                    } else {
                        eventType =
                            'NEW';

                        classificationReason =
                            'FIRST_SEEN_ON_OR_AFTER_BASELINE_BOUNDARY';

                        newCount++;
                    }
                }
            } else if (
                !baselineReadyBeforeRun
            ) {
                if (
                    actualChangedFields
                        .length
                    > 0
                ) {
                    eventType =
                        'BASELINE';

                    classificationReason =
                        'BASELINE_RECORD_UPDATED_DURING_WARMUP';

                    baselineCount++;
                } else if (
                    enrichedFields
                        .length
                    > 0
                ) {
                    eventType =
                        'UNCHANGED';

                    classificationReason =
                        'BASELINE_RECORD_ENRICHED';

                    enrichedCount++;

                    unchangedCount++;
                } else {
                    eventType =
                        'UNCHANGED';

                    classificationReason =
                        'BASELINE_RECORD_REOBSERVED';

                    unchangedCount++;
                }
            } else if (
                actualChangedFields
                    .length
                > 0
            ) {
                eventType =
                    'CHANGED';

                classificationReason =
                    'KNOWN_RECORD_CHANGED';

                previous =
                    previousRecord;

                changedCount++;
            } else if (
                enrichedFields
                    .length
                > 0
            ) {
                eventType =
                    'UNCHANGED';

                classificationReason =
                    'KNOWN_RECORD_ENRICHED';

                enrichedCount++;

                unchangedCount++;
            } else {
                eventType =
                    'UNCHANGED';

                classificationReason =
                    'KNOWN_RECORD_UNCHANGED';

                unchangedCount++;
            }

            if (
                eventType === 'NEW'
                && newCandidates
                    .length
                    < 100
            ) {
                newCandidates.push({
                    registrationNumber:
                        id,

                    issuedDate:
                        record
                            .issuedDate,

                    issuedAgeDays:
                        ageDays,

                    classificationReason,
                });
            }

            if (
                eventType
                    === 'DISCOVERED'
                && discoveredCandidates
                    .length
                    < 100
            ) {
                discoveredCandidates
                    .push({
                        registrationNumber:
                            id,

                        issuedDate:
                            record
                                .issuedDate,

                        issuedAgeDays:
                            ageDays,

                        classificationReason,
                    });
            }

            if (
                eventType
                    === 'CHANGED'
                && changedCandidates
                    .length
                    < 100
            ) {
                changedCandidates
                    .push({
                        registrationNumber:
                            id,

                        changedFields:
                            actualChangedFields,

                        enrichedFields,

                        classificationReason,
                    });
            }

            if (
                enrichedFields
                    .length
                    > 0
                && enrichedCandidates
                    .length
                    < 100
            ) {
                enrichedCandidates
                    .push({
                        registrationNumber:
                            id,

                        enrichedFields,

                        classificationReason,
                    });
            }

            const output = {
                eventType,

                classificationReason,

                issuedAgeDays:
                    ageDays,

                ...record,

                detectedAt:
                    isoNow(),

                changedFields:
                    actualChangedFields,

                enrichedFields,

                ...(
                    previous
                        ? {
                            previous,
                        }
                        : {}
                ),
            };

            if (
                shouldEmit(
                    emit,
                    eventType,
                )
            ) {
                await Actor
                    .pushData(
                        output,
                    );

                emittedCount++;
            }

            const fallbackFirstSeenAt =
                previousEntry
                    ? (
                        previousEntry
                            .record
                            ?.scrapedAt
                        || previousState
                            .updatedAt
                        || runStartedAt
                    )
                    : runStartedAt;

            observedRecords[id] = {
                hash:
                    stableHash(
                        record,
                    ),

                basicHash:
                    currentBasicHash,

                detailHash:
                    currentDetailHash,

                detailKnown:
                    currentDetailKnown,

                detailKnownFields:
                    [
                        ...currentKnownDetailFields,
                    ],

                record,

                firstSeenAt:
                    previousEntry
                        ?.firstSeenAt
                    || fallbackFirstSeenAt,

                lastSeenAt:
                    runStartedAt,

                observationCount:
                    previousObservationCount(
                        previousEntry,
                    )
                    + 1,

                consecutiveMisses:
                    0,
            };
        }

        const previousIds =
            Object.keys(
                previousRecords,
            );

        const observedIds =
            new Set(
                Object.keys(
                    observedRecords,
                ),
            );

        const possiblyMissing =
            (
                detectChanges
                && !baselineReset
                && overallCoverageComplete
            )
                ? previousIds
                    .filter(
                        (id) =>
                            !observedIds
                                .has(id),
                    )
                : [];

        const snapshotCanUpdate =
            detectChanges
            && failedJobs
                .length
                === 0
            && (
                overallCoverageComplete
                || allowPartialSnapshotUpdate
            );

        const nextRecords = {
            ...observedRecords,
        };

        let retainedFromPreviousSnapshot =
            0;

        if (
            snapshotCanUpdate
            && !baselineReset
        ) {
            for (
                const id
                of previousIds
            ) {
                if (
                    observedIds
                        .has(id)
                ) {
                    continue;
                }

                const previousEntry =
                    previousRecords[id];

                if (
                    !previousEntry
                ) {
                    continue;
                }

                retainedFromPreviousSnapshot++;

                const missIncrement =
                    overallCoverageComplete
                        ? 1
                        : 0;

                nextRecords[id] = {
                    ...previousEntry,

                    firstSeenAt:
                        previousEntry
                            .firstSeenAt
                        || previousEntry
                            .record
                            ?.scrapedAt
                        || previousState
                            .updatedAt
                        || runStartedAt,

                    lastSeenAt:
                        previousEntry
                            .lastSeenAt
                        || previousEntry
                            .record
                            ?.scrapedAt
                        || previousState
                            .updatedAt
                        || runStartedAt,

                    observationCount:
                        previousObservationCount(
                            previousEntry,
                        ),

                    consecutiveMisses:
                        previousConsecutiveMisses(
                            previousEntry,
                        )
                        + missIncrement,
                };
            }
        }

        const successfulRunsAfter =
            (
                snapshotCanUpdate
                && overallCoverageComplete
            )
                ? successfulRunsBefore
                    + 1
                : successfulRunsBefore;

        const baselineReadyAfterRun =
            Boolean(
                baselineReadyBeforeRun
                || successfulRunsAfter
                    >= baselineWarmupRuns,
            );

        let baselineStartedAtAfter =
            baselineStartedAtBefore;

        if (
            !baselineStartedAtAfter
            && snapshotCanUpdate
            && overallCoverageComplete
            && successfulRunsAfter >= 1
        ) {
            baselineStartedAtAfter =
                runStartedAt;
        }

        let baselineReadyAtAfter =
            baselineReadyAtBefore;

        if (
            !baselineReadyAtAfter
            && !baselineReadyBeforeRun
            && baselineReadyAfterRun
            && snapshotCanUpdate
            && overallCoverageComplete
        ) {
            baselineReadyAtAfter =
                isoNow();
        }

        if (
            snapshotCanUpdate
        ) {
            await stateStore
                .setValue(
                    `SNAPSHOT_${stateKey}`,
                    {
                        version:
                            SNAPSHOT_VERSION,

                        actorVersion:
                            ACTOR_VERSION,

                        watchSignature,

                        successfulRuns:
                            successfulRunsAfter,

                        baselineWarmupRuns,

                        baselineStartedAt:
                            baselineStartedAtAfter,

                        baselineReadyAt:
                            baselineReadyAtAfter,

                        baselineReady:
                            baselineReadyAfterRun,

                        updatedAt:
                            isoNow(),

                        coverageComplete:
                            overallCoverageComplete,

                        detailStrategy,

                        records:
                            nextRecords,
                    },
                );
        } else if (
            detectChanges
        ) {
            log.warning(
                'Snapshot NOT updated because coverage was incomplete or a query failed.',
                {
                    overallCoverageComplete,

                    failedJobs:
                        failedJobs
                            .length,

                    allowPartialSnapshotUpdate,
                },
            );
        }

        const totalRawRowsCollected =
            querySummaryList
                .reduce(
                    (
                        total,
                        query,
                    ) =>
                        total
                        + (
                            query
                                ?.rawRowsCollected
                            ?? 0
                        ),
                    0,
                );

        const totalDuplicateRows =
            querySummaryList
                .reduce(
                    (
                        total,
                        query,
                    ) =>
                        total
                        + (
                            query
                                ?.duplicateRows
                            ?? 0
                        ),
                    0,
                );

        const uniqueDuplicateRegistrationNumbers =
            new Set(
                querySummaryList
                    .flatMap(
                        (query) =>
                            query
                                ?.duplicateRegistrationNumbers
                            ?? [],
                    ),
            );

        const missingDetails =
            possiblyMissing
                .slice(
                    0,
                    100,
                )
                .map(
                    (id) => {
                        const entry =
                            nextRecords[id]
                            || previousRecords[id];

                        return {
                            registrationNumber:
                                id,

                            consecutiveMisses:
                                entry
                                    ?.consecutiveMisses
                                ?? 0,

                            lastSeenAt:
                                entry
                                    ?.lastSeenAt
                                || '',
                        };
                    },
                );

        const persistedSnapshotProducts =
            snapshotCanUpdate
                ? Object.keys(
                    nextRecords,
                ).length
                : Object.keys(
                    previousRecords,
                ).length;

        let baselineStatus =
            'DISABLED';

        if (
            detectChanges
        ) {
            if (
                baselineReadyBeforeRun
            ) {
                baselineStatus =
                    'READY';
            } else if (
                baselineReadyAfterRun
            ) {
                baselineStatus =
                    'READY_AFTER_THIS_RUN';
            } else {
                baselineStatus =
                    'WARMING_UP';
            }
        }

        const summary = {
            version:
                ACTOR_VERSION,

            baseline: {
                status:
                    baselineStatus,

                requiredSuccessfulRuns:
                    baselineWarmupRuns,

                successfulRunsBefore,

                successfulRunsAfter,

                readyBeforeRun:
                    baselineReadyBeforeRun,

                readyAfterRun:
                    baselineReadyAfterRun,

                baselineStartedAt:
                    baselineStartedAtAfter
                    || '',

                baselineReadyAt:
                    baselineReadyAtAfter
                    || '',

                baselineReadyDate:
                    isoDateOnly(
                        baselineReadyAtAfter,
                    ),

                legacyBoundaryMigration:
                    legacyBaselineBoundaryApplied,

                newProductWindowDays,
            },

            monitoringSummary: {
                watchlistQueries:
                    jobs.length,

                failedQueries:
                    failedJobs.length,

                coverageComplete:
                    overallCoverageComplete,

                detailStrategy,

                detailFetches:
                    detailStats.requested,

                detailSkips:
                    detailStats.skipped,

                rawRowsCollected:
                    totalRawRowsCollected,

                observedThisRun:
                    collected.size,

                duplicateRows:
                    totalDuplicateRows,

                duplicateRegistrationNumbers:
                    uniqueDuplicateRegistrationNumbers
                        .size,

                previousKnownProducts:
                    Object.keys(
                        previousRecords,
                    ).length,

                retainedFromPreviousSnapshot,

                snapshotProducts:
                    persistedSnapshotProducts,

                firstSeenProducts:
                    firstSeenCount,

                baselineProducts:
                    baselineCount,

                newProducts:
                    newCount,

                discoveredProducts:
                    discoveredCount,

                changedProducts:
                    changedCount,

                enrichedProducts:
                    enrichedCount,

                unchangedProducts:
                    unchangedCount,

                snapshotProductsEmitted:
                    snapshotCount,

                emittedRecords:
                    emittedCount,

                possiblyMissingProducts:
                    possiblyMissing
                        .length,

                reappearedProducts:
                    reappearedCount,
            },

            querySummaries:
                querySummaryList,

            possiblyMissingRegistrationNumbers:
                possiblyMissing
                    .slice(
                        0,
                        100,
                    ),

            possiblyMissingDetails:
                missingDetails,

            classificationSamples: {
                new:
                    newCandidates,

                discovered:
                    discoveredCandidates,

                changed:
                    changedCandidates,

                enriched:
                    enrichedCandidates,
            },

            baselineReset,

            baselineResetReason,

            snapshotUpdated:
                snapshotCanUpdate,

            stateStoreName,

            stateKey,

            watchSignature,

            finishedAt:
                isoNow(),
        };

        await Actor.setValue(
            'OUTPUT',
            summary,
        );

        log.info(
            'Run finished.',
            summary,
        );
    },
);
