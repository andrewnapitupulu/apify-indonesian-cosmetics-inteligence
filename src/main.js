import crypto from 'node:crypto';
import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const BASE_URL = 'https://cekbpom.pom.go.id/produk-kosmetika';
const SNAPSHOT_VERSION = 7;
const ACTOR_VERSION = '0.2.6-r3-teams2';
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

    if (!text) {
        return '';
    }

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
        registrant:
            sanitizeRegistrant(
                record.registrant,
            ),
        cosmeticsManufacturer:
            sanitizeCosmeticsManufacturer(
                record.cosmeticsManufacturer,
            ),
    };
}

function parseRegistrationCell(value) {
    const text =
        clean(value);

    return {
        registrationNumber:
            text.match(
                /\b[A-Z]{2,3}\d{8,}\b/i,
            )?.[0]
            || '',
        issuedDate:
            text.match(
                /Terbit\s*:\s*(\d{4}-\d{2}-\d{2})/i,
            )?.[1]
            || '',
    };
}

function parseProductCell(value) {
    const lines =
        textLines(value);

    let brand = '';
    let packaging = '';

    const productNameLines = [];

    for (
        const line
        of lines
    ) {
        if (
            /^Merk\s*:/i.test(
                line,
            )
        ) {
            brand =
                clean(
                    line.replace(
                        /^Merk\s*:/i,
                        '',
                    ),
                );
        } else if (
            /^Merek\s*:/i.test(
                line,
            )
        ) {
            brand =
                clean(
                    line.replace(
                        /^Merek\s*:/i,
                        '',
                    ),
                );
        } else if (
            /^Kemasan\s*:/i.test(
                line,
            )
        ) {
            packaging =
                clean(
                    line.replace(
                        /^Kemasan\s*:/i,
                        '',
                    ),
                );
        } else {
            productNameLines
                .push(
                    line,
                );
        }
    }

    const fullText =
        clean(value);

    if (!brand) {
        brand =
            fullText.match(
                /Merk\s*:\s*(.*?)(?=Kemasan\s*:|$)/i,
            )?.[1]?.trim()
            || '';
    }

    if (!packaging) {
        packaging =
            fullText.match(
                /Kemasan\s*:\s*(.*)$/i,
            )?.[1]?.trim()
            || '';
    }

    return {
        productName:
            clean(
                productNameLines
                    .join(' ')
                    .replace(
                        /Merk\s*:.*$/i,
                        '',
                    )
                    .replace(
                        /Merek\s*:.*$/i,
                        '',
                    ),
            ),
        brand:
            clean(
                brand,
            ),
        packaging:
            clean(
                packaging,
            ),
    };
}

function parseRegistrantCell(value) {
    const lines =
        textLines(value);

    if (
        lines.length >= 2
    ) {
        return {
            registrant:
                sanitizeRegistrant(
                    lines[0],
                ),
            registrantLocation:
                clean(
                    lines
                        .slice(1)
                        .join(' '),
                ),
        };
    }

    return {
        registrant:
            sanitizeRegistrant(
                value,
            ),
        registrantLocation:
            '',
    };
}

function hashFields(record, fields) {
    const payload =
        Object.fromEntries(
            fields.map(
                (key) => [
                    key,
                    clean(
                        record?.[key],
                    ),
                ],
            ),
        );

    return crypto
        .createHash(
            'sha256',
        )
        .update(
            JSON.stringify(
                payload,
            ),
        )
        .digest(
            'hex',
        );
}

function stableHash(record) {
    return hashFields(
        record,
        [
            ...LISTING_FIELDS,
            ...DETAIL_FIELDS,
        ],
    );
}

function basicHash(record) {
    return hashFields(
        record,
        LISTING_FIELDS,
    );
}

function detailHash(record) {
    return hashFields(
        record,
        DETAIL_FIELDS,
    );
}

function inferDetailKnown(record = {}) {
    return DETAIL_FIELDS
        .some(
            (field) =>
                clean(
                    record[field],
                )
                !== '',
        );
}

function previousKnownDetailFields(previousEntry) {
    if (!previousEntry) {
        return new Set();
    }

    if (
        Array.isArray(
            previousEntry
                .detailKnownFields,
        )
    ) {
        return new Set(
            previousEntry
                .detailKnownFields
                .filter(
                    (field) =>
                        DETAIL_FIELDS
                            .includes(
                                field,
                            ),
                ),
        );
    }

    const record =
        canonicalizeLegacyRecord(
            previousEntry.record
            ?? {},
        );

    return new Set(
        DETAIL_FIELDS
            .filter(
                (field) =>
                    clean(
                        record[field],
                    )
                    !== '',
            ),
    );
}

function previousDetailKnown(previousEntry) {
    if (!previousEntry) {
        return false;
    }

    if (
        typeof previousEntry
            .detailKnown
        === 'boolean'
    ) {
        return previousEntry
            .detailKnown;
    }

    return (
        previousKnownDetailFields(
            previousEntry,
        ).size > 0
        || inferDetailKnown(
            canonicalizeLegacyRecord(
                previousEntry.record
                ?? {},
            ),
        )
    );
}

function validIsoTimestamp(value) {
    const text =
        clean(value);

    return (
        text
        && Number.isFinite(
            Date.parse(
                text,
            ),
        )
    );
}

function resolvePreviousDetailFetchedAt(
    previousEntry,
    legacyStateUpdatedAt = '',
) {
    const direct =
        clean(
            previousEntry
                ?.lastDetailFetchedAt,
        );

    if (
        validIsoTimestamp(
            direct,
        )
    ) {
        return direct;
    }

    if (
        previousDetailKnown(
            previousEntry,
        )
        && validIsoTimestamp(
            legacyStateUpdatedAt,
        )
    ) {
        return clean(
            legacyStateUpdatedAt,
        );
    }

    return '';
}

function detailAgeDays(
    lastDetailFetchedAt,
    referenceIso,
) {
    if (
        !validIsoTimestamp(
            lastDetailFetchedAt,
        )
        || !validIsoTimestamp(
            referenceIso,
        )
    ) {
        return null;
    }

    const ageMs =
        Date.parse(
            referenceIso,
        )
        - Date.parse(
            lastDetailFetchedAt,
        );

    return Math.floor(
        ageMs
        / DAY_MS,
    );
}

function normalizeKey(label) {
    return clean(
        label,
    )
        .toLowerCase()
        .normalize(
            'NFKD',
        )
        .replace(
            /[^a-z0-9]+/g,
            ' ',
        )
        .trim();
}

function mapDetails(raw = {}) {
    const normalized =
        Object.fromEntries(
            Object.entries(
                raw,
            )
                .map(
                    (
                        [
                            key,
                            value,
                        ],
                    ) => [
                        normalizeKey(
                            key,
                        ),
                        clean(
                            value,
                        ),
                    ],
                ),
        );

    const pick = (
        ...candidates
    ) => {
        for (
            const candidate
            of candidates
        ) {
            const target =
                normalizeKey(
                    candidate,
                );

            if (
                normalized[
                    target
                ]
            ) {
                return normalized[
                    target
                ];
            }

            const fuzzy =
                Object.entries(
                    normalized,
                )
                    .find(
                        ([key]) =>
                            key
                                .includes(
                                    target,
                                )
                            || target
                                .includes(
                                    key,
                                ),
                    );

            if (
                fuzzy?.[1]
            ) {
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
            pick(
                'nama produk',
            ),

        brand:
            pick(
                'merk',
                'merek',
            ),

        packaging:
            pick(
                'kemasan',
            ),

        dosageForm:
            pick(
                'bentuk sediaan',
            ),

        composition:
            pick(
                'komposisi',
            ),

        applicationDate:
            pick(
                'tanggal permohonan',
            ),

        issuedDate:
            pick(
                'tanggal terbit',
            ),

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
            sanitizeCosmeticsManufacturer(
                pick(
                    'industri kosmetika',
                ),
            ),

        primaryPackagingManufacturer:
            pick(
                'industri pengemas primer',
            ),

        secondaryPackagingManufacturer:
            pick(
                'industri pengemas sekunder',
            ),

        kits:
            pick(
                'kits',
            ),

        issuedBy:
            pick(
                'diterbitkan oleh',
            ),

        status:
            pick(
                'status',
            ),
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
            of values
            || []
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

    if (
        !jobs.length
    ) {
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
                        )
                            .toLowerCase(),
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
        .createHash(
            'sha256',
        )
        .update(
            JSON.stringify(
                normalized,
            ),
        )
        .digest(
            'hex',
        );
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

function issuedAgeDays(
    issuedDate,
    referenceIso,
) {
    const value =
        clean(
            issuedDate,
        );

    if (
        !/^\d{4}-\d{2}-\d{2}$/
            .test(
                value,
            )
    ) {
        return null;
    }

    const issuedMs =
        Date.parse(
            `${value}T00:00:00Z`,
        );

    const referenceMs =
        Date.parse(
            referenceIso,
        );

    if (
        !Number.isFinite(
            issuedMs,
        )
        || !Number.isFinite(
            referenceMs,
        )
    ) {
        return null;
    }

    return Math.floor(
        (
            referenceMs
            - issuedMs
        )
        / DAY_MS,
    );
}

function isoDateOnly(value) {
    return clean(
        value,
    )
        .match(
            /^(\d{4}-\d{2}-\d{2})/,
        )?.[1]
        || '';
}

function compareDateOnly(
    left,
    right,
) {
    const a =
        isoDateOnly(
            left,
        );

    const b =
        isoDateOnly(
            right,
        );

    if (
        !a
        || !b
    ) {
        return null;
    }

    if (
        a === b
    ) {
        return 0;
    }

    return (
        a < b
            ? -1
            : 1
    );
}

function earliestFirstSeenAt(records = {}) {
    const values =
        Object.values(
            records,
        )
            .map(
                (entry) =>
                    clean(
                        entry
                            ?.firstSeenAt
                        || entry
                            ?.record
                            ?.scrapedAt,
                    ),
            )
            .filter(
                (value) =>
                    Number.isFinite(
                        Date.parse(
                            value,
                        ),
                    ),
            )
            .sort(
                (a, b) =>
                    Date.parse(
                        a,
                    )
                    - Date.parse(
                        b,
                    ),
            );

    return values[0]
        || '';
}

function previousObservationCount(previousEntry) {
    if (!previousEntry) {
        return 0;
    }

    const value =
        Number(
            previousEntry
                .observationCount,
        );

    return (
        Number.isFinite(
            value,
        )
        && value >= 0
            ? value
            : 1
    );
}

function previousConsecutiveMisses(previousEntry) {
    const value =
        Number(
            previousEntry
                ?.consecutiveMisses,
        );

    return (
        Number.isFinite(
            value,
        )
        && value >= 0
            ? value
            : 0
    );
}

function diffFields(
    previous,
    current,
    fields,
) {
    return fields
        .filter(
            (key) =>
                clean(
                    previous
                        ?.[key],
                )
                !== clean(
                    current
                        ?.[key],
                ),
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
    return DETAIL_FIELDS
        .filter(
            (key) =>
                previousKnownFields
                    .has(
                        key,
                    )
                && currentKnownFields
                    .has(
                        key,
                    )
                && clean(
                    previous
                        ?.[key],
                )
                !== clean(
                    current
                        ?.[key],
                ),
        );
}

function calculateEnrichedFields(
    previous,
    current,
    previousKnownFields,
    currentKnownFields,
) {
    return DETAIL_FIELDS
        .filter(
            (key) =>
                !previousKnownFields
                    .has(
                        key,
                    )
                && currentKnownFields
                    .has(
                        key,
                    )
                && Boolean(
                    clean(
                        current
                            ?.[key],
                    ),
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
        return (
            eventType
            === 'NEW'
            || eventType
            === 'CHANGED'
        );
    }

    return true;
}

function normalizeMatchText(value) {
    return clean(
        value,
    )
        .toLowerCase()
        .normalize(
            'NFKD',
        )
        .replace(
            /[\u0300-\u036f]/g,
            '',
        )
        .replace(
            /[^a-z0-9]+/g,
            ' ',
        )
        .trim();
}

function normalizeRegistrationNumber(value) {
    return clean(
        value,
    )
        .toUpperCase()
        .replace(
            /[^A-Z0-9]/g,
            '',
        );
}

function evaluateJobMatch(
    record,
    job,
) {
    const expectedText =
        normalizeMatchText(
            job?.value,
        );

    if (
        !expectedText
    ) {
        return {
            verifiable:
                false,
            matches:
                true,
        };
    }

    if (
        job.kind
        === 'registrationNumber'
    ) {
        const actual =
            normalizeRegistrationNumber(
                record
                    ?.registrationNumber,
            );

        const expected =
            normalizeRegistrationNumber(
                job.value,
            );

        return {
            verifiable:
                Boolean(
                    actual,
                ),
            matches:
                Boolean(
                    actual,
                )
                && actual
                    === expected,
        };
    }

    const fieldByKind = {
        brand:
            'brand',
        registrant:
            'registrant',
        productName:
            'productName',
        composition:
            'composition',
    };

    const field =
        fieldByKind[
            job.kind
        ];

    if (!field) {
        return {
            verifiable:
                false,
            matches:
                true,
        };
    }

    const actualText =
        normalizeMatchText(
            record?.[field],
        );

    if (
        !actualText
    ) {
        return {
            verifiable:
                false,
            matches:
                true,
        };
    }

    if (
        job.kind
        === 'brand'
    ) {
        return {
            verifiable:
                true,
            matches:
                actualText
                === expectedText,
        };
    }

    return {
        verifiable:
            true,
        matches:
            actualText
                .includes(
                    expectedText,
                ),
    };
}

function recordMatchesAnyJobConservatively(
    record,
    jobs,
) {
    let hasUnverifiableJob =
        false;

    for (
        const job
        of jobs
    ) {
        const result =
            evaluateJobMatch(
                record,
                job,
            );

        if (
            result.verifiable
            && result.matches
        ) {
            return true;
        }

        if (
            !result.verifiable
        ) {
            hasUnverifiableJob =
                true;
        }
    }

    return hasUnverifiableJob;
}

function addSourceFilterMismatch(
    sourceFilterStats,
    job,
    record,
    stage,
) {
    sourceFilterStats
        .mismatchedRows++;

    if (
        sourceFilterStats
            .mismatchSamples
            .length < 25
    ) {
        sourceFilterStats
            .mismatchSamples
            .push({
                stage,

                jobKind:
                    job.kind,

                expected:
                    job.value,

                registrationNumber:
                    clean(
                        record
                            ?.registrationNumber,
                    ),

                brand:
                    clean(
                        record
                            ?.brand,
                    ),

                productName:
                    clean(
                        record
                            ?.productName,
                    ),

                registrant:
                    clean(
                        record
                            ?.registrant,
                    ),
            });
    }
}

const TEAMS_CHANGE_FIELD_LABELS = {
    issuedDate:
        'Issued Date',

    productName:
        'Product Name',

    brand:
        'Brand',

    packaging:
        'Packaging',

    registrant:
        'Registrant',

    registrantLocation:
        'Registrant Location',

    composition:
        'Composition',

    cosmeticsManufacturer:
        'Manufacturer',

    primaryPackagingManufacturer:
        'Primary Packaging Manufacturer',

    secondaryPackagingManufacturer:
        'Secondary Packaging Manufacturer',

    kits:
        'Kits',

    issuedBy:
        'Issued By',

    dosageForm:
        'Dosage Form',

    applicationDate:
        'Application Date',

    expiryDate:
        'Expiry Date',

    status:
        'Status',
};

const TEAMS_MAX_CHANGE_BLOCKS = 5;

function cardText(
    value,
    fallback = 'N/A',
    maxLength = 900,
) {
    const cleanedValue =
        clean(
            value,
        );

    const unavailable =
        !cleanedValue
        || /^[-–—•]+$/
            .test(
                cleanedValue,
            )
        || /^(?:n\/?a|null|undefined)$/i
            .test(
                cleanedValue,
            );

    const textValue =
        unavailable
            ? fallback
            : cleanedValue;

    if (
        textValue.length
        <= maxLength
    ) {
        return textValue;
    }

    return `${
        textValue.slice(
            0,
            maxLength - 1,
        )
    }…`;
}

function formatDateForCard(value) {
    const match =
        clean(
            value,
        )
            .match(
                /^(\d{4})-(\d{2})-(\d{2})$/,
            );

    if (!match) {
        return cardText(
            value,
        );
    }

    const months = [
        'Jan',
        'Feb',
        'Mar',
        'Apr',
        'May',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Oct',
        'Nov',
        'Dec',
    ];

    const monthIndex =
        Number(
            match[2],
        )
        - 1;

    if (
        monthIndex < 0
        || monthIndex
            >= months.length
    ) {
        return cardText(
            value,
        );
    }

    return `${
        match[3]
    } ${
        months[
            monthIndex
        ]
    } ${
        match[1]
    }`;
}

function formatJakartaTimestamp(value) {
    const date =
        new Date(
            value
            || Date.now(),
        );

    if (
        !Number.isFinite(
            date.getTime(),
        )
    ) {
        return cardText(
            value,
        );
    }

    const parts =
        new Intl
            .DateTimeFormat(
                'en-GB',
                {
                    timeZone:
                        'Asia/Jakarta',

                    day:
                        '2-digit',

                    month:
                        'short',

                    year:
                        'numeric',

                    hour:
                        '2-digit',

                    minute:
                        '2-digit',

                    hourCycle:
                        'h23',
                },
            )
            .formatToParts(
                date,
            );

    const values =
        Object.fromEntries(
            parts
                .filter(
                    (part) =>
                        part.type
                        !== 'literal',
                )
                .map(
                    (part) => [
                        part.type,
                        part.value,
                    ],
                ),
        );

    return `${
        values.day
    } ${
        values.month
    } ${
        values.year
    } • ${
        values.hour
    }:${
        values.minute
    } WIB`;
}

function buildNewAdaptiveCard(record) {
    return {
        $schema:
            'http://adaptivecards.io/schemas/adaptive-card.json',

        type:
            'AdaptiveCard',

        version:
            '1.2',

        body: [
            {
                type:
                    'Container',

                items: [
                    {
                        type:
                            'TextBlock',

                        text:
                            'NEW COSMETICS REGISTRATION',

                        weight:
                            'Bolder',

                        size:
                            'Medium',

                        color:
                            'Good',

                        wrap:
                            true,
                    },
                    {
                        type:
                            'TextBlock',

                        text:
                            'New BPOM cosmetics registration detected',

                        isSubtle:
                            true,

                        spacing:
                            'Small',

                        wrap:
                            true,
                    },
                ],
            },
            {
                type:
                    'Container',

                separator:
                    true,

                spacing:
                    'Medium',

                items: [
                    {
                        type:
                            'TextBlock',

                        text:
                            cardText(
                                record.brand,
                                'UNKNOWN BRAND',
                            ),

                        weight:
                            'Bolder',

                        size:
                            'Large',

                        wrap:
                            true,
                    },
                    {
                        type:
                            'TextBlock',

                        text:
                            cardText(
                                record.productName,
                                'Unnamed product',
                            ),

                        weight:
                            'Bolder',

                        wrap:
                            true,

                        spacing:
                            'Small',
                    },
                ],
            },
            {
                type:
                    'FactSet',

                spacing:
                    'Medium',

                facts: [
                    {
                        title:
                            'NIE',

                        value:
                            cardText(
                                record
                                    .registrationNumber,
                            ),
                    },
                    {
                        title:
                            'Issued Date',

                        value:
                            formatDateForCard(
                                record
                                    .issuedDate,
                            ),
                    },
                    {
                        title:
                            'Registrant',

                        value:
                            cardText(
                                record
                                    .registrant,
                            ),
                    },
                    {
                        title:
                            'Manufacturer',

                        value:
                            cardText(
                                record
                                    .cosmeticsManufacturer,
                            ),
                    },
                    {
                        title:
                            'Packaging',

                        value:
                            cardText(
                                record
                                    .packaging,
                            ),
                    },
                ],
            },
            {
                type:
                    'Container',

                separator:
                    true,

                spacing:
                    'Medium',

                items: [
                    {
                        type:
                            'TextBlock',

                        text:
                            'Detected',

                        size:
                            'Small',

                        isSubtle:
                            true,

                        weight:
                            'Bolder',
                    },
                    {
                        type:
                            'TextBlock',

                        text:
                            formatJakartaTimestamp(
                                record
                                    .detectedAt,
                            ),

                        size:
                            'Small',

                        isSubtle:
                            true,

                        spacing:
                            'None',
                    },
                ],
            },
        ],
    };
}

function buildChangeBlock(
    field,
    previousRecord,
    currentRecord,
    {
        separator = false,
    } = {},
) {
    const label =
        TEAMS_CHANGE_FIELD_LABELS[
            field
        ]
        || field;

    const previousValue =
        cardText(
            previousRecord
                ?.[field],
            '-',
        );

    const currentValue =
        cardText(
            currentRecord
                ?.[field],
            '-',
        );

    const content = [
        {
            type:
                'TextBlock',

            text:
                label,

            weight:
                'Bolder',

            spacing:
                separator
                    ? 'None'
                    : 'Medium',

            wrap:
                true,
        },
        {
            type:
                'ColumnSet',

            spacing:
                'Small',

            columns: [
                {
                    type:
                        'Column',

                    width:
                        'stretch',

                    items: [
                        {
                            type:
                                'TextBlock',

                            text:
                                'Previous',

                            size:
                                'Small',

                            isSubtle:
                                true,
                        },
                        {
                            type:
                                'TextBlock',

                            text:
                                previousValue,

                            wrap:
                                true,

                            isSubtle:
                                true,

                            spacing:
                                'Small',
                        },
                    ],
                },
                {
                    type:
                        'Column',

                    width:
                        'stretch',

                    items: [
                        {
                            type:
                                'TextBlock',

                            text:
                                'Current',

                            size:
                                'Small',

                            isSubtle:
                                true,
                        },
                        {
                            type:
                                'TextBlock',

                            text:
                                currentValue,

                            wrap:
                                true,

                            weight:
                                'Bolder',

                            spacing:
                                'Small',
                        },
                    ],
                },
            ],
        },
    ];

    if (!separator) {
        return content;
    }

    return [
        {
            type:
                'Container',

            separator:
                true,

            spacing:
                'Medium',

            items:
                content,
        },
    ];
}

function buildChangedAdaptiveCard(record) {
    const changedFields =
        Array.isArray(
            record
                .changedFields,
        )
            ? record
                .changedFields
                .filter(
                    Boolean,
                )
            : [];

    const visibleChangedFields =
        changedFields
            .slice(
                0,
                TEAMS_MAX_CHANGE_BLOCKS,
            );

    const hiddenChangeCount =
        Math.max(
            0,
            changedFields.length
            - visibleChangedFields
                .length,
        );

    const changeItems = [
        {
            type:
                'TextBlock',

            text:
                'CHANGES DETECTED',

            weight:
                'Bolder',

            size:
                'Small',

            color:
                'Warning',
        },
    ];

    visibleChangedFields
        .forEach(
            (
                field,
                index,
            ) => {
                changeItems
                    .push(
                        ...buildChangeBlock(
                            field,
                            record.previous
                            ?? {},
                            record,
                            {
                                separator:
                                    index > 0,
                            },
                        ),
                    );
            },
        );

    if (
        hiddenChangeCount > 0
    ) {
        changeItems
            .push({
                type:
                    'TextBlock',

                text:
                    `+ ${hiddenChangeCount} additional changed field(s) are available in the Actor dataset.`,

                isSubtle:
                    true,

                size:
                    'Small',

                wrap:
                    true,

                spacing:
                    'Medium',
            });
    }

    return {
        $schema:
            'http://adaptivecards.io/schemas/adaptive-card.json',

        type:
            'AdaptiveCard',

        version:
            '1.2',

        body: [
            {
                type:
                    'Container',

                items: [
                    {
                        type:
                            'TextBlock',

                        text:
                            'COSMETICS REGISTRATION CHANGED',

                        weight:
                            'Bolder',

                        size:
                            'Medium',

                        color:
                            'Warning',

                        wrap:
                            true,
                    },
                    {
                        type:
                            'TextBlock',

                        text:
                            'Changes detected in an existing BPOM registration',

                        isSubtle:
                            true,

                        spacing:
                            'Small',

                        wrap:
                            true,
                    },
                ],
            },
            {
                type:
                    'Container',

                separator:
                    true,

                spacing:
                    'Medium',

                items: [
                    {
                        type:
                            'TextBlock',

                        text:
                            cardText(
                                record.brand,
                                'UNKNOWN BRAND',
                            ),

                        weight:
                            'Bolder',

                        size:
                            'Large',

                        wrap:
                            true,
                    },
                    {
                        type:
                            'TextBlock',

                        text:
                            cardText(
                                record.productName,
                                'Unnamed product',
                            ),

                        weight:
                            'Bolder',

                        wrap:
                            true,

                        spacing:
                            'Small',
                    },
                    {
                        type:
                            'FactSet',

                        spacing:
                            'Medium',

                        facts: [
                            {
                                title:
                                    'NIE',

                                value:
                                    cardText(
                                        record
                                            .registrationNumber,
                                    ),
                            },
                            {
                                title:
                                    'Issued Date',

                                value:
                                    formatDateForCard(
                                        record
                                            .issuedDate,
                                    ),
                            },
                        ],
                    },
                ],
            },
            {
                type:
                    'Container',

                separator:
                    true,

                spacing:
                    'Medium',

                items:
                    changeItems,
            },
            {
                type:
                    'Container',

                separator:
                    true,

                spacing:
                    'Medium',

                items: [
                    {
                        type:
                            'TextBlock',

                        text:
                            'Detected',

                        size:
                            'Small',

                        isSubtle:
                            true,

                        weight:
                            'Bolder',
                    },
                    {
                        type:
                            'TextBlock',

                        text:
                            formatJakartaTimestamp(
                                record
                                    .detectedAt,
                            ),

                        size:
                            'Small',

                        isSubtle:
                            true,

                        spacing:
                            'None',
                    },
                ],
            },
        ],
    };
}

function buildTeamsWebhookPayload(record) {
    const card =
        record.eventType
        === 'NEW'
            ? buildNewAdaptiveCard(
                record,
            )
            : buildChangedAdaptiveCard(
                record,
            );

    return {
        type:
            'message',

        attachments: [
            {
                contentType:
                    'application/vnd.microsoft.card.adaptive',

                contentUrl:
                    null,

                content:
                    card,
            },
        ],
    };
}

async function postTeamsNotification(
    webhookUrl,
    record,
    teamsStats,
) {
    teamsStats
        .attempted++;

    const maxAttempts = 3;

    let lastError = '';

    for (
        let attempt = 1;
        attempt <= maxAttempts;
        attempt++
    ) {
        if (
            attempt > 1
        ) {
            teamsStats
                .retries++;
        }

        const controller =
            new AbortController();

        const timeout =
            setTimeout(
                () =>
                    controller
                        .abort(),
                15000,
            );

        try {
            const response =
                await fetch(
                    webhookUrl,
                    {
                        method:
                            'POST',

                        headers: {
                            'Content-Type':
                                'application/json',
                        },

                        body:
                            JSON.stringify(
                                buildTeamsWebhookPayload(
                                    record,
                                ),
                            ),

                        signal:
                            controller
                                .signal,
                    },
                );

            const responseText =
                await response
                    .text()
                    .catch(
                        () => '',
                    );

            if (
                response.ok
            ) {
                teamsStats
                    .succeeded++;

                log.info(
                    'Teams notification delivered.',
                    {
                        eventType:
                            record
                                .eventType,

                        registrationNumber:
                            record
                                .registrationNumber,

                        attempt,
                    },
                );

                return true;
            }

            lastError =
                `HTTP ${response.status}`
                + (
                    responseText
                        ? ` - ${cardText(
                            responseText,
                            '',
                            300,
                        )}`
                        : ''
                );

            const retryable =
                response.status
                === 429
                || response.status
                >= 500;

            if (
                !retryable
                || attempt
                >= maxAttempts
            ) {
                break;
            }

            let retryDelayMs =
                1000
                * attempt;

            if (
                response.status
                === 429
            ) {
                const retryAfter =
                    Number(
                        response
                            .headers
                            .get(
                                'retry-after',
                            ),
                    );

                if (
                    Number.isFinite(
                        retryAfter,
                    )
                    && retryAfter > 0
                ) {
                    retryDelayMs =
                        Math.min(
                            retryAfter
                            * 1000,
                            15000,
                        );
                }
            }

            await sleep(
                retryDelayMs,
            );
        } catch (error) {
            lastError =
                error?.name
                === 'AbortError'
                    ? 'Request timed out after 15 seconds.'
                    : (
                        error
                            ?.message
                        || String(
                            error,
                        )
                    );

            if (
                attempt
                >= maxAttempts
            ) {
                break;
            }

            await sleep(
                1000
                * attempt,
            );
        } finally {
            clearTimeout(
                timeout,
            );
        }
    }

    teamsStats
        .failed++;

    if (
        teamsStats
            .failureSamples
            .length < 20
    ) {
        teamsStats
            .failureSamples
            .push({
                eventType:
                    record
                        .eventType,

                registrationNumber:
                    record
                        .registrationNumber,

                error:
                    lastError,
            });
    }

    log.error(
        'Teams notification delivery failed.',
        {
            eventType:
                record
                    .eventType,

            registrationNumber:
                record
                    .registrationNumber,

            error:
                lastError,
        },
    );

    return false;
}

async function visibleLocator(locator) {
    const count =
        await locator
            .count();

    for (
        let i =
            count - 1;
        i >= 0;
        i--
    ) {
        const item =
            locator
                .nth(
                    i,
                );

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
            .locator(
                'table',
            )
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
        await tables
            .count();

    for (
        let i = 0;
        i < count;
        i++
    ) {
        const table =
            tables
                .nth(
                    i,
                );

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

    if (
        fallback
    ) {
        return fallback;
    }

    throw new Error(
        'BPOM product result table was not found.',
    );
}

async function waitForTable(page) {
    await page
        .waitForSelector(
            'table',
            {
                timeout:
                    30000,
            },
        );

    await page
        .waitForFunction(
            () =>
                [
                    ...document
                        .querySelectorAll(
                            'table',
                        ),
                ]
                    .some(
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
                                    .test(
                                        headers,
                                    )
                                || !/Nama Produk/i
                                    .test(
                                        headers,
                                    )
                            ) {
                                return false;
                            }

                            const rows =
                                table
                                    .querySelectorAll(
                                        'tbody tr',
                                    );

                            if (
                                rows.length
                                > 0
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

                            return /tidak ada data|no data|data kosong/i
                                .test(
                                    body,
                                );
                        },
                    ),
            {
                timeout:
                    30000,
            },
        )
        .catch(
            () =>
                undefined,
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
            page
                .getByRole(
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

    await open
        .click();

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
                page
                    .locator(
                        `input[placeholder="${placeholder}"]`,
                    ),
            )
            : null;

    if (!field) {
        throw new Error(
            `BPOM filter field was not found: ${
                placeholder
                || job.kind
            }`,
        );
    }

    await field
        .fill(
            job.value,
        );

    const apply =
        await visibleLocator(
            page
                .getByRole(
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

    await apply
        .click();

    await sleep(
        Math.max(
            300,
            delay,
        ),
    );

    await page
        .waitForFunction(
            () =>
                [
                    ...document
                        .querySelectorAll(
                            'table',
                        ),
                ]
                    .some(
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
                                    .test(
                                        headers,
                                    )
                                && /Nama Produk/i
                                    .test(
                                        headers,
                                    )
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
        )
        .catch(
            () =>
                crawlerLog
                    .debug(
                        'Filtered table did not signal readiness; continuing.',
                    ),
        );
}

async function extractDetailPairs(dialog) {
    return dialog
        .evaluate(
            (root) => {
                const result = {};

                const cleanText =
                    (value) =>
                        String(
                            value
                            ?? '',
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
                    'Industri Pengemas Primer',
                    'Industri Pengemas Sekunder',
                    'Kits',
                    'Diterbitkan Oleh',
                    'Status',
                ];

                const known =
                    new Map(
                        labels
                            .map(
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
                        const normalizedKey =
                            cleanText(
                                key,
                            )
                                .replace(
                                    /:$/,
                                    '',
                                );

                        const normalizedValue =
                            cleanText(
                                value,
                            );

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
                            const cells = [
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
                                        .join(
                                            ' ',
                                        ),
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
                                    .test(
                                        line,
                                    )
                                && !/^Close$/i
                                    .test(
                                        line,
                                    )
                                && line
                                    !== '×',
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

                    const values = [];

                    for (
                        let j =
                            i + 1;
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
                            candidate
                                .match(
                                    /^([^:]{2,50})\s*:/,
                                );

                        if (
                            nextColon
                            && known.has(
                                normalize(
                                    nextColon[
                                        1
                                    ],
                                ),
                            )
                        ) {
                            break;
                        }

                        values
                            .push(
                                candidate,
                            );
                    }

                    if (
                        values.length
                    ) {
                        put(
                            label,
                            values
                                .join(
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
        page
            .locator(
                '.modal:visible, [role="dialog"]:visible',
            );

    const count =
        await candidates
            .count();

    for (
        let i =
            count - 1;
        i >= 0;
        i--
    ) {
        const dialog =
            candidates
                .nth(
                    i,
                );

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
                .test(
                    text,
                )
            || text.length
            > 20
        ) {
            return dialog;
        }
    }

    return null;
}

async function waitForBpomUiIdle(
    page,
    timeoutMs = 6000,
) {
    return page
        .waitForFunction(
            () => {
                const isVisible =
                    (element) =>
                        Boolean(
                            element
                            && (
                                element
                                    .offsetWidth
                                || element
                                    .offsetHeight
                                || element
                                    .getClientRects()
                                    .length
                            ),
                        );

                const blockingOverlayVisible =
                    [
                        ...document
                            .querySelectorAll(
                                '.blockUI.blockOverlay, .blockUI.blockMsg, .dataTables_processing',
                            ),
                    ]
                        .some(
                            isVisible,
                        );

                const modalVisible =
                    [
                        ...document
                            .querySelectorAll(
                                '#modalDetail, .modal.show, .modal[aria-modal="true"]',
                            ),
                    ]
                        .some(
                            isVisible,
                        );

                return (
                    !blockingOverlayVisible
                    && !modalVisible
                );
            },
            undefined,
            {
                timeout:
                    timeoutMs,
            },
        )
        .then(
            () => true,
        )
        .catch(
            () => false,
        );
}

async function waitForBlockingOverlayToClear(
    page,
    timeoutMs = 4000,
) {
    return page
        .waitForFunction(
            () => {
                const isVisible =
                    (element) =>
                        Boolean(
                            element
                            && (
                                element
                                    .offsetWidth
                                || element
                                    .offsetHeight
                                || element
                                    .getClientRects()
                                    .length
                            ),
                        );

                return ![
                    ...document
                        .querySelectorAll(
                            '.blockUI.blockOverlay, .blockUI.blockMsg, .dataTables_processing',
                        ),
                ]
                    .some(
                        isVisible,
                    );
            },
            undefined,
            {
                timeout:
                    timeoutMs,
            },
        )
        .then(
            () => true,
        )
        .catch(
            () => false,
        );
}

async function requestFrameworkModalHide(page) {
    return page
        .evaluate(
            () => {
                const modal =
                    document
                        .querySelector(
                            '#modalDetail',
                        );

                if (!modal) {
                    return 'NO_MODAL';
                }

                try {
                    if (
                        window
                            .bootstrap
                            ?.Modal
                    ) {
                        const instance =
                            window
                                .bootstrap
                                .Modal
                                .getInstance(
                                    modal,
                                )
                            || window
                                .bootstrap
                                .Modal
                                .getOrCreateInstance(
                                    modal,
                                );

                        instance
                            .hide();

                        return 'BOOTSTRAP';
                    }
                } catch {
                    // Continue to jQuery fallback.
                }

                try {
                    const jq =
                        window.jQuery
                        || window.$;

                    if (
                        jq
                        && typeof jq
                            .fn
                            ?.modal
                        === 'function'
                    ) {
                        jq(
                            modal,
                        )
                            .modal(
                                'hide',
                            );

                        return 'JQUERY';
                    }
                } catch {
                    // Continue to close button.
                }

                return 'UNAVAILABLE';
            },
        )
        .catch(
            () => 'ERROR',
        );
}

async function cleanupDetailUi(
    page,
    crawlerLog,
    {
        force = false,
    } = {},
) {
    let forcedCleanup =
        false;

    let frameworkHideMethod =
        'NOT_NEEDED';

    const initialDialog =
        await visibleLocator(
            page
                .locator(
                    '#modalDetail:visible, .modal:visible',
                ),
        )
            .catch(
                () => null,
            );

    if (
        initialDialog
    ) {
        frameworkHideMethod =
            await requestFrameworkModalHide(
                page,
            );

        await page
            .keyboard
            .press(
                'Escape',
            )
            .catch(
                () => undefined,
            );

        const dialogStillVisible =
            await visibleLocator(
                page
                    .locator(
                        '#modalDetail:visible, .modal:visible',
                    ),
            )
                .catch(
                    () => null,
                );

        if (
            dialogStillVisible
        ) {
            const closeByRole =
                await visibleLocator(
                    dialogStillVisible
                        .getByRole(
                            'button',
                            {
                                name:
                                    /^(Close|Tutup)$/i,
                            },
                        ),
                )
                    .catch(
                        () => null,
                    );

            const closeBySelector =
                closeByRole
                    ? null
                    : await visibleLocator(
                        dialogStillVisible
                            .locator(
                                '[data-bs-dismiss="modal"], [data-dismiss="modal"], .btn-close, button.close',
                            ),
                    )
                        .catch(
                            () => null,
                        );

            const close =
                closeByRole
                || closeBySelector;

            if (
                close
            ) {
                await close
                    .click({
                        timeout:
                            1800,
                    })
                    .catch(
                        () =>
                            undefined,
                    );
            }
        }
    } else {
        await page
            .keyboard
            .press(
                'Escape',
            )
            .catch(
                () => undefined,
            );
    }

    let modalHidden =
        await page
            .locator(
                '#modalDetail:visible, .modal:visible',
            )
            .first()
            .waitFor({
                state:
                    'hidden',

                timeout:
                    2200,
            })
            .then(
                () => true,
            )
            .catch(
                () => false,
            );

    let overlayGone =
        await waitForBlockingOverlayToClear(
            page,
            3500,
        );

    /*
     * Important:
     * do not blindly remove BPOM's blockUI overlay.
     * It can represent a real in-flight request.
     */
    if (
        force
        && !modalHidden
    ) {
        forcedCleanup =
            true;

        await page
            .evaluate(
                () => {
                    const modal =
                        document
                            .querySelector(
                                '#modalDetail',
                            );

                    if (
                        modal
                    ) {
                        modal
                            .classList
                            .remove(
                                'show',
                            );

                        modal
                            .setAttribute(
                                'aria-hidden',
                                'true',
                            );

                        modal
                            .removeAttribute(
                                'aria-modal',
                            );

                        modal
                            .style
                            .display =
                                'none';
                    }

                    document
                        .body
                        .classList
                        .remove(
                            'modal-open',
                        );

                    document
                        .body
                        .style
                        .removeProperty(
                            'padding-right',
                        );

                    document
                        .body
                        .style
                        .removeProperty(
                            'overflow',
                        );

                    document
                        .querySelectorAll(
                            '.modal-backdrop',
                        )
                        .forEach(
                            (element) =>
                                element
                                    .remove(),
                        );
                },
            )
            .catch(
                () =>
                    undefined,
            );

        modalHidden =
            !await page
                .locator(
                    '#modalDetail:visible, .modal:visible',
                )
                .first()
                .count()
                .catch(
                    () => 0,
                );

        overlayGone =
            await waitForBlockingOverlayToClear(
                page,
                4500,
            );
    }

    if (
        forcedCleanup
    ) {
        crawlerLog
            .debug(
                'Forced cleanup of stale BPOM modal state.',
                {
                    frameworkHideMethod,
                    overlayGone,
                },
            );
    }

    return {
        modalHidden,
        overlayGone,
        forcedCleanup,
        frameworkHideMethod,
    };
}

async function enrichFromRow(
    page,
    row,
    delay,
    crawlerLog,
    detailStats,
) {
    const maxAttempts = 2;

    let lastError =
        null;

    for (
        let attempt = 1;
        attempt <= maxAttempts;
        attempt++
    ) {
        try {
            if (
                attempt > 1
            ) {
                detailStats
                    .localRetries++;

                await page
                    .waitForTimeout(
                        400,
                    );
            }

            await cleanupDetailUi(
                page,
                crawlerLog,
                {
                    force:
                        true,
                },
            );

            const uiReady =
                await waitForBpomUiIdle(
                    page,
                    6000,
                );

            if (
                !uiReady
            ) {
                throw new Error(
                    'BPOM UI did not become idle before opening product detail.',
                );
            }

            const clickable =
                row
                    .locator(
                        'a, button, [role="button"]',
                    );

            const count =
                await clickable
                    .count();

            crawlerLog
                .debug(
                    'Opening BPOM product detail.',
                    {
                        clickableCount:
                            count,
                        attempt,
                    },
                );

            if (
                count > 0
            ) {
                await clickable
                    .first()
                    .click({
                        timeout:
                            8000,
                    });
            } else {
                await row
                    .click({
                        timeout:
                            8000,
                    });
            }

            await page
                .waitForTimeout(
                    Math.max(
                        500,
                        Math.min(
                            delay,
                            1200,
                        ),
                    ),
                );

            await page
                .locator(
                    '#modalDetail:visible, .modal:visible',
                )
                .first()
                .waitFor({
                    state:
                        'visible',

                    timeout:
                        8000,
                })
                .catch(
                    () =>
                        undefined,
                );

            const dialog =
                await getVisibleDialog(
                    page,
                );

            if (
                !dialog
            ) {
                throw new Error(
                    'BPOM product detail dialog did not become visible.',
                );
            }

            const dialogText =
                clean(
                    await dialog
                        .innerText()
                        .catch(
                            () => '',
                        ),
                );

            crawlerLog
                .debug(
                    'BPOM product detail dialog detected.',
                    {
                        textPreview:
                            dialogText
                                .slice(
                                    0,
                                    2000,
                                ),
                        attempt,
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

            crawlerLog
                .debug(
                    'BPOM product detail raw fields.',
                    {
                        rawPairs,
                    },
                );

            crawlerLog
                .debug(
                    'BPOM mapped product details.',
                    {
                        details,
                    },
                );

            detailStats
                .succeeded++;

            return {
                ...details,

                __detailFetched:
                    true,
            };
        } catch (error) {
            lastError =
                error;

            crawlerLog
                .warning(
                    'Could not open/parse BPOM product detail.',
                    {
                        attempt,
                        maxAttempts,

                        error:
                            error
                                ?.message
                            || String(
                                error,
                            ),
                    },
                );
        } finally {
            await cleanupDetailUi(
                page,
                crawlerLog,
                {
                    force:
                        true,
                },
            );
        }
    }

    detailStats
        .failed++;

    crawlerLog
        .warning(
            'Skipping BPOM product detail after local retries.',
            {
                error:
                    lastError
                        ?.message
                    || String(
                        lastError
                        || '',
                    ),
            },
        );

    return {
        __detailFetched:
            false,
    };
}

async function extractCurrentPage(
    page,
    job,
    {
        detailStrategy,
        detailMaxAgeDays,
        detailFetchLimitPerRun,
        detectChanges,
        previousRecords,
        previousStateUpdatedAt,
        runStartedAt,
        maxRemaining,
        requestDelayMs,
        detailStats,
        detailDecisionRegistrationNumbers,
        sourceFilterStats,
    },
    crawlerLog,
) {
    const table =
        await getProductTable(
            page,
        );

    const rows =
        table
            .locator(
                'tbody tr',
            );

    const results = [];

    const rowCount =
        await rows
            .count();

    for (
        let i = 0;
        i < rowCount
        && results.length
        < maxRemaining;
        i++
    ) {
        const row =
            rows
                .nth(
                    i,
                );

        const cells =
            await row
                .locator(
                    'td',
                )
                .allInnerTexts();

        if (
            cells.length
            < 3
        ) {
            continue;
        }

        if (
            /tidak ada data|no data|data tidak/i
                .test(
                    cells
                        .map(
                            clean,
                        )
                        .join(
                            ' ',
                        ),
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

        if (
            !list
                .registrationNumber
        ) {
            continue;
        }

        sourceFilterStats
            .scannedRows++;

        /*
         * Source Filter Integrity Guard
         *
         * BPOM occasionally returns stale / unrelated rows after
         * applying a filter. Do not trust the UI filter blindly.
         *
         * For fields already available in listing rows we verify
         * the result immediately and reject mismatches before they
         * can reach snapshot classification.
         *
         * Composition is verified after detail enrichment because
         * it is not available in the listing table.
         */
        if (
            job.kind
            !== 'composition'
        ) {
            const listingMatch =
                evaluateJobMatch(
                    list,
                    job,
                );

            if (
                listingMatch
                    .verifiable
                && !listingMatch
                    .matches
            ) {
                addSourceFilterMismatch(
                    sourceFilterStats,
                    job,
                    list,
                    'LISTING',
                );

                continue;
            }

            if (
                !listingMatch
                    .verifiable
            ) {
                sourceFilterStats
                    .unverifiableRows++;
            }
        }

        const previousEntry =
            previousRecords[
                list
                    .registrationNumber
            ];

        const previousRecord =
            previousEntry
                ?.record
                ? canonicalizeLegacyRecord(
                    previousEntry
                        .record,
                )
                : null;

        const currentBasicHash =
            basicHash(
                list,
            );

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

        let detailFetchReason =
            'NOT_REQUESTED';

        if (
            !detailDecisionRegistrationNumbers
                .has(
                    list
                        .registrationNumber,
                )
        ) {
            const previousDetailFetchedAt =
                resolvePreviousDetailFetchedAt(
                    previousEntry,
                    previousStateUpdatedAt,
                );

            const previousDetailAgeDays =
                detailAgeDays(
                    previousDetailFetchedAt,
                    runStartedAt,
                );

            if (
                detailStrategy
                === 'always'
            ) {
                shouldFetchDetail =
                    true;

                detailFetchReason =
                    'ALWAYS';
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

                detailFetchReason =
                    !previousRecord
                        ? 'FIRST_SEEN'
                        : 'LISTING_CHANGED';
            } else if (
                detailStrategy
                === 'staleOnly'
            ) {
                if (
                    !previousRecord
                ) {
                    shouldFetchDetail =
                        true;

                    detailFetchReason =
                        'FIRST_SEEN';
                } else if (
                    listingChanged
                ) {
                    shouldFetchDetail =
                        true;

                    detailFetchReason =
                        'LISTING_CHANGED';
                } else if (
                    !previousDetailFetchedAt
                ) {
                    shouldFetchDetail =
                        true;

                    detailFetchReason =
                        'NO_DETAIL_TIMESTAMP';
                } else if (
                    previousDetailAgeDays
                    === null
                    || previousDetailAgeDays
                    >= detailMaxAgeDays
                ) {
                    shouldFetchDetail =
                        true;

                    detailFetchReason =
                        'STALE_DETAIL';
                } else {
                    detailFetchReason =
                        'DETAIL_FRESH';
                }
            }

            if (
                shouldFetchDetail
                && detailStrategy
                === 'staleOnly'
                && detailFetchLimitPerRun
                > 0
                && detailStats
                    .requested
                >= detailFetchLimitPerRun
            ) {
                shouldFetchDetail =
                    false;

                detailFetchReason =
                    'DETAIL_FETCH_LIMIT_REACHED';

                detailStats
                    .budgetSkipped++;
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

                detailStats
                    .byReason[
                        detailFetchReason
                    ] =
                        (
                            detailStats
                                .byReason[
                                    detailFetchReason
                                ]
                            || 0
                        )
                        + 1;
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
                    detailStats,
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
                    previousRecord
                        ?.[field],
                );

            const currentValue =
                clean(
                    detail[
                        field
                    ],
                );

            detailValues[
                field
            ] =
                currentValue
                || previousValue;

            if (
                detail
                    .__detailFetched
                === true
                && currentValue
            ) {
                currentKnownDetailFields
                    .add(
                        field,
                    );
            }
        }

        const currentDetailKnown =
            Boolean(
                priorDetailKnown
                || detail
                    .__detailFetched
                === true
                || currentKnownDetailFields
                    .size > 0,
            );

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

            __detailKnownFields: [
                ...currentKnownDetailFields,
            ],

            __detailFetched:
                detail
                    .__detailFetched
                === true,
        };

        /*
         * Composition filter cannot be verified from listing data.
         * Verify it after detail data has been merged.
         */
        if (
            job.kind
            === 'composition'
        ) {
            const detailMatch =
                evaluateJobMatch(
                    record,
                    job,
                );

            if (
                detailMatch
                    .verifiable
                && !detailMatch
                    .matches
            ) {
                addSourceFilterMismatch(
                    sourceFilterStats,
                    job,
                    record,
                    'DETAIL',
                );

                continue;
            }

            if (
                !detailMatch
                    .verifiable
            ) {
                sourceFilterStats
                    .unverifiableRows++;
            }
        }

        sourceFilterStats
            .acceptedRows++;

        results
            .push(
                record,
            );
    }

    return results;
}

async function getPaginationSnapshot(page) {
    const table =
        await getProductTable(
            page,
        )
            .catch(
                () => null,
            );

    if (!table) {
        return {
            activePage:
                '',

            firstRow:
                '',

            dataTablePage:
                null,

            dataTablePages:
                null,

            nextExists:
                false,

            nextDisabled:
                true,
        };
    }

    return table
        .evaluate(
            (tableElement) => {
                const cleanText =
                    (value) =>
                        String(
                            value
                            ?? '',
                        )
                            .replace(
                                /\u00a0/g,
                                ' ',
                            )
                            .replace(
                                /\s+/g,
                                ' ',
                            )
                            .trim();

                const wrapper =
                    tableElement
                        .closest(
                            '.dataTables_wrapper',
                        )
                    || tableElement
                        .parentElement
                        ?.closest(
                            '.dataTables_wrapper',
                        )
                    || tableElement
                        .parentElement
                    || document;

                const active =
                    wrapper
                        .querySelector(
                            '.paginate_button.current, .pagination .active',
                        );

                const next =
                    wrapper
                        .querySelector(
                            '.paginate_button.next, button[id$="_next"]',
                        );

                const firstRow =
                    tableElement
                        .querySelector(
                            'tbody tr',
                        );

                let dataTablePage =
                    null;

                let dataTablePages =
                    null;

                try {
                    const jq =
                        window.jQuery
                        || window.$;

                    if (
                        jq
                        && jq.fn
                            ?.dataTable
                            ?.isDataTable
                        && jq.fn
                            .dataTable
                            .isDataTable(
                                tableElement,
                            )
                    ) {
                        const instance =
                            jq(
                                tableElement,
                            );

                        const api =
                            typeof instance
                                .DataTable
                            === 'function'
                                ? instance
                                    .DataTable()
                                : instance
                                    .dataTable()
                                    .api();

                        const info =
                            api
                                .page
                                .info();

                        dataTablePage =
                            Number.isFinite(
                                info
                                    ?.page,
                            )
                                ? info
                                    .page
                                : null;

                        dataTablePages =
                            Number.isFinite(
                                info
                                    ?.pages,
                            )
                                ? info
                                    .pages
                                : null;
                    }
                } catch {
                    // Visual fallback remains available.
                }

                const nextClass =
                    cleanText(
                        next
                            ?.getAttribute(
                                'class',
                            ),
                    );

                const dataTableAtEnd =
                    (
                        dataTablePage
                        !== null
                        && dataTablePages
                        !== null
                        && dataTablePages
                        > 0
                        && dataTablePage
                        >= dataTablePages
                        - 1
                    );

                const nextDisabled =
                    dataTableAtEnd
                    || !next
                    || next
                        .hasAttribute(
                            'disabled',
                        )
                    || next
                        .getAttribute(
                            'aria-disabled',
                        )
                    === 'true'
                    || nextClass
                        .split(
                            ' ',
                        )
                        .includes(
                            'disabled',
                        );

                return {
                    activePage:
                        cleanText(
                            active
                                ?.textContent,
                        ),

                    firstRow:
                        cleanText(
                            firstRow
                                ?.textContent,
                        ),

                    dataTablePage,
                    dataTablePages,

                    nextExists:
                        Boolean(
                            next,
                        ),

                    nextDisabled,
                };
            },
        );
}

function paginationMoved(
    before,
    current,
) {
    return Boolean(
        (
            before
                .dataTablePage
            !== null
            && current
                .dataTablePage
            !== null
            && current
                .dataTablePage
            !== before
                .dataTablePage
        )
        || (
            before
                .activePage
            && current
                .activePage
            && current
                .activePage
            !== before
                .activePage
        )
        || (
            before
                .firstRow
            && current
                .firstRow
            && current
                .firstRow
            !== before
                .firstRow
        ),
    );
}

async function getVisibleNextButton(page) {
    const table =
        await getProductTable(
            page,
        )
            .catch(
                () => null,
            );

    if (!table) {
        return null;
    }

    const wrapper =
        table
            .locator(
                'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " dataTables_wrapper ")][1]',
            );

    if (
        await wrapper
            .count()
            .catch(
                () => 0,
            )
    ) {
        const localNext =
            await visibleLocator(
                wrapper
                    .locator(
                        '.paginate_button.next, button[id$="_next"]',
                    ),
            )
                .catch(
                    () => null,
                );

        if (
            localNext
        ) {
            return localNext;
        }
    }

    return visibleLocator(
        page
            .locator(
                '.paginate_button.next:visible, button[id$="_next"]:visible',
            ),
    )
        .catch(
            () => null,
        );
}

async function triggerNextPageWithPlaywright(page) {
    const next =
        await getVisibleNextButton(
            page,
        );

    if (!next) {
        return {
            triggered:
                false,

            reason:
                'NEXT_BUTTON_NOT_FOUND',
        };
    }

    const classNames =
        clean(
            await next
                .getAttribute(
                    'class',
                ),
        )
            .split(
                ' ',
            )
            .filter(
                Boolean,
            );

    const disabled =
        await next
            .isDisabled()
            .catch(
                () => false,
            )
        || await next
            .getAttribute(
                'disabled',
            )
        !== null
        || await next
            .getAttribute(
                'aria-disabled',
            )
        === 'true'
        || classNames
            .includes(
                'disabled',
            );

    if (
        disabled
    ) {
        return {
            triggered:
                false,

            reason:
                'NEXT_BUTTON_DISABLED',
        };
    }

    try {
        await next
            .click({
                timeout:
                    3000,
            });

        return {
            triggered:
                true,

            reason:
                'PLAYWRIGHT_CLICK',
        };
    } catch (error) {
        return {
            triggered:
                false,

            reason:
                'PLAYWRIGHT_CLICK_FAILED',

            error:
                error
                    ?.message
                || String(
                    error,
                ),
        };
    }
}

async function triggerNextPageWithDataTablesApi(page) {
    const table =
        await getProductTable(
            page,
        )
            .catch(
                () => null,
            );

    if (!table) {
        return {
            triggered:
                false,

            available:
                false,

            reason:
                'PRODUCT_TABLE_NOT_FOUND',
        };
    }

    return table
        .evaluate(
            (tableElement) => {
                try {
                    const jq =
                        window.jQuery
                        || window.$;

                    if (
                        !jq
                        || !jq.fn
                            ?.dataTable
                            ?.isDataTable
                        || !jq.fn
                            .dataTable
                            .isDataTable(
                                tableElement,
                            )
                    ) {
                        return {
                            triggered:
                                false,

                            available:
                                false,

                            reason:
                                'DATATABLES_API_UNAVAILABLE',
                        };
                    }

                    const instance =
                        jq(
                            tableElement,
                        );

                    const api =
                        typeof instance
                            .DataTable
                        === 'function'
                            ? instance
                                .DataTable()
                            : instance
                                .dataTable()
                                .api();

                    const info =
                        api
                            .page
                            .info();

                    if (
                        Number.isFinite(
                            info
                                ?.page,
                        )
                        && Number.isFinite(
                            info
                                ?.pages,
                        )
                        && info.pages
                        > 0
                        && info.page
                        >= info.pages
                        - 1
                    ) {
                        return {
                            triggered:
                                false,

                            available:
                                true,

                            atEnd:
                                true,

                            reason:
                                'DATATABLES_AT_END',
                        };
                    }

                    api
                        .page(
                            'next',
                        )
                        .draw(
                            'page',
                        );

                    return {
                        triggered:
                            true,

                        available:
                            true,

                        atEnd:
                            false,

                        pageBefore:
                            Number.isFinite(
                                info
                                    ?.page,
                            )
                                ? info
                                    .page
                                : null,

                        reason:
                            'DATATABLES_API',
                    };
                } catch (error) {
                    return {
                        triggered:
                            false,

                        available:
                            true,

                        reason:
                            'DATATABLES_API_FAILED',

                        error:
                            error
                                ?.message
                            || String(
                                error,
                            ),
                    };
                }
            },
        );
}

async function triggerNextPageWithDomFallback(page) {
    const table =
        await getProductTable(
            page,
        )
            .catch(
                () => null,
            );

    if (!table) {
        return {
            triggered:
                false,

            reason:
                'PRODUCT_TABLE_NOT_FOUND',
        };
    }

    return table
        .evaluate(
            (tableElement) => {
                const wrapper =
                    tableElement
                        .closest(
                            '.dataTables_wrapper',
                        )
                    || tableElement
                        .parentElement
                        ?.closest(
                            '.dataTables_wrapper',
                        )
                    || tableElement
                        .parentElement
                    || document;

                const next =
                    wrapper
                        .querySelector(
                            '.paginate_button.next, button[id$="_next"]',
                        );

                if (!next) {
                    return {
                        triggered:
                            false,

                        reason:
                            'NEXT_BUTTON_NOT_FOUND',
                    };
                }

                const classNames =
                    String(
                        next
                            .getAttribute(
                                'class',
                            )
                        || '',
                    )
                        .split(
                            /\s+/,
                        )
                        .filter(
                            Boolean,
                        );

                const disabled =
                    next
                        .hasAttribute(
                            'disabled',
                        )
                    || next
                        .getAttribute(
                            'aria-disabled',
                        )
                    === 'true'
                    || classNames
                        .includes(
                            'disabled',
                        );

                if (
                    disabled
                ) {
                    return {
                        triggered:
                            false,

                        reason:
                            'NEXT_BUTTON_DISABLED',
                    };
                }

                next
                    .click();

                return {
                    triggered:
                        true,

                    reason:
                        'DOM_CLICK',
                };
            },
        );
}

async function waitForPaginationMove(
    page,
    before,
    timeoutMs = 4000,
) {
    return page
        .waitForFunction(
            (previous) => {
                const cleanText =
                    (value) =>
                        String(
                            value
                            ?? '',
                        )
                            .replace(
                                /\u00a0/g,
                                ' ',
                            )
                            .replace(
                                /\s+/g,
                                ' ',
                            )
                            .trim();

                const isVisible =
                    (element) =>
                        Boolean(
                            element
                            && (
                                element
                                    .offsetWidth
                                || element
                                    .offsetHeight
                                || element
                                    .getClientRects()
                                    .length
                            ),
                        );

                const tables =
                    [
                        ...document
                            .querySelectorAll(
                                'table',
                            ),
                    ]
                        .filter(
                            (table) => {
                                if (
                                    !isVisible(
                                        table,
                                    )
                                ) {
                                    return false;
                                }

                                const headers =
                                    cleanText(
                                        table
                                            .querySelector(
                                                'thead',
                                            )
                                            ?.textContent,
                                    );

                                return (
                                    /Nomor Registrasi/i
                                        .test(
                                            headers,
                                        )
                                    && /Nama Produk/i
                                        .test(
                                            headers,
                                        )
                                );
                            },
                        );

                const table =
                    tables
                        .find(
                            (candidate) =>
                                candidate
                                    .querySelectorAll(
                                        'tbody tr',
                                    )
                                    .length
                                > 0,
                        )
                    || tables[0];

                if (!table) {
                    return false;
                }

                const wrapper =
                    table
                        .closest(
                            '.dataTables_wrapper',
                        )
                    || table
                        .parentElement
                        ?.closest(
                            '.dataTables_wrapper',
                        )
                    || table
                        .parentElement
                    || document;

                const active =
                    wrapper
                        .querySelector(
                            '.paginate_button.current, .pagination .active',
                        );

                const firstRow =
                    table
                        .querySelector(
                            'tbody tr',
                        );

                const currentActivePage =
                    cleanText(
                        active
                            ?.textContent,
                    );

                const currentFirstRow =
                    cleanText(
                        firstRow
                            ?.textContent,
                    );

                let currentDataTablePage =
                    null;

                try {
                    const jq =
                        window.jQuery
                        || window.$;

                    if (
                        jq
                        && jq.fn
                            ?.dataTable
                            ?.isDataTable
                        && jq.fn
                            .dataTable
                            .isDataTable(
                                table,
                            )
                    ) {
                        const instance =
                            jq(
                                table,
                            );

                        const api =
                            typeof instance
                                .DataTable
                            === 'function'
                                ? instance
                                    .DataTable()
                                : instance
                                    .dataTable()
                                    .api();

                        const info =
                            api
                                .page
                                .info();

                        currentDataTablePage =
                            Number.isFinite(
                                info
                                    ?.page,
                            )
                                ? info
                                    .page
                                : null;
                    }
                } catch {
                    // Fall through to visual signals.
                }

                return (
                    (
                        previous
                            .dataTablePage
                        !== null
                        && currentDataTablePage
                        !== null
                        && currentDataTablePage
                        !== previous
                            .dataTablePage
                    )
                    || (
                        previous
                            .activePage
                        && currentActivePage
                        && currentActivePage
                        !== previous
                            .activePage
                    )
                    || (
                        previous
                            .firstRow
                        && currentFirstRow
                        && currentFirstRow
                        !== previous
                            .firstRow
                    )
                );
            },
            before,
            {
                timeout:
                    timeoutMs,
            },
        )
        .then(
            () => true,
        )
        .catch(
            () => false,
        );
}

async function settleAfterPagination(
    page,
    delay,
    crawlerLog,
) {
    const idle =
        await waitForBpomUiIdle(
            page,
            5000,
        );

    if (
        !idle
    ) {
        crawlerLog
            .debug(
                'BPOM pagination moved, but the UI still reports a transient processing state.',
            );
    }

    await page
        .waitForTimeout(
            Math.max(
                100,
                Math.min(
                    delay,
                    300,
                ),
            ),
        );
}

async function clickNext(
    page,
    delay,
    crawlerLog,
    paginationStats,
) {
    const before =
        await getPaginationSnapshot(
            page,
        );

    if (
        !before.nextExists
        || before.nextDisabled
    ) {
        return {
            status:
                'end',

            recovered:
                false,
        };
    }

    const cleanup =
        await cleanupDetailUi(
            page,
            crawlerLog,
            {
                force:
                    true,
            },
        );

    if (
        cleanup
            .forcedCleanup
    ) {
        paginationStats
            .uiCleanups++;
    }

    const initialIdle =
        await waitForBpomUiIdle(
            page,
            5000,
        );

    if (
        !initialIdle
    ) {
        crawlerLog
            .warning(
                'BPOM UI was still busy before pagination; trying pagination with recovery safeguards.',
            );
    }

    const currentBeforeClick =
        await getPaginationSnapshot(
            page,
        );

    if (
        paginationMoved(
            before,
            currentBeforeClick,
        )
    ) {
        return {
            status:
                'moved',

            recovered:
                true,
        };
    }

    let lastError =
        null;

    const normal =
        await triggerNextPageWithPlaywright(
            page,
        );

    if (
        normal.triggered
    ) {
        const moved =
            await waitForPaginationMove(
                page,
                before,
                3500,
            );

        if (
            moved
        ) {
            await settleAfterPagination(
                page,
                delay,
                crawlerLog,
            );

            return {
                status:
                    'moved',

                recovered:
                    false,
            };
        }

        lastError =
            new Error(
                'BPOM pagination did not move after the normal click.',
            );
    } else {
        lastError =
            new Error(
                `BPOM normal pagination click failed: ${normal.reason}`
                + (
                    normal.error
                        ? ` - ${normal.error}`
                        : ''
                ),
            );
    }

    crawlerLog
        .warning(
            'BPOM normal pagination failed; trying DataTables API recovery.',
            {
                error:
                    lastError
                        .message,
            },
        );

    paginationStats
        .localRetries++;

    paginationStats
        .apiFallbacks++;

    const afterNormal =
        await getPaginationSnapshot(
            page,
        );

    if (
        paginationMoved(
            before,
            afterNormal,
        )
    ) {
        paginationStats
            .recoveries++;

        await settleAfterPagination(
            page,
            delay,
            crawlerLog,
        );

        return {
            status:
                'moved',

            recovered:
                true,
        };
    }

    await waitForBpomUiIdle(
        page,
        3500,
    );

    const apiResult =
        await triggerNextPageWithDataTablesApi(
            page,
        );

    if (
        apiResult
            .atEnd
    ) {
        return {
            status:
                'end',

            recovered:
                true,
        };
    }

    if (
        apiResult
            .triggered
    ) {
        const moved =
            await waitForPaginationMove(
                page,
                before,
                4500,
            );

        if (
            moved
        ) {
            paginationStats
                .recoveries++;

            await settleAfterPagination(
                page,
                delay,
                crawlerLog,
            );

            return {
                status:
                    'moved',

                recovered:
                    true,
            };
        }

        lastError =
            new Error(
                'BPOM pagination did not move after DataTables API recovery.',
            );
    } else {
        lastError =
            new Error(
                `BPOM DataTables API recovery failed: ${apiResult.reason}`
                + (
                    apiResult.error
                        ? ` - ${apiResult.error}`
                        : ''
                ),
            );
    }

    if (
        !apiResult
            .available
    ) {
        paginationStats
            .localRetries++;

        paginationStats
            .domFallbacks++;

        const domResult =
            await triggerNextPageWithDomFallback(
                page,
            );

        if (
            domResult
                .triggered
        ) {
            const moved =
                await waitForPaginationMove(
                    page,
                    before,
                    3500,
                );

            if (
                moved
            ) {
                paginationStats
                    .recoveries++;

                await settleAfterPagination(
                    page,
                    delay,
                    crawlerLog,
                );

                return {
                    status:
                        'moved',

                    recovered:
                        true,
                };
            }

            lastError =
                new Error(
                    'BPOM pagination did not move after DOM fallback.',
                );
        } else {
            lastError =
                new Error(
                    `BPOM DOM pagination fallback failed: ${domResult.reason}`,
                );
        }
    }

    paginationStats
        .failures++;

    crawlerLog
        .warning(
            'BPOM pagination recovery exhausted.',
            {
                error:
                    lastError
                        ?.message
                    || String(
                        lastError
                        || '',
                    ),
            },
        );

    return {
        status:
            'failed',

        recovered:
            false,

        error:
            lastError
                ?.message
            || String(
                lastError
                || '',
            ),
    };
}

await Actor.main(async () => {
    const runStartedAt =
        isoNow();

    const input =
        await Actor
            .getInput()
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

    const detailMaxAgeDays =
        Number(
            input
                .detailMaxAgeDays
            ?? 30,
        );

    const detailFetchLimitPerRun =
        Number(
            input
                .detailFetchLimitPerRun
            ?? 0,
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

    if (
        !Number.isInteger(
            detailMaxAgeDays,
        )
        || detailMaxAgeDays
        < 1
    ) {
        throw new Error(
            'detailMaxAgeDays must be an integer >= 1.',
        );
    }

    if (
        !Number.isInteger(
            detailFetchLimitPerRun,
        )
        || detailFetchLimitPerRun
        < 0
    ) {
        throw new Error(
            'detailFetchLimitPerRun must be an integer >= 0.',
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
            'staleOnly',
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

    const teamsWebhookUrl =
        clean(
            process
                .env
                .TEAMS_WEBHOOK_URL,
        );

    const teamsNotificationsEnabled =
        Boolean(
            teamsWebhookUrl,
        );

    const itemLimit =
        maxItemsPerQuery
        > 0
            ? maxItemsPerQuery
            : Infinity;

    if (
        debug
    ) {
        log.setLevel(
            log
                .LEVELS
                .DEBUG,
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

    const previousStateUpdatedAtForDetail =
        watchlistMatchesPreviousState
            ? clean(
                rawPreviousState
                    ?.updatedAt,
            )
            : '';

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

            detailMaxAgeDays,

            detailFetchLimitPerRun,

            allowPartialSnapshotUpdate,

            debug,

            teamsNotificationsEnabled,
        },
    );

    const collected =
        new Map();

    const failedJobs = [];

    const querySummaries =
        new Map();

    const detailStats = {
        requested:
            0,

        skipped:
            0,

        succeeded:
            0,

        failed:
            0,

        localRetries:
            0,

        budgetSkipped:
            0,

        byReason:
            {},
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

                        crawlerLog
                            .warning(
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

                crawlerLog
                    .info(
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

                const paginationStats = {
                    localRetries:
                        0,

                    recoveries:
                        0,

                    failures:
                        0,

                    uiCleanups:
                        0,

                    apiFallbacks:
                        0,

                    domFallbacks:
                        0,
                };

                const sourceFilterStats = {
                    scannedRows:
                        0,

                    acceptedRows:
                        0,

                    mismatchedRows:
                        0,

                    unverifiableRows:
                        0,

                    mismatchSamples:
                        [],
                };

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

                                detailMaxAgeDays,

                                detailFetchLimitPerRun,

                                detectChanges,

                                previousRecords:
                                    previousRecordsForDetail,

                                previousStateUpdatedAt:
                                    previousStateUpdatedAtForDetail,

                                runStartedAt,

                                maxRemaining,

                                requestDelayMs,

                                detailStats,

                                detailDecisionRegistrationNumbers,

                                sourceFilterStats,
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
                                .has(
                                    key,
                                )
                        ) {
                            duplicateRows++;

                            duplicateRegistrationNumbers
                                .add(
                                    key,
                                );
                        } else {
                            seenRegistrationNumbers
                                .add(
                                    key,
                                );
                        }

                        const existing =
                            collected
                                .get(
                                    key,
                                );

                        if (
                            !existing
                        ) {
                            collected
                                .set(
                                    key,
                                    item,
                                );
                        } else {
                            const matches =
                                Array.isArray(
                                    existing
                                        .matches,
                                )
                                    ? existing
                                        .matches
                                    : [
                                        existing
                                            .matchedBy,
                                    ]
                                        .filter(
                                            Boolean,
                                        );

                            if (
                                !matches
                                    .some(
                                        (
                                            match,
                                        ) =>
                                            match
                                                .type
                                            === item
                                                .matchedBy
                                                .type
                                            && match
                                                .value
                                            === item
                                                .matchedBy
                                                .value,
                                    )
                            ) {
                                matches
                                    .push(
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

                    const paginationResult =
                        await clickNext(
                            page,
                            requestDelayMs,
                            crawlerLog,
                            paginationStats,
                        );

                    if (
                        paginationResult
                            .status
                        === 'end'
                    ) {
                        coverageComplete =
                            true;

                        stopReason =
                            'end_of_results';

                        break;
                    }

                    if (
                        paginationResult
                            .status
                        === 'failed'
                    ) {
                        coverageComplete =
                            false;

                        stopReason =
                            'pagination_failure';

                        crawlerLog
                            .warning(
                                'Stopping this BPOM query without whole-query retry because local pagination recovery was exhausted.',
                                {
                                    queryId:
                                        request
                                            .uniqueKey,

                                    pageNumber,

                                    error:
                                        paginationResult
                                            .error,
                                },
                            );

                        break;
                    }

                    pageNumber++;
                }

                /*
                 * A tiny number of mismatched rows can occur because of
                 * transient BPOM table state. They are rejected safely.
                 *
                 * A large mismatch rate means the actual source filter may
                 * not have been applied correctly, so the whole query must
                 * fail its integrity gate.
                 */
                const sourceFilterMismatchRatio =
                    sourceFilterStats
                        .scannedRows
                    > 0
                        ? sourceFilterStats
                            .mismatchedRows
                            / sourceFilterStats
                                .scannedRows
                        : 0;

                const filterIntegrityPassed =
                    !(
                        sourceFilterStats
                            .mismatchedRows
                        >= 10
                        && sourceFilterMismatchRatio
                        >= 0.05
                    );

                if (
                    !filterIntegrityPassed
                ) {
                    crawlerLog
                        .error(
                            'BPOM source filter integrity check failed.',
                            {
                                job,

                                scannedRows:
                                    sourceFilterStats
                                        .scannedRows,

                                acceptedRows:
                                    sourceFilterStats
                                        .acceptedRows,

                                mismatchedRows:
                                    sourceFilterStats
                                        .mismatchedRows,

                                mismatchRatio:
                                    sourceFilterMismatchRatio,
                            },
                        );
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
                        sourceFilterStats
                            .scannedRows,

                    acceptedRows:
                        sourceFilterStats
                            .acceptedRows,

                    sourceFilterMismatches:
                        sourceFilterStats
                            .mismatchedRows,

                    sourceFilterMismatchRatio,

                    sourceFilterUnverifiableRows:
                        sourceFilterStats
                            .unverifiableRows,

                    sourceFilterMismatchSamples:
                        sourceFilterStats
                            .mismatchSamples,

                    filterIntegrityPassed,

                    uniqueProducts:
                        seenRegistrationNumbers
                            .size,

                    duplicateRows,

                    duplicateRegistrationNumberCount:
                        duplicateRegistrationNumbers
                            .size,

                    duplicateRegistrationNumbers: [
                        ...duplicateRegistrationNumbers,
                    ]
                        .slice(
                            0,
                            100,
                        ),

                    pagesVisited:
                        pageNumber,

                    coverageComplete,

                    stopReason,

                    paginationLocalRetries:
                        paginationStats
                            .localRetries,

                    paginationRecoveries:
                        paginationStats
                            .recoveries,

                    paginationFailures:
                        paginationStats
                            .failures,

                    paginationUiCleanups:
                        paginationStats
                            .uiCleanups,

                    paginationApiFallbacks:
                        paginationStats
                            .apiFallbacks,

                    paginationDomFallbacks:
                        paginationStats
                            .domFallbacks,
                };

                querySummaries
                    .set(
                        request
                            .uniqueKey,
                        querySummary,
                    );

                crawlerLog
                    .info(
                        `Scanned ${sourceFilterStats.scannedRows} row(s), accepted ${queryCount} row(s) / ${seenRegistrationNumbers.size} unique product(s) for ${job.kind}=${job.value}.`,
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

                failedJobs
                    .push({
                        job,

                        error:
                            error
                                ?.message
                            || String(
                                error,
                            ),
                    });

                querySummaries
                    .set(
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

                            acceptedRows:
                                0,

                            sourceFilterMismatches:
                                0,

                            sourceFilterMismatchRatio:
                                0,

                            sourceFilterUnverifiableRows:
                                0,

                            sourceFilterMismatchSamples:
                                [],

                            filterIntegrityPassed:
                                false,

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

                crawlerLog
                    .error(
                        `Query failed: ${job.kind}=${job.value}`,
                        {
                            error:
                                error
                                    ?.message,
                        },
                    );
            },
        });

    await crawler
        .run(
            jobs
                .map(
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
        jobs
            .map(
                (job) =>
                    querySummaries
                        .get(
                            `${job.kind}:${job.value}`,
                        ),
            );

    const overallCoverageComplete =
        failedJobs.length
        === 0
        && querySummaryList
            .every(
                (query) =>
                    query
                        ?.coverageComplete
                    === true
                    && query
                        ?.filterIntegrityPassed
                    !== false,
            );

    const incompleteQueries =
        querySummaryList
            .filter(
                (query) =>
                    query
                        ?.coverageComplete
                    !== true
                    || query
                        ?.filterIntegrityPassed
                    === false,
            )
            .length;

    const failedFilterIntegrityQueries =
        querySummaryList
            .filter(
                (query) =>
                    query
                        ?.filterIntegrityPassed
                    === false,
            )
            .length;

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
        && successfulRunsBefore
        > 0
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

    let baselineCount = 0;
    let discoveredCount = 0;
    let newCount = 0;
    let changedCount = 0;
    let unchangedCount = 0;
    let enrichedCount = 0;
    let snapshotCount = 0;
    let emittedCount = 0;
    let suppressedOperationalRecords = 0;
    let reappearedCount = 0;
    let firstSeenCount = 0;

    const pendingOutputRecords = [];

    const operationalAlertRecords = [];

    const newCandidates = [];
    const discoveredCandidates = [];
    const changedCandidates = [];
    const enrichedCandidates = [];

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
                Array.isArray(
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

        const detailFetchedThisRun =
            Boolean(
                internalRecord
                    .__detailFetched,
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
                record
                    .registrant,
            );

        record.cosmeticsManufacturer =
            sanitizeCosmeticsManufacturer(
                record
                    .cosmeticsManufacturer,
            );

        const id =
            record
                .registrationNumber;

        const previousEntry =
            previousRecords[
                id
            ];

        const previousRecord =
            previousEntry
                ?.record
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

        const previousLastDetailFetchedAt =
            resolvePreviousDetailFetchedAt(
                previousEntry,
                clean(
                    previousState
                        .updatedAt,
                ),
            );

        const lastDetailFetchedAt =
            detailFetchedThisRun
                ? runStartedAt
                : previousLastDetailFetchedAt;

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
            && priorMisses
            > 0
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

        const actualChangedFields = [
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
                    ageDays
                    === null
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
                    ageDays
                    < -1
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
                    .length > 0
            ) {
                eventType =
                    'BASELINE';

                classificationReason =
                    'BASELINE_RECORD_UPDATED_DURING_WARMUP';

                baselineCount++;
            } else if (
                enrichedFields
                    .length > 0
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
                .length > 0
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
                .length > 0
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
            eventType
            === 'NEW'
            && newCandidates
                .length < 100
        ) {
            newCandidates
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
            === 'DISCOVERED'
            && discoveredCandidates
                .length < 100
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
                .length < 100
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
                .length > 0
            && enrichedCandidates
                .length < 100
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
            eventType
            === 'NEW'
            || eventType
            === 'CHANGED'
        ) {
            operationalAlertRecords
                .push(
                    output,
                );
        }

        if (
            shouldEmit(
                emit,
                eventType,
            )
        ) {
            const isOperationalEvent =
                (
                    eventType
                    === 'NEW'
                    || eventType
                    === 'CHANGED'
                );

            if (
                !overallCoverageComplete
                && isOperationalEvent
            ) {
                suppressedOperationalRecords++;
            } else {
                pendingOutputRecords
                    .push(
                        output,
                    );
            }
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

        observedRecords[
            id
        ] = {
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

            detailKnownFields: [
                ...currentKnownDetailFields,
            ],

            lastDetailFetchedAt,

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

    for (
        const output
        of pendingOutputRecords
    ) {
        await Actor
            .pushData(
                output,
            );

        emittedCount++;
    }

    const previousIds =
        Object.keys(
            previousRecords,
        );

    /*
     * Clean historical contamination from snapshots created before
     * source-filter integrity validation existed.
     *
     * A previous record that can be conclusively shown to no longer
     * match any configured monitoring job is not carried forward.
     *
     * We use conservative matching: if a job cannot be verified from
     * the stored record, the record is retained.
     */
    let prunedOutOfScopePreviousRecords =
        0;

    const eligiblePreviousIds =
        previousIds
            .filter(
                (id) => {
                    const previousEntry =
                        previousRecords[
                            id
                        ];

                    const previousRecord =
                        previousEntry
                            ?.record;

                    if (
                        !previousRecord
                    ) {
                        return true;
                    }

                    const keep =
                        recordMatchesAnyJobConservatively(
                            canonicalizeLegacyRecord(
                                previousRecord,
                            ),
                            jobs,
                        );

                    if (
                        !keep
                    ) {
                        prunedOutOfScopePreviousRecords++;
                    }

                    return keep;
                },
            );

    if (
        prunedOutOfScopePreviousRecords
        > 0
    ) {
        log.warning(
            'Pruning out-of-scope record(s) from the previous snapshot.',
            {
                prunedOutOfScopePreviousRecords,
                stateKey,
            },
        );
    }

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
            ? eligiblePreviousIds
                .filter(
                    (id) =>
                        !observedIds
                            .has(
                                id,
                            ),
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
            of eligiblePreviousIds
        ) {
            if (
                observedIds
                    .has(
                        id,
                    )
            ) {
                continue;
            }

            const previousEntry =
                previousRecords[
                    id
                ];

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

            nextRecords[
                id
            ] = {
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
        && successfulRunsAfter
        >= 1
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

                    detailMaxAgeDays,

                    detailFetchLimitPerRun,

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

    const qualityGatePassed =
        !detectChanges
        || overallCoverageComplete;

    const teamsStats = {
        enabled:
            teamsNotificationsEnabled,

        eligibleRecords:
            operationalAlertRecords
                .length,

        newRecords:
            operationalAlertRecords
                .filter(
                    (record) =>
                        record
                            .eventType
                    === 'NEW',
                )
                .length,

        changedRecords:
            operationalAlertRecords
                .filter(
                    (record) =>
                        record
                            .eventType
                    === 'CHANGED',
                )
                .length,

        attempted:
            0,

        succeeded:
            0,

        failed:
            0,

        retries:
            0,

        suppressedByQualityGate:
            qualityGatePassed
                ? 0
                : operationalAlertRecords
                    .length,

        failureSamples:
            [],
    };

    if (
        qualityGatePassed
        && operationalAlertRecords
            .length > 0
    ) {
        if (
            teamsNotificationsEnabled
        ) {
            for (
                const record
                of operationalAlertRecords
            ) {
                await postTeamsNotification(
                    teamsWebhookUrl,
                    record,
                    teamsStats,
                );
            }
        } else {
            log.warning(
                'Operational BPOM event(s) detected, but Teams notifications are disabled because TEAMS_WEBHOOK_URL is not configured.',
                {
                    operationalEvents:
                        operationalAlertRecords
                            .length,
                },
            );
        }
    } else if (
        !qualityGatePassed
        && operationalAlertRecords
            .length > 0
    ) {
        log.warning(
            'Teams operational notifications suppressed because the monitoring quality gate did not pass.',
            {
                operationalEvents:
                    operationalAlertRecords
                        .length,

                incompleteQueries,
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

    const totalSourceFilterMismatches =
        querySummaryList
            .reduce(
                (
                    total,
                    query,
                ) =>
                    total
                    + (
                        query
                            ?.sourceFilterMismatches
                        ?? 0
                    ),
                0,
            );

    const totalSourceFilterUnverifiableRows =
        querySummaryList
            .reduce(
                (
                    total,
                    query,
                ) =>
                    total
                    + (
                        query
                            ?.sourceFilterUnverifiableRows
                        ?? 0
                    ),
                0,
            );

    const totalPaginationLocalRetries =
        querySummaryList
            .reduce(
                (
                    total,
                    query,
                ) =>
                    total
                    + (
                        query
                            ?.paginationLocalRetries
                        ?? 0
                    ),
                0,
            );

    const totalPaginationRecoveries =
        querySummaryList
            .reduce(
                (
                    total,
                    query,
                ) =>
                    total
                    + (
                        query
                            ?.paginationRecoveries
                        ?? 0
                    ),
                0,
            );

    const totalPaginationFailures =
        querySummaryList
            .reduce(
                (
                    total,
                    query,
                ) =>
                    total
                    + (
                        query
                            ?.paginationFailures
                        ?? 0
                    ),
                0,
            );

    const totalPaginationUiCleanups =
        querySummaryList
            .reduce(
                (
                    total,
                    query,
                ) =>
                    total
                    + (
                        query
                            ?.paginationUiCleanups
                        ?? 0
                    ),
                0,
            );

    const totalPaginationApiFallbacks =
        querySummaryList
            .reduce(
                (
                    total,
                    query,
                ) =>
                    total
                    + (
                        query
                            ?.paginationApiFallbacks
                        ?? 0
                    ),
                0,
            );

    const totalPaginationDomFallbacks =
        querySummaryList
            .reduce(
                (
                    total,
                    query,
                ) =>
                    total
                    + (
                        query
                            ?.paginationDomFallbacks
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
                        nextRecords[
                            id
                        ]
                        || previousRecords[
                            id
                        ];

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

            incompleteQueries,

            coverageComplete:
                overallCoverageComplete,

            detailStrategy,

            detailMaxAgeDays,

            detailFetchLimitPerRun,

            detailFetches:
                detailStats
                    .requested,

            detailFetchSucceeded:
                detailStats
                    .succeeded,

            detailFetchFailed:
                detailStats
                    .failed,

            detailLocalRetries:
                detailStats
                    .localRetries,

            detailBudgetSkips:
                detailStats
                    .budgetSkipped,

            detailFetchReasons:
                detailStats
                    .byReason,

            detailSkips:
                detailStats
                    .skipped,

            paginationLocalRetries:
                totalPaginationLocalRetries,

            paginationRecoveries:
                totalPaginationRecoveries,

            paginationFailures:
                totalPaginationFailures,

            paginationUiCleanups:
                totalPaginationUiCleanups,

            paginationApiFallbacks:
                totalPaginationApiFallbacks,

            paginationDomFallbacks:
                totalPaginationDomFallbacks,

            rawRowsCollected:
                totalRawRowsCollected,

            observedThisRun:
                collected.size,

            duplicateRows:
                totalDuplicateRows,

            sourceFilterMismatches:
                totalSourceFilterMismatches,

            sourceFilterUnverifiableRows:
                totalSourceFilterUnverifiableRows,

            failedFilterIntegrityQueries,

            prunedOutOfScopePreviousRecords,

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

            suppressedOperationalRecords,

            possiblyMissingProducts:
                possiblyMissing
                    .length,

            reappearedProducts:
                reappearedCount,
        },

        teamsNotifications:
            teamsStats,

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

        qualityGatePassed,

        qualityGateReason:
            (
                detectChanges
                && !overallCoverageComplete
            )
                ? (
                    failedFilterIntegrityQueries
                    > 0
                        ? 'SOURCE_FILTER_INTEGRITY_FAILED'
                        : 'INCOMPLETE_MONITORING_COVERAGE'
                )
                : '',

        stateStoreName,

        stateKey,

        watchSignature,

        finishedAt:
            isoNow(),
    };

    await Actor
        .setValue(
            'OUTPUT',
            summary,
        );

    if (
        detectChanges
        && !overallCoverageComplete
    ) {
        log.error(
            'Run failed monitoring quality gate because full BPOM coverage was not achieved.',
            {
                incompleteQueries,

                failedQueries:
                    failedJobs
                        .length,

                snapshotUpdated:
                    snapshotCanUpdate,

                suppressedOperationalRecords,

                failedFilterIntegrityQueries,
            },
        );

        throw new Error(
            failedFilterIntegrityQueries
            > 0
                ? `BPOM source filter integrity failed for ${failedFilterIntegrityQueries} query(s).`
                : `Incomplete BPOM monitoring coverage: ${incompleteQueries} query(s) did not reach a natural end.`,
        );
    }

    log.info(
        'Run finished.',
        summary,
    );
});
