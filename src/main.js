import crypto from 'node:crypto';
import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const BASE_URL = 'https://cekbpom.pom.go.id/produk-kosmetika';
const SNAPSHOT_VERSION = 2;

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const isoNow = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function textLines(v) {
    return String(v ?? '')
        .split(/\r?\n/)
        .map(clean)
        .filter(Boolean);
}

function parseRegistrationCell(v) {
    const t = clean(v);

    return {
        registrationNumber:
            t.match(/\b[A-Z]{2,3}\d{8,}\b/i)?.[0] || '',

        issuedDate:
            t.match(
                /Terbit\s*:\s*(\d{4}-\d{2}-\d{2})/i,
            )?.[1] || '',
    };
}

function parseProductCell(v) {
    const lines = textLines(v);

    let brand = '';
    let packaging = '';

    const name = [];

    for (const line of lines) {
        if (/^Merk\s*:/i.test(line)) {
            brand = clean(
                line.replace(/^Merk\s*:/i, ''),
            );
        } else if (/^Merek\s*:/i.test(line)) {
            brand = clean(
                line.replace(/^Merek\s*:/i, ''),
            );
        } else if (/^Kemasan\s*:/i.test(line)) {
            packaging = clean(
                line.replace(/^Kemasan\s*:/i, ''),
            );
        } else {
            name.push(line);
        }
    }

    const full = clean(v);

    if (!brand) {
        brand =
            full.match(
                /Merk\s*:\s*(.*?)(?=Kemasan\s*:|$)/i,
            )?.[1]?.trim() || '';
    }

    if (!packaging) {
        packaging =
            full.match(
                /Kemasan\s*:\s*(.*)$/i,
            )?.[1]?.trim() || '';
    }

    return {
        productName: clean(
            name
                .join(' ')
                .replace(/Merk\s*:.*$/i, '')
                .replace(/Merek\s*:.*$/i, ''),
        ),

        brand: clean(brand),

        packaging: clean(packaging),
    };
}

function parseRegistrantCell(v) {
    const lines = textLines(v);

    return lines.length >= 2
        ? {
            registrant:
                clean(lines[0]),

            registrantLocation:
                clean(
                    lines
                        .slice(1)
                        .join(' '),
                ),
        }
        : {
            registrant:
                clean(v),

            registrantLocation:
                '',
        };
}

function stableHash(record) {
    const fields = [
        'registrationNumber',
        'productName',
        'brand',
        'registrant',
        'registrantLocation',
        'cosmeticsManufacturer',
        'packaging',
        'composition',
        'kits',
        'issuedBy',
        'dosageForm',
        'applicationDate',
        'issuedDate',
        'expiryDate',
        'status',
    ];

    const payload =
        Object.fromEntries(
            fields.map(
                (key) => [
                    key,
                    clean(record[key]),
                ],
            ),
        );

    return crypto
        .createHash('sha256')
        .update(
            JSON.stringify(payload),
        )
        .digest('hex');
}

function basicHash(record) {
    const fields = [
        'registrationNumber',
        'issuedDate',
        'productName',
        'brand',
        'packaging',
        'registrant',
        'registrantLocation',
    ];

    const payload =
        Object.fromEntries(
            fields.map(
                (key) => [
                    key,
                    clean(record[key]),
                ],
            ),
        );

    return crypto
        .createHash('sha256')
        .update(
            JSON.stringify(payload),
        )
        .digest('hex');
}

function normalizeKey(label) {
    return clean(label)
        .toLowerCase()
        .normalize('NFKD')
        .replace(
            /[^a-z0-9]+/g,
            ' ',
        )
        .trim();
}

function mapDetails(raw = {}) {
    const normalized =
        Object.fromEntries(
            Object.entries(raw)
                .map(
                    ([key, value]) => [
                        normalizeKey(key),
                        clean(value),
                    ],
                ),
        );

    const pick = (...candidates) => {
        for (
            const candidate
            of candidates
        ) {
            const target =
                normalizeKey(candidate);

            if (normalized[target]) {
                return normalized[target];
            }

            const fuzzy =
                Object.entries(normalized)
                    .find(
                        ([key]) =>
                            key.includes(target)
                            || target.includes(key),
                    );

            if (fuzzy?.[1]) {
                return fuzzy[1];
            }
        }

        return '';
    };

    return {
        registrationNumber:
            pick(
                'nomor registrasi',
                'nomor izin edar',
                'nie',
            ),

        productName:
            pick('nama produk'),

        brand:
            pick(
                'merk',
                'merek',
            ),

        packaging:
            pick('kemasan'),

        dosageForm:
            pick('bentuk sediaan'),

        composition:
            pick('komposisi'),

        applicationDate:
            pick('tanggal permohonan'),

        issuedDate:
            pick('tanggal terbit'),

        expiryDate:
            pick(
                'tanggal expired',
                'tanggal kedaluwarsa',
            ),

        registrant:
            pick(
                'nama pendaftar',
                'pendaftar',
            ),

        cosmeticsManufacturer:
            pick('industri kosmetika'),

        kits:
            pick('kits'),

        issuedBy:
            pick('diterbitkan oleh'),

        status:
            pick('status'),
    };
}

function buildJobs(input) {
    const jobs = [];

    const add = (
        kind,
        values = [],
    ) => {
        for (
            const raw
            of values || []
        ) {
            const value =
                clean(raw);

            if (value) {
                jobs.push({
                    kind,
                    value,
                });
            }
        }
    };

    add(
        'brand',
        input.brands,
    );

    add(
        'registrant',
        input.registrants,
    );

    add(
        'productName',
        input.productNames,
    );

    add(
        'registrationNumber',
        input.registrationNumbers,
    );

    add(
        'composition',
        input.compositions,
    );

    if (!jobs.length) {
        throw new Error(
            'At least one monitoring criterion is required: brand, registrant, product name, registration number, or composition keyword.',
        );
    }

    return jobs;
}

function buildWatchSignature(jobs) {
    const normalized =
        jobs
            .map(
                (job) => ({
                    kind:
                        job.kind,

                    value:
                        clean(
                            job.value,
                        ).toLowerCase(),
                }),
            )
            .sort(
                (a, b) =>
                    `${a.kind}:${a.value}`
                        .localeCompare(
                            `${b.kind}:${b.value}`,
                        ),
            );

    return crypto
        .createHash('sha256')
        .update(
            JSON.stringify(
                normalized,
            ),
        )
        .digest('hex');
}

function inputPlaceholderFor(kind) {
    return {
        registrationNumber:
            'Masukkan Nomor Registrasi',

        productName:
            'Masukkan Nama Produk',

        brand:
            'Masukkan Merk',

        composition:
            'Masukkan Komposisi',

        registrant:
            'Masukkan Nama Pendaftar',
    }[kind];
}

async function visibleLocator(locator) {
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

async function getProductTable(page) {
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

    let fallback =
        null;

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
            fallback =
                table;
        }

        if (
            await table
                .locator(
                    'tbody tr',
                )
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

async function waitForTable(page) {
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

    await sleep(
        delay,
    );

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

    await field.fill(
        job.value,
    );

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

async function extractDetailPairs(dialog) {
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
                    cleanText(
                        value,
                    )
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
                'Kits',
                'Diterbitkan Oleh',
                'Status',
            ];

            const known =
                new Map(
                    labels.map(
                        (label) => [
                            normalize(
                                label,
                            ),
                            label,
                        ],
                    ),
                );

            const put =
                (
                    key,
                    value,
                ) => {
                    key =
                        cleanText(
                            key,
                        )
                            .replace(
                                /:$/,
                                '',
                            );

                    value =
                        cleanText(
                            value,
                        );

                    if (
                        key
                        && value
                        && key !== value
                        && !result[key]
                    ) {
                        result[key] =
                            value;
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
                                .filter(
                                    Boolean,
                                );

                        if (
                            cells.length
                                >= 2
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
                    .split(
                        /\r?\n/,
                    )
                    .map(
                        cleanText,
                    )
                    .filter(
                        Boolean,
                    )
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
                        normalize(
                            line,
                        ),
                    );

                if (!label) {
                    continue;
                }

                const values =
                    [];

                for (
                    let j = i + 1;
                    j < lines.length;
                    j++
                ) {
                    const candidate =
                        lines[j];

                    if (
                        known.has(
                            normalize(
                                candidate,
                            ),
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
                        values.join(
                            ' ',
                        ),
                    );
                }
            }

            return result;
        },
    );
}

async function getVisibleDialog(page) {
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

        if (count > 0) {
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
            return {};
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
                    dialogText.slice(
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

        if (close) {
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

        return details;
    } catch (error) {
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

        return {};
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
    },
    crawlerLog,
) {
    const table =
        await getProductTable(
            page,
        );

    const rows =
        table.locator(
            'tbody tr',
        );

    const results =
        [];

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
                product
                    .brand,

            packaging:
                product
                    .packaging,

            registrant:
                registrant
                    .registrant,

            registrantLocation:
                registrant
                    .registrantLocation,
        };

        const currentBasicHash =
            basicHash(
                list,
            );

        const previousEntry =
            previousRecords[
                list.registrationNumber
            ];

        const previousRecord =
            previousEntry?.record
            ?? null;

        const previousBasicHash =
            previousEntry?.basicHash
            || (
                previousRecord
                    ? basicHash(
                        previousRecord,
                    )
                    : ''
            );

        const listingChanged =
            previousRecord
                ? (
                    previousBasicHash
                    !== currentBasicHash
                )
                : true;

        let shouldFetchDetail =
            false;

        if (
            detailStrategy === 'always'
        ) {
            shouldFetchDetail =
                true;
        } else if (
            detailStrategy === 'changesOnly'
            && detectChanges
            && (
                !previousRecord
                || listingChanged
            )
        ) {
            shouldFetchDetail =
                true;
        }

        if (shouldFetchDetail) {
            detailStats.requested++;
        } else {
            detailStats.skipped++;
        }

        const detail =
            shouldFetchDetail
                ? await enrichFromRow(
                    page,
                    row,
                    requestDelayMs,
                    crawlerLog,
                )
                : {};

        const carriedDetail = {};

        if (previousRecord) {
            const carryFields = [
                'composition',
                'cosmeticsManufacturer',
                'kits',
                'issuedBy',
                'dosageForm',
                'applicationDate',
                'expiryDate',
                'status',
            ];

            for (
                const field
                of carryFields
            ) {
                if (
                    previousRecord[field]
                    !== undefined
                ) {
                    carriedDetail[field] =
                        previousRecord[field];
                }
            }
        }

        const record = {
            ...list,

            ...carriedDetail,

            registrationNumber:
                clean(
                    detail
                        .registrationNumber
                    || list
                        .registrationNumber,
                ),

            issuedDate:
                clean(
                    detail
                        .issuedDate
                    || list
                        .issuedDate,
                ),

            productName:
                clean(
                    detail
                        .productName
                    || list
                        .productName,
                ),

            brand:
                clean(
                    detail.brand
                    || list.brand,
                ),

            packaging:
                clean(
                    detail.packaging
                    || list.packaging,
                ),

            composition:
                clean(
                    detail.composition
                    || carriedDetail.composition,
                ),

            registrant:
                clean(
                    detail.registrant
                    || list.registrant,
                ),

            registrantLocation:
                clean(
                    list
                        .registrantLocation,
                ),

            cosmeticsManufacturer:
                clean(
                    detail.cosmeticsManufacturer
                    || carriedDetail.cosmeticsManufacturer,
                ),

            kits:
                clean(
                    detail.kits
                    || carriedDetail.kits,
                ),

            issuedBy:
                clean(
                    detail.issuedBy
                    || carriedDetail.issuedBy,
                ),

            dosageForm:
                clean(
                    detail.dosageForm
                    || carriedDetail.dosageForm,
                ),

            applicationDate:
                clean(
                    detail.applicationDate
                    || carriedDetail.applicationDate,
                ),

            expiryDate:
                clean(
                    detail.expiryDate
                    || carriedDetail.expiryDate,
                ),

            status:
                clean(
                    detail.status
                    || carriedDetail.status,
                ),

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
        };

        if (
            record
                .registrationNumber
        ) {
            results.push(
                record,
            );
        }
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
        ).catch(
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

                        const current =
                            (
                                table
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
                            current
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

function diffFields(
    previous,
    current,
) {
    return [
        'productName',
        'brand',
        'registrant',
        'registrantLocation',
        'cosmeticsManufacturer',
        'packaging',
        'composition',
        'kits',
        'issuedBy',
        'dosageForm',
        'applicationDate',
        'issuedDate',
        'expiryDate',
        'status',
    ].filter(
        (key) =>
            clean(
                previous?.[key],
            )
            !== clean(
                current?.[key],
            ),
    );
}

function shouldEmit(
    mode,
    eventType,
) {
    if (
        mode === 'new'
    ) {
        return (
            eventType
            === 'NEW'
        );
    }

    if (
        mode === 'changes'
    ) {
        return [
            'NEW',
            'CHANGED',
        ].includes(
            eventType,
        );
    }

    return true;
}

await Actor.main(
    async () => {
        const input =
            await Actor.getInput()
            ?? {};

        const jobs =
            buildJobs(
                input,
            );

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

        const detailStrategy =
            clean(
                input.detailStrategy
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

        const requestDelayMs =
            Number(
                input
                    .requestDelayMs
                ?? 800,
            );

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

        log.info(
            'Actor input loaded.',
            {
                jobs:
                    jobs.length,

                detailStrategy,

                detectChanges,

                emit,

                maxItemsPerQuery,

                maxPagesPerQuery,

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
            requested: 0,
            skipped: 0,
        };

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

        const previousRecordsForDetail =
            (
                detectChanges
                && rawPreviousState
                    ?.watchSignature
                    === watchSignature
            )
                ? (
                    rawPreviousState.records
                    ?? {}
                )
                : {};

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

                    const seenRegistrationNumbers =
                        new Set();

                    const duplicateRegistrationNumbers =
                        new Set();

                    let duplicateRows =
                        0;

                    let stopReason =
                        'unknown';

                    let coverageComplete =
                        false;

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
                                    .get(
                                        key,
                                    );

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
                            || String(
                                error,
                            ),
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

                records:
                    {},
            };

            log.warning(
                'Watchlist changed for this stateKey; starting a fresh baseline.',
                {
                    stateKey,
                },
            );
        }

        const previousRecords =
            previousState
                .records
            ?? {};

        const nextRecords =
            {};

        let newCount =
            0;

        let changedCount =
            0;

        let unchangedCount =
            0;

        let snapshotCount =
            0;

        let emittedCount =
            0;

        for (
            const internalRecord
            of collected.values()
        ) {
            const currentBasicHash =
                internalRecord.__basicHash
                || basicHash(
                    internalRecord,
                );

            const record = {
                ...internalRecord,
            };

            delete record.__basicHash;

            const id =
                record
                    .registrationNumber;

            const hash =
                stableHash(
                    record,
                );

            const previousEntry =
                previousRecords[id];

            let eventType;

            let changedFields =
                [];

            let previous;

            if (!detectChanges) {
                eventType =
                    'SNAPSHOT';

                snapshotCount++;
            } else if (
                !previousEntry
            ) {
                eventType =
                    'NEW';

                newCount++;
            } else if (
                previousEntry
                    .hash
                !== hash
            ) {
                eventType =
                    'CHANGED';

                previous =
                    previousEntry
                        .record;

                changedFields =
                    diffFields(
                        previousEntry
                            .record,
                        record,
                    );

                changedCount++;
            } else {
                eventType =
                    'UNCHANGED';

                unchangedCount++;
            }

            const output = {
                eventType,

                ...record,

                detectedAt:
                    isoNow(),

                changedFields,

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

            nextRecords[id] = {
                hash,

                basicHash:
                    currentBasicHash,

                record,
            };
        }

        const previousIds =
            Object.keys(
                previousRecords,
            );

        const currentIds =
            new Set(
                Object.keys(
                    nextRecords,
                ),
            );

        const possiblyMissing =
            detectChanges
            && !baselineReset
            && overallCoverageComplete
                ? previousIds
                    .filter(
                        (id) =>
                            !currentIds
                                .has(id),
                    )
                : [];

        const snapshotCanUpdate =
            detectChanges
            && failedJobs.length
                === 0
            && (
                overallCoverageComplete
                || allowPartialSnapshotUpdate
            );

        if (snapshotCanUpdate) {
            await stateStore
                .setValue(
                    `SNAPSHOT_${stateKey}`,
                    {
                        version:
                            SNAPSHOT_VERSION,

                        watchSignature,

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
                    (total, query) =>
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
                    (total, query) =>
                        total
                        + (
                            query
                                ?.duplicateRows
                            ?? 0
                        ),
                    0,
                );

        const summary = {
            version:
                '0.2.1',

            monitoringSummary: {
                watchlistQueries:
                    jobs.length,

                failedQueries:
                    failedJobs
                        .length,

                coverageComplete:
                    overallCoverageComplete,

                detailStrategy,

                detailFetches:
                    detailStats.requested,

                detailSkips:
                    detailStats.skipped,

                rawRowsCollected:
                    totalRawRowsCollected,

                uniqueProducts:
                    collected.size,

                duplicateRows:
                    totalDuplicateRows,

                productsChecked:
                    collected.size,

                previousSnapshotProducts:
                    Object.keys(
                        previousRecords,
                    ).length,

                currentSnapshotProducts:
                    Object.keys(
                        nextRecords,
                    ).length,

                newProducts:
                    newCount,

                changedProducts:
                    changedCount,

                unchangedProducts:
                    unchangedCount,

                snapshotProducts:
                    snapshotCount,

                emittedRecords:
                    emittedCount,

                possiblyMissingProducts:
                    possiblyMissing
                        .length,
            },

            querySummaries:
                querySummaryList,

            possiblyMissingRegistrationNumbers:
                possiblyMissing
                    .slice(
                        0,
                        100,
                    ),

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
