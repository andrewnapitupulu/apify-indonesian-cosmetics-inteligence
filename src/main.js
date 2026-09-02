import crypto from 'node:crypto';
import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const BASE_URL = 'https://cekbpom.pom.go.id/produk-kosmetika';
const SNAPSHOT_VERSION = 1;

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const isoNow = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function textLines(value) {
    return String(value ?? '')
        .split(/\r?\n/)
        .map((line) => clean(line))
        .filter(Boolean);
}

function parseRegistrationCell(value) {
    const text = clean(value);

    const registrationNumber =
        text.match(/\b[A-Z]{2,3}\d{8,}\b/i)?.[0]
        || '';

    const issuedDate =
        text.match(
            /Terbit\s*:\s*(\d{4}-\d{2}-\d{2})/i,
        )?.[1]
        || '';

    return {
        registrationNumber,
        issuedDate,
    };
}

function parseProductCell(value) {
    const lines = textLines(value);

    let brand = '';
    let packaging = '';

    const productNameLines = [];

    for (const line of lines) {
        if (/^Merk\s*:/i.test(line)) {
            brand = clean(
                line.replace(
                    /^Merk\s*:/i,
                    '',
                ),
            );

            continue;
        }

        if (/^Merek\s*:/i.test(line)) {
            brand = clean(
                line.replace(
                    /^Merek\s*:/i,
                    '',
                ),
            );

            continue;
        }

        if (/^Kemasan\s*:/i.test(line)) {
            packaging = clean(
                line.replace(
                    /^Kemasan\s*:/i,
                    '',
                ),
            );

            continue;
        }

        productNameLines.push(line);
    }

    /*
     * Fallback jika BPOM tidak memberikan line-break yang jelas.
     */
    const fullText = clean(value);

    if (!brand) {
        brand = fullText.match(
            /Merk\s*:\s*(.*?)(?=Kemasan\s*:|$)/i,
        )?.[1]?.trim() || '';
    }

    if (!packaging) {
        packaging = fullText.match(
            /Kemasan\s*:\s*(.*)$/i,
        )?.[1]?.trim() || '';
    }

    let productName =
        clean(
            productNameLines.join(' '),
        );

    /*
     * Hilangkan metadata jika semuanya tergabung
     * dalam satu baris.
     */
    productName = productName
        .replace(
            /Merk\s*:.*$/i,
            '',
        )
        .replace(
            /Merek\s*:.*$/i,
            '',
        );

    return {
        productName: clean(productName),
        brand: clean(brand),
        packaging: clean(packaging),
    };
}

function parseRegistrantCell(value) {
    const lines = textLines(value);

    if (lines.length >= 2) {
        return {
            registrant: clean(
                lines[0],
            ),

            registrantLocation: clean(
                lines
                    .slice(1)
                    .join(' '),
            ),
        };
    }

    return {
        registrant: clean(value),
        registrantLocation: '',
    };
}

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

            const fuzzy = Object.entries(normalized)
                .find(([key]) => key.includes(target) || target.includes(key));

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
        expiryDate: pick(
            'tanggal expired',
            'tanggal kedaluwarsa',
        ),
        registrant: pick(
            'nama pendaftar',
            'pendaftar',
        ),
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
        jobs.push({
            kind: 'all',
            value: '',
        });
    }

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

        if (await item.isVisible().catch(() => false)) {
            return item;
        }
    }

    return null;
}

async function applyFilter(
    page,
    job,
    requestDelayMs,
    crawlerLog,
) {
    if (job.kind === 'all') {
        return;
    }

    const openFilter = await visibleLocator(
        page.getByRole(
            'button',
            { name: /^Filter$/i },
        ),
    );

    if (!openFilter) {
        throw new Error(
            'BPOM Filter button was not found.',
        );
    }

    await openFilter.click();
    await sleep(requestDelayMs);

    const placeholder = inputPlaceholderFor(job.kind);

    if (!placeholder) {
        throw new Error(
            `Unsupported query kind: ${job.kind}`,
        );
    }

    const field = await visibleLocator(
        page.locator(
            `input[placeholder="${placeholder}"]`,
        ),
    );

    if (!field) {
        throw new Error(
            `BPOM filter field was not found: ${placeholder}`,
        );
    }

    await field.fill(job.value);

    const applyFilterButton = await visibleLocator(
        page.getByRole(
            'button',
            { name: /^Filter$/i },
        ),
    );

    if (!applyFilterButton) {
        throw new Error(
            'BPOM apply Filter button was not found.',
        );
    }

    const before = clean(
        await page
            .locator('table tbody')
            .first()
            .innerText()
            .catch(() => ''),
    );

    await applyFilterButton.click();

    await sleep(
        Math.max(
            300,
            requestDelayMs,
        ),
    );

    await page.waitForFunction(
        (previous) => {
            const body = document.querySelector(
                'table tbody',
            );

            if (!body) {
                return false;
            }

            const current = (
                body.textContent || ''
            )
                .replace(/\s+/g, ' ')
                .trim();

            return (
                current !== previous
                || current.length > 0
            );
        },
        before,
        {
            timeout: 20000,
        },
    ).catch(() => {
        crawlerLog.debug(
            'Table text did not visibly change after applying filter; continuing.',
        );
    });
}

async function waitForTable(page) {
    await page.waitForSelector(
        'table',
        {
            timeout: 30000,
        },
    );

    await page.waitForFunction(
        () => {
            const tables = [
                ...document.querySelectorAll('table'),
            ];

            return tables.some((table) => {
                const headers = (
                    table.querySelector('thead')?.textContent
                    || ''
                )
                    .replace(/\s+/g, ' ')
                    .trim();

                const isProductTable =
                    /Nomor Registrasi/i.test(headers)
                    && /Nama Produk/i.test(headers);

                if (!isProductTable) {
                    return false;
                }

                const rows =
                    table.querySelectorAll('tbody tr');

                if (rows.length > 0) {
                    return true;
                }

                const bodyText = (
                    table.querySelector('tbody')?.textContent
                    || ''
                )
                    .replace(/\s+/g, ' ')
                    .trim();

                return /tidak ada data|no data|data kosong/i.test(
                    bodyText,
                );
            });
        },
        {
            timeout: 30000,
        },
    ).catch(() => undefined);
}

async function extractDetailPairs(dialog) {
    return dialog.evaluate((root) => {
        const result = {};

        const cleanText = (value) =>
            String(value ?? '')
                .replace(/\u00a0/g, ' ')
                .replace(/[ \t]+/g, ' ')
                .trim();

        const normalizeLabel = (value) =>
            cleanText(value)
                .replace(/:$/, '')
                .toLowerCase();

        const knownLabels = [
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
            'Status',
        ];

        const normalizedKnownLabels =
            new Map(
                knownLabels.map((label) => [
                    normalizeLabel(label),
                    label,
                ]),
            );

        const put = (key, value) => {
            const k = cleanText(key)
                .replace(/:$/, '');

            const v = cleanText(value);

            if (
                !k
                || !v
                || k === v
            ) {
                return;
            }

            if (!result[k]) {
                result[k] = v;
            }
        };

        /*
         * Strategy 1:
         * table / tr / td / th
         */
        root
            .querySelectorAll('tr')
            .forEach((tr) => {
                const cells = [
                    ...tr.querySelectorAll(
                        ':scope > th, :scope > td',
                    ),
                ]
                    .map((el) =>
                        cleanText(
                            el.innerText
                            || el.textContent,
                        ))
                    .filter(Boolean);

                if (cells.length >= 2) {
                    put(
                        cells[0],
                        cells
                            .slice(1)
                            .join(' '),
                    );
                }
            });

        /*
         * Strategy 2:
         * definition list
         */
        root
            .querySelectorAll('dt')
            .forEach((dt) => {
                let sibling =
                    dt.nextElementSibling;

                while (
                    sibling
                    && sibling.tagName
                        ?.toLowerCase()
                        !== 'dd'
                ) {
                    sibling =
                        sibling.nextElementSibling;
                }

                if (sibling) {
                    put(
                        dt.innerText,
                        sibling.innerText,
                    );
                }
            });

        /*
         * Strategy 3:
         * label + nearby value
         */
        root
            .querySelectorAll('label')
            .forEach((label) => {
                const key =
                    cleanText(
                        label.innerText
                        || label.textContent,
                    );

                let value = '';

                /*
                 * Try sibling first.
                 */
                let sibling =
                    label.nextElementSibling;

                while (
                    sibling
                    && !value
                ) {
                    value =
                        cleanText(
                            sibling.innerText
                            || sibling.textContent
                            || sibling.value,
                        );

                    sibling =
                        sibling.nextElementSibling;
                }

                /*
                 * Try parent container.
                 */
                if (!value) {
                    const parent =
                        label.parentElement;

                    if (parent) {
                        const parentText =
                            cleanText(
                                parent.innerText,
                            );

                        value =
                            cleanText(
                                parentText
                                    .replace(
                                        key,
                                        '',
                                    ),
                            );
                    }
                }

                put(key, value);
            });

        /*
         * Strategy 4:
         * Parse modal based on text lines.
         *
         * This is important because BPOM may render
         * labels and values in nested Bootstrap divs.
         */
        const rawText =
            root.innerText
            || root.textContent
            || '';

        const lines =
            rawText
                .split(/\r?\n/)
                .map(cleanText)
                .filter(Boolean)
                .filter(
                    (line) =>
                        !/^Detail Produk$/i.test(
                            line,
                        )
                        && !/^Close$/i.test(
                            line,
                        )
                        && line !== '×',
                );

        for (
            let i = 0;
            i < lines.length;
            i++
        ) {
            const line =
                lines[i];

            /*
             * Case:
             * "Merk: SOMETHINC"
             */
            const colonMatch =
                line.match(
                    /^([^:]{2,50})\s*:\s*(.+)$/,
                );

            if (colonMatch) {
                const possibleLabel =
                    normalizeLabel(
                        colonMatch[1],
                    );

                if (
                    normalizedKnownLabels
                        .has(possibleLabel)
                ) {
                    put(
                        normalizedKnownLabels
                            .get(possibleLabel),
                        colonMatch[2],
                    );

                    continue;
                }
            }

            /*
             * Case:
             *
             * Merk
             * SOMETHINC
             */
            const normalizedLine =
                normalizeLabel(line);

            const canonicalLabel =
                normalizedKnownLabels
                    .get(normalizedLine);

            if (!canonicalLabel) {
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

                const candidateNormalized =
                    normalizeLabel(
                        candidate,
                    );

                if (
                    normalizedKnownLabels
                        .has(candidateNormalized)
                ) {
                    break;
                }

                /*
                 * Also stop if the next line is
                 * "Some Label: value".
                 */
                const nextColon =
                    candidate.match(
                        /^([^:]{2,50})\s*:/,
                    );

                if (
                    nextColon
                    && normalizedKnownLabels
                        .has(
                            normalizeLabel(
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

            if (values.length) {
                put(
                    canonicalLabel,
                    values.join(' '),
                );
            }
        }

        return result;
    });
}

async function getVisibleDialog(page) {
    const candidates = page.locator(
        '.modal:visible, [role="dialog"]:visible',
    );

    const count = await candidates.count();

    for (
        let i = count - 1;
        i >= 0;
        i--
    ) {
        const candidate =
            candidates.nth(i);

        const text = clean(
            await candidate
                .innerText()
                .catch(() => ''),
        );

        if (
            /detail produk/i.test(text)
            || text.length > 20
        ) {
            return candidate;
        }
    }

    return null;
}

async function enrichFromRow(
    page,
    row,
    requestDelayMs,
    crawlerLog,
) {
    try {
        const clickable =
            row.locator(
                'a, button, [role="button"]',
            );

        const clickableCount =
            await clickable.count();

        crawlerLog.debug(
            'Opening BPOM product detail.',
            {
                clickableCount,
            },
        );

        if (clickableCount > 0) {
            /*
             * Registration number / product row
             * normally contains the detail trigger.
             */
            await clickable
                .first()
                .click();
        } else {
            await row.click();
        }

        /*
         * BPOM fills modal content dynamically,
         * so give it some time after click.
         */
        await page.waitForTimeout(
            Math.max(
                800,
                requestDelayMs,
            ),
        );

        const dialog =
            await getVisibleDialog(
                page,
            );

        if (!dialog) {
            crawlerLog.debug(
                'Product detail dialog was not detected.',
            );

            return {};
        }

        await dialog
            .waitFor({
                state: 'visible',
                timeout: 10000,
            })
            .catch(
                () => undefined,
            );

        /*
         * Wait until modal contains more
         * than just its heading.
         */
        await page.waitForFunction(
            () => {
                const dialogs = [
                    ...document.querySelectorAll(
                        '.modal, [role="dialog"]',
                    ),
                ];

                const visible =
                    dialogs.find(
                        (el) => {
                            const rect =
                                el.getBoundingClientRect();

                            const style =
                                window.getComputedStyle(
                                    el,
                                );

                            return (
                                rect.width > 0
                                && rect.height > 0
                                && style.display
                                    !== 'none'
                                && style.visibility
                                    !== 'hidden'
                            );
                        },
                    );

                if (!visible) {
                    return false;
                }

                const text =
                    (
                        visible.innerText
                        || ''
                    )
                        .replace(
                            /\s+/g,
                            ' ',
                        )
                        .trim();

                return text.length > 20;
            },
            {
                timeout: 10000,
            },
        ).catch(
            () => undefined,
        );

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

        crawlerLog.debug(
            'BPOM product detail raw fields.',
            {
                rawPairs,
            },
        );

        const details =
            mapDetails(
                rawPairs,
            );

        crawlerLog.debug(
            'BPOM mapped product details.',
            {
                details,
            },
        );

        /*
         * If nothing useful is extracted,
         * save the modal HTML for diagnosis.
         */
        const hasUsefulDetail =
            Boolean(
                details.composition
                || details.expiryDate
                || details.status
                || details.dosageForm
                || details.applicationDate
                || details.registrationNumber
                || details.productName
                || details.brand,
            );

        if (!hasUsefulDetail) {
            const debugId =
                crypto
                    .createHash('md5')
                    .update(
                        `${Date.now()}-${dialogText}`,
                    )
                    .digest('hex')
                    .slice(
                        0,
                        12,
                    );

            await Actor.setValue(
                `DEBUG_DETAIL_${debugId}`,
                {
                    dialogText,
                    rawPairs,
                    details,
                    html:
                        await dialog
                            .innerHTML()
                            .catch(
                                () => '',
                            ),
                },
            );

            crawlerLog.warning(
                'Detail modal opened but no structured fields could be extracted.',
                {
                    debugKey:
                        `DEBUG_DETAIL_${debugId}`,
                },
            );
        }

        /*
         * Close modal.
         */
        const closeButton =
            await visibleLocator(
                dialog.getByRole(
                    'button',
                    {
                        name:
                            /^(Close|Tutup)$/i,
                    },
                ),
            );

        if (closeButton) {
            await closeButton
                .click()
                .catch(
                    () => undefined,
                );
        } else {
            const xButton =
                dialog.locator(
                    'button.close, .btn-close, [data-dismiss="modal"], [data-bs-dismiss="modal"]',
                );

            if (
                await xButton.count()
            ) {
                await xButton
                    .first()
                    .click()
                    .catch(
                        () => undefined,
                    );
            } else {
                await page.keyboard
                    .press('Escape')
                    .catch(
                        () => undefined,
                    );
            }
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
            .press('Escape')
            .catch(
                () => undefined,
            );

        return {};
    }
}

async function getProductTable(page) {
    const tables = page
        .locator('table')
        .filter({
            hasText: /Nomor Registrasi/i,
        })
        .filter({
            hasText: /Nama Produk/i,
        });

    const tableCount = await tables.count();

    let fallbackTable = null;

    for (let i = 0; i < tableCount; i++) {
        const table = tables.nth(i);

        const isVisible = await table
            .isVisible()
            .catch(() => false);

        if (!isVisible) {
            continue;
        }

        if (!fallbackTable) {
            fallbackTable = table;
        }

        const rowCount = await table
            .locator('tbody tr')
            .count();

        if (rowCount > 0) {
            return table;
        }
    }

    if (fallbackTable) {
        return fallbackTable;
    }

    throw new Error(
        'BPOM product result table was not found.',
    );
}

async function pageDiagnostics(page) {
    return page.evaluate(
        () => ({
            url:
                window.location.href,

            title:
                document.title,

            readyState:
                document.readyState,

            tableCount:
                document.querySelectorAll(
                    'table',
                ).length,

            tables: [
                ...document.querySelectorAll(
                    'table',
                ),
            ].map(
                (table, index) => ({
                    index,

                    headers: [
                        ...table.querySelectorAll(
                            'th',
                        ),
                    ].map(
                        (el) =>
                            (
                                el.textContent
                                || ''
                            )
                                .replace(
                                    /\s+/g,
                                    ' ',
                                )
                                .trim(),
                    ),

                    rowCount:
                        table
                            .querySelectorAll(
                                'tbody tr',
                            )
                            .length,

                    textPreview:
                        (
                            table.textContent
                            || ''
                        )
                            .replace(
                                /\s+/g,
                                ' ',
                            )
                            .trim()
                            .slice(
                                0,
                                500,
                            ),
                }),
            ),

            visibleButtons: [
                ...document.querySelectorAll(
                    'button',
                ),
            ]
                .filter((el) => {
                    const style =
                        window
                            .getComputedStyle(
                                el,
                            );

                    return (
                        style.display
                            !== 'none'
                        && style.visibility
                            !== 'hidden'
                    );
                })
                .map(
                    (el) =>
                        (
                            el.textContent
                            || ''
                        )
                            .replace(
                                /\s+/g,
                                ' ',
                            )
                            .trim(),
                )
                .filter(Boolean)
                .slice(
                    0,
                    30,
                ),

            bodyPreview:
                (
                    document.body
                        ?.innerText
                    || ''
                )
                    .replace(
                        /\s+/g,
                        ' ',
                    )
                    .trim()
                    .slice(
                        0,
                        1500,
                    ),
        }),
    );
}

async function saveDebugArtifacts(
    page,
    job,
    stage,
    logInstance,
) {
    const id = crypto
        .createHash('md5')
        .update(
            `${job.kind}:${job.value}:${stage}`,
        )
        .digest('hex')
        .slice(
            0,
            12,
        );

    const prefix =
        `DEBUG_${stage}_${id}`;

    try {
        const diagnostics =
            await pageDiagnostics(page);

        await Actor.setValue(
            `${prefix}_DIAGNOSTICS`,
            diagnostics,
        );

        const html =
            await page.content();

        await Actor.setValue(
            `${prefix}_PAGE`,
            html,
            {
                contentType:
                    'text/html; charset=utf-8',
            },
        );

        const screenshot =
            await page.screenshot({
                fullPage: true,
            });

        await Actor.setValue(
            `${prefix}_SCREENSHOT`,
            screenshot,
            {
                contentType:
                    'image/png',
            },
        );

        logInstance.info(
            `Saved debug artifacts with prefix ${prefix}.`,
            {
                tableCount:
                    diagnostics.tableCount,

                tables:
                    diagnostics.tables,
            },
        );
    } catch (error) {
        logInstance.warning(
            `Could not save debug artifacts for ${job.kind}=${job.value || '(all)'}.`,
            {
                error:
                    error.message,
            },
        );
    }
}

async function extractCurrentPage(
    page,
    job,
    options,
    crawlerLog,
) {
    const {
        includeDetails,
        maxRemaining,
        requestDelayMs,
    } = options;

    const table =
        await getProductTable(page);

    const rows =
        table.locator(
            'tbody tr',
        );

    const rowCount =
        await rows.count();

    const results = [];

    for (
        let i = 0;
        i < rowCount
            && results.length
                < maxRemaining;
        i++
    ) {
        const row =
            rows.nth(i);

        const cells = await row
    .locator('td')
    .allInnerTexts();

if (cells.length < 3) {
    continue;
}

const normalizedCells =
    cells.map((value) => clean(value));

if (
    /tidak ada data|no data|data tidak/i.test(
        normalizedCells.join(' '),
    )
) {
    continue;
}

const registration =
    parseRegistrationCell(
        cells[1] || '',
    );

const product =
    parseProductCell(
        cells[2] || '',
    );

const registrant =
    parseRegistrantCell(
        cells[3] || '',
    );

const listRecord = {
    productType:
        clean(cells[0])
        || 'KO',

    registrationNumber:
        registration.registrationNumber,

    issuedDate:
        registration.issuedDate,

    productName:
        product.productName,

    brand:
        product.brand,

    packaging:
        product.packaging,

    registrant:
        registrant.registrant,

    registrantLocation:
        registrant.registrantLocation,
};

        const detail =
            includeDetails
                ? await enrichFromRow(
                    page,
                    row,
                    requestDelayMs,
                    crawlerLog,
                )
                : {};

        const record = {
    ...listRecord,

    ...Object.fromEntries(
        Object.entries(
            detail,
        ).filter(
            ([, value]) =>
                clean(value),
        ),
    ),

    registrationNumber:
        clean(
            detail.registrationNumber
            || listRecord.registrationNumber,
        ),

    productName:
        clean(
            detail.productName
            || listRecord.productName,
        ),

    brand:
        clean(
            detail.brand
            || listRecord.brand,
        ),

    packaging:
        clean(
            detail.packaging
            || listRecord.packaging,
        ),

    issuedDate:
        clean(
            detail.issuedDate
            || listRecord.issuedDate,
        ),

    registrant:
        clean(
            detail.registrant
            || listRecord.registrant,
        ),

    registrantLocation:
        clean(
            listRecord.registrantLocation,
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
};

        if (
            !record.registrationNumber
        ) {
            continue;
        }

        results.push(record);
    }

    return results;
}

async function clickNext(
    page,
    requestDelayMs,
    crawlerLog,
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
        || (
            await next
                .getAttribute(
                    'disabled',
                )
        ) !== null
        || (
            await next
                .getAttribute(
                    'aria-disabled',
                )
        ) === 'true';

    if (disabled) {
        return false;
    }

    const before =
        clean(
            await page
                .locator(
                    'table tbody tr',
                )
                .first()
                .innerText()
                .catch(
                    () => '',
                ),
        );

    await next.click();

    await sleep(
        Math.max(
            300,
            requestDelayMs,
        ),
    );

    const changed =
        await page
            .waitForFunction(
                (previous) => {
                    const first =
                        document
                            .querySelector(
                                'table tbody tr',
                            );

                    const current =
                        (
                            first
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

    if (!changed) {
        crawlerLog.debug(
            'Next page did not visibly change; stopping pagination to avoid a loop.',
        );
    }

    return changed;
}

function diffFields(
    previous,
    current,
) {
    const fields = [
        'productName',
        'brand',
        'registrant',
        'packaging',
        'dosageForm',
        'composition',
        'applicationDate',
        'issuedDate',
        'expiryDate',
        'status',
    ];

    return fields.filter(
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
            eventType === 'NEW'
        );
    }

    if (
        mode === 'changes'
    ) {
        return (
            eventType === 'NEW'
            || eventType
                === 'CHANGED'
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
            buildJobs(input);

        const maxItemsPerQuery =
            Number(
                input.maxItemsPerQuery
                ?? 100,
            );

        const maxPagesPerQuery =
            Number(
                input.maxPagesPerQuery
                ?? 20,
            );

        const includeDetails =
            input.includeDetails
            !== false;

        const detectChanges =
            input.detectChanges
            !== false;

        const emit =
            input.emit
            ?? 'all';

        const requestDelayMs =
            Number(
                input.requestDelayMs
                ?? 500,
            );

        const debug =
            Boolean(
                input.debug,
            );

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

                includeDetails,

                detectChanges,

                emit,

                maxItemsPerQuery,

                maxPagesPerQuery,

                debug,
            },
        );

        log.info(
            `Starting ${jobs.length} BPOM cosmetics query job(s).`,
        );

        const collected =
            new Map();

        const failedJobs = [];

        const crawler =
            new PlaywrightCrawler({
                maxConcurrency:
                    1,

                requestHandlerTimeoutSecs:
                    240,

                navigationTimeoutSecs:
                    60,

                maxRequestRetries:
                    2,

                launchContext: {
                    launchOptions: {
                        headless:
                            true,
                    },
                },

                async requestHandler({
                    page,
                    request,
                    log: crawlerLog,
                }) {
                    const job =
                        request
                            .userData
                            .job;

                    crawlerLog.info(
                        `Querying BPOM: ${job.kind}=${job.value || '(all)'}`,
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

                    if (debug) {
                        const diagnostics =
                            await pageDiagnostics(
                                page,
                            );

                        crawlerLog.info(
                            'BPOM page diagnostics after filter.',
                            diagnostics,
                        );
                    }

                    let pageNumber =
                        1;

                    let queryCount =
                        0;

                    while (
                        pageNumber
                            <= maxPagesPerQuery
                        && queryCount
                            < maxItemsPerQuery
                    ) {
                        const items =
                            await extractCurrentPage(
                                page,
                                job,
                                {
                                    includeDetails,

                                    maxRemaining:
                                        maxItemsPerQuery
                                        - queryCount,

                                    requestDelayMs,
                                },
                                crawlerLog,
                            );

                        for (
                            const item
                            of items
                        ) {
                            queryCount +=
                                1;

                            const key =
                                item.registrationNumber;

                            const existing =
                                collected.get(
                                    key,
                                );

                            if (!existing) {
                                collected.set(
                                    key,
                                    item,
                                );
                            } else {
                                const matches =
                                    Array.isArray(
                                        existing.matches,
                                    )
                                        ? existing.matches
                                        : [
                                            existing.matchedBy,
                                        ].filter(
                                            Boolean,
                                        );

                                matches.push(
                                    item.matchedBy,
                                );

                                collected.set(
                                    key,
                                    {
                                        ...existing,
                                        matches,
                                    },
                                );
                            }

                            if (
                                queryCount
                                    >= maxItemsPerQuery
                            ) {
                                break;
                            }
                        }

                        if (
                            queryCount
                                >= maxItemsPerQuery
                        ) {
                            break;
                        }

                        const moved =
                            await clickNext(
                                page,
                                requestDelayMs,
                                crawlerLog,
                            );

                        if (!moved) {
                            break;
                        }

                        pageNumber +=
                            1;
                    }

                    if (
                        queryCount === 0
                        && debug
                    ) {
                        await saveDebugArtifacts(
                            page,
                            job,
                            'ZERO_RESULTS',
                            crawlerLog,
                        );
                    }

                    crawlerLog.info(
                        `Collected ${queryCount} row(s) for ${job.kind}=${job.value || '(all)'}.`,
                    );
                },

                async failedRequestHandler(
                    {
                        request,
                        log: crawlerLog,
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

                    crawlerLog.error(
                        `Query failed: ${job.kind}=${job.value || '(all)'}`,
                        {
                            error:
                                error?.message,
                        },
                    );

                    if (debug) {
                        const key =
                            `DEBUG_FAILED_${
                                crypto
                                    .createHash(
                                        'md5',
                                    )
                                    .update(
                                        request.uniqueKey,
                                    )
                                    .digest(
                                        'hex',
                                    )
                            }`;

                        await Actor.setValue(
                            key,
                            {
                                url:
                                    request.url,

                                job,

                                error:
                                    error?.message
                                    || String(error),

                                at:
                                    isoNow(),
                            },
                        );
                    }
                },
            });

        const requests =
            jobs.map(
                (job) => ({
                    url:
                        BASE_URL,

                    uniqueKey:
                        `${job.kind}:${job.value || 'all'}`,

                    userData: {
                        job,
                    },
                }),
            );

        await crawler.run(
            requests,
        );

        const stateStoreName =
            clean(
                input.stateStoreName
                || 'indonesian-cosmetics-intelligence-state',
            );

        const stateKey =
            clean(
                input.stateKey
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

        const previousState =
            detectChanges
                ? (
                    await stateStore
                        .getValue(
                            `SNAPSHOT_${stateKey}`,
                        )
                    ?? {
                        version:
                            SNAPSHOT_VERSION,

                        records:
                            {},
                    }
                )
                : {
                    version:
                        SNAPSHOT_VERSION,

                    records:
                        {},
                };

        const previousRecords =
            previousState.records
            ?? {};

        const nextRecords = {};

        let newCount =
            0;

        let changedCount =
            0;

        let unchangedCount =
            0;

        let emittedCount =
            0;

        for (
            const record
            of collected.values()
        ) {
            const id =
                record.registrationNumber;

            const hash =
                stableHash(record);

            const previousEntry =
                previousRecords[id];

            let eventType =
                'UNCHANGED';

            let changedFields =
                [];

            let previous =
                undefined;

            if (
                !detectChanges
                || !previousEntry
            ) {
                eventType =
                    'NEW';
            } else if (
                previousEntry.hash
                    !== hash
            ) {
                eventType =
                    'CHANGED';

                previous =
                    previousEntry.record;

                changedFields =
                    diffFields(
                        previousEntry.record,
                        record,
                    );
            }

            if (
                eventType
                === 'NEW'
            ) {
                newCount +=
                    1;
            } else if (
                eventType
                === 'CHANGED'
            ) {
                changedCount +=
                    1;
            } else {
                unchangedCount +=
                    1;
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
                await Actor.pushData(
                    output,
                );

                emittedCount +=
                    1;
            }

            nextRecords[id] = {
                hash,
                record,
            };
        }

        if (
            detectChanges
            && failedJobs.length === 0
        ) {
            await stateStore
                .setValue(
                    `SNAPSHOT_${stateKey}`,
                    {
                        version:
                            SNAPSHOT_VERSION,

                        updatedAt:
                            isoNow(),

                        records:
                            nextRecords,
                    },
                );
        } else if (
            detectChanges
            && failedJobs.length > 0
        ) {
            log.warning(
                'Snapshot was NOT updated because one or more query jobs failed. This prevents false change baselines.',
            );
        }

        const summary = {
            totalUniqueRecords:
                collected.size,

            emittedRecords:
                emittedCount,

            newRecords:
                newCount,

            changedRecords:
                changedCount,

            unchangedRecords:
                unchangedCount,

            queryJobs:
                jobs.length,

            failedJobs,

            snapshotUpdated:
                detectChanges
                && failedJobs.length === 0,

            stateStoreName,

            stateKey,

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
