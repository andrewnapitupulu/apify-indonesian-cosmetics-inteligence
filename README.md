# Indonesian Cosmetics Intelligence — Apify Actor

MVP Actor for **targeted cosmetics intelligence from the public BPOM Cek Produk registry**.

Instead of attempting to scrape the entire cosmetics registry on every run, this Actor is designed for recurring watchlists such as:

- monitor selected cosmetics brands;
- monitor selected registrants / companies;
- search selected products or BPOM registration numbers;
- watch composition / ingredient keywords supported by BPOM search;
- compare the result with the previous run and classify records as `NEW`, `CHANGED`, or `UNCHANGED`.

> Source: Badan Pengawas Obat dan Makanan Republik Indonesia (BPOM), public Cek Produk website. This Actor is an independent integration and is not affiliated with or endorsed by BPOM.

## What this MVP does

1. Opens the current **Produk Kosmetika** page with Playwright.
2. Uses the visible BPOM filter UI instead of relying on undocumented private endpoints.
3. Scrapes list results and, optionally, attempts to open the product detail dialog.
4. Normalizes results into a stable JSON structure.
5. Deduplicates products by BPOM registration number (NIE).
6. Optionally compares records with a persistent snapshot stored in a named Apify Key-Value Store.
7. Outputs records to the default Apify Dataset.

## Example input

```json
{
  "brands": ["SOMETHINC", "SKINTIFIC"],
  "registrants": [],
  "productNames": [],
  "registrationNumbers": [],
  "compositions": [],
  "maxItemsPerQuery": 100,
  "maxPagesPerQuery": 20,
  "includeDetails": true,
  "detectChanges": true,
  "emit": "changes",
  "stateStoreName": "indonesian-cosmetics-intelligence-state",
  "stateKey": "competitor-watchlist",
  "requestDelayMs": 500
}
```

## Example output

```json
{
  "eventType": "NEW",
  "registrationNumber": "NA18260123456",
  "productName": "Example Brightening Serum",
  "brand": "EXAMPLE",
  "registrant": "EXAMPLE COSMETICS, PT",
  "packaging": "Botol 20 mL",
  "dosageForm": "Cairan",
  "composition": "...",
  "issuedDate": "2026-08-28",
  "expiryDate": "2029-08-28",
  "status": "Aktif",
  "category": "Kosmetika",
  "source": "BPOM RI - Cek Produk",
  "sourceUrl": "https://cekbpom.pom.go.id/produk-kosmetika",
  "matchedBy": {
    "type": "brand",
    "value": "EXAMPLE"
  },
  "detectedAt": "2026-09-02T05:00:00.000Z",
  "changedFields": []
}
```

Actual detail fields depend on what the BPOM interface exposes for the record at runtime. The Actor keeps list-level fields even when the detail dialog cannot be parsed.

## Change detection

When `detectChanges` is enabled, the Actor stores a snapshot in the named Key-Value Store:

```text
SNAPSHOT_<stateKey>
```

On the next successful run:

- record absent from previous snapshot → `NEW`;
- same NIE, different normalized fingerprint → `CHANGED`;
- same fingerprint → `UNCHANGED`.

The MVP deliberately **does not mark a missing result as REMOVED/REVOKED**. A product may disappear from a query because of filtering, pagination limits, or a temporary source issue; calling that a regulatory removal would be unsafe. A future version should implement removal detection only with a verified complete snapshot strategy.

If any query job fails, the snapshot is not replaced. This prevents a partial failed run from becoming the next baseline.

## Why Playwright?

The current BPOM product table is rendered dynamically. This Actor interacts with the public UI rather than hard-coding an undocumented internal endpoint. The tradeoff is higher compute use, but the MVP is easier to understand and more resilient to backend endpoint changes.

## Deploy to Apify

Install the Apify CLI, log in, and from this folder run:

```bash
apify push
```

You can also create an Actor in Apify Console and upload/push this repository.

## Run locally

Requirements: Docker or a local Node.js environment with a compatible Playwright browser.

With Apify CLI:

```bash
apify run
```

The sample input is included in:

```text
storage/key_value_stores/default/INPUT.json
```

## Production recommendations before publishing to Apify Store

- Start with low `maxItemsPerQuery` and one browser concurrency.
- Validate the BPOM site's applicable access/use rules before commercial scale-up.
- Add a proxy strategy only when legitimately needed; do not use it to defeat access controls.
- Add monitoring/alerts for selector changes.
- Add tests based on saved, legally obtained HTML fixtures.
- Keep `includeDetails=false` for high-volume list discovery and run a second enrichment pass only for new records.
- Consider a two-stage architecture for lower cost: discovery → detail enrichment.

## Suggested roadmap

### v0.1 — included here

- BPOM cosmetics watchlists
- brand / registrant / product / NIE / composition queries
- structured dataset
- detail-dialog enrichment (best effort)
- persistent change detection

### v0.2

- BPOM Public Warning / dangerous cosmetics feed
- explicit `WARNING_ADDED` events
- webhook-friendly compact event dataset

### v0.3

- scheduled competitor watch presets
- richer trend aggregation (registrations per brand / month)
- separate `discover` and `enrich` modes to reduce browser cost

### v1.0 — Indonesian Cosmetics Intelligence

- BPOM registry + BPOM public warnings
- marketplace product/pricing connectors where permitted
- cross-source product/entity resolution
- competitor launch radar
- market trend aggregates
- API-friendly product intelligence layer

## Important scope note

A BPOM registration record is regulatory registry data; it should not be represented as a guarantee that a marketplace listing is genuine, safe for a specific person, or identical to the registered item. Matching a listing to BPOM data requires additional product-identity checks.
