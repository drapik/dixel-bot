const fs = require("fs");
const path = require("path");
const { XMLParser } = require("fast-xml-parser");
const { createClient } = require("@supabase/supabase-js");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const SUPPLIER_YML_URL = process.env.SUPPLIER_YML_URL || "";
const SUPPLIER_YML_PATH = process.env.SUPPLIER_YML_PATH
    || path.join(__dirname, "..", "tmp", "supplier.yml");

const parsePositiveInt = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const TRUTHY = new Set(["1", "true", "yes", "y", "on"]);

const isTruthy = (value) => {
    if (value === undefined || value === null) {
        return false;
    }
    return TRUTHY.has(String(value).trim().toLowerCase());
};


const collectArgs = () => {
    const args = new Set(process.argv.slice(2));
    const npmArgvRaw = process.env.npm_config_argv;
    if (!npmArgvRaw) {
        return args;
    }
    try {
        const npmArgv = JSON.parse(npmArgvRaw);
        const list = Array.isArray(npmArgv.original)
            ? npmArgv.original
            : Array.isArray(npmArgv.cooked)
                ? npmArgv.cooked
                : [];
        list.forEach((entry) => {
            if (typeof entry === "string" && entry.startsWith("--")) {
                args.add(entry);
            }
        });
    } catch (error) {
        return args;
    }
    return args;
};

const BATCH_SIZE = parsePositiveInt(process.env.UPSERT_BATCH_SIZE, 200);
const PRODUCT_BATCH_SIZE = parsePositiveInt(process.env.UPSERT_PRODUCT_BATCH_SIZE, 50);
const RETRY_LIMIT = parsePositiveInt(process.env.UPSERT_RETRIES, 5);
const RETRY_DELAY_MS = parsePositiveInt(process.env.UPSERT_RETRY_MS, 800);
const MAX_RETRY_DELAY_MS = parsePositiveInt(process.env.UPSERT_RETRY_MAX_MS, 8000);
const RATE_LIMIT_RETRY_MS = parsePositiveInt(process.env.RATE_LIMIT_RETRY_MS, 1000);
const RATE_LIMIT_MAX_DELAY_MS = parsePositiveInt(process.env.RATE_LIMIT_MAX_DELAY_MS, 16000);
const RETRY_JITTER_MS = parsePositiveInt(process.env.RETRY_JITTER_MS, 250);
const BATCH_DELAY_MS = parsePositiveInt(process.env.BATCH_DELAY_MS, 1000);
const BATCH_DELAY_MIN_MS = parsePositiveInt(process.env.BATCH_DELAY_MIN_MS, 500);
const BATCH_DELAY_MAX_MS = Math.max(
    BATCH_DELAY_MIN_MS,
    parsePositiveInt(process.env.BATCH_DELAY_MAX_MS, 1500)
);
const BATCH_JITTER_MS = parsePositiveInt(process.env.BATCH_JITTER_MS, 100);
const BATCH_CONCURRENCY = parsePositiveInt(process.env.BATCH_CONCURRENCY, 3);
const BATCH_MIN_CONCURRENCY = parsePositiveInt(process.env.BATCH_MIN_CONCURRENCY, 1);
const BATCH_MAX_CONCURRENCY = Math.max(BATCH_MIN_CONCURRENCY, BATCH_CONCURRENCY);
const BATCH_RAMP_GROUPS = parsePositiveInt(process.env.BATCH_RAMP_GROUPS, 3);
const SUPABASE_REQUEST_TIMEOUT_MS = parsePositiveInt(
    process.env.SUPABASE_REQUEST_TIMEOUT_MS,
    20000
);
const parseNumber = (value, fallback) => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const PRICE_MULTIPLIER = parseNumber(process.env.PRICE_MULTIPLIER, 1);
const argv = collectArgs();
const SHOULD_WIPE = argv.has("--wipe")
    || argv.has("--clear")
    || argv.has("--reset")
    || isTruthy(process.env.IMPORT_WIPE);
const SHOULD_DOWNLOAD_ONLY = argv.has("--download")
    || argv.has("--fetch-only")
    || isTruthy(process.env.IMPORT_FETCH_ONLY);
const SHOULD_SAVE_YML = SHOULD_DOWNLOAD_ONLY || isTruthy(process.env.SUPPLIER_YML_SAVE);

let supabase = null;

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    textNodeName: "text",
    trimValues: true,
    parseTagValue: false,
    parseAttributeValue: false
});

const asArray = (value) => {
    if (!value) {
        return [];
    }
    return Array.isArray(value) ? value : [value];
};

const firstValue = (value) => {
    if (Array.isArray(value)) {
        return value[0];
    }
    return value;
};

const readText = (value) => {
    const raw = firstValue(value);
    if (raw && typeof raw === "object") {
        return raw.text ? String(raw.text).trim() : "";
    }
    return raw ? String(raw).trim() : "";
};

const chunk = (list, size) => {
    const chunks = [];
    for (let i = 0; i < list.length; i += size) {
        chunks.push(list.slice(i, i + size));
    }
    return chunks;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const jitter = (maxMs) => (maxMs > 0 ? Math.floor(Math.random() * maxMs) : 0);

const getErrorStatus = (error) => {
    if (!error) {
        return null;
    }
    const status = Number.parseInt(error.status, 10);
    if (Number.isFinite(status)) {
        return status;
    }
    const code = Number.parseInt(error.code, 10);
    if (Number.isFinite(code)) {
        return code;
    }
    return null;
};

const isRateLimitError = (error) => {
    const status = getErrorStatus(error);
    if (status === 429) {
        return true;
    }
    const message = String(error?.message || "").toLowerCase();
    return message.includes("too many requests") || message.includes("rate limit");
};

const throttleState = {
    delayMs: clamp(BATCH_DELAY_MS, BATCH_DELAY_MIN_MS, BATCH_DELAY_MAX_MS),
    minDelayMs: BATCH_DELAY_MIN_MS,
    maxDelayMs: BATCH_DELAY_MAX_MS,
    concurrency: clamp(BATCH_CONCURRENCY, BATCH_MIN_CONCURRENCY, BATCH_MAX_CONCURRENCY),
    minConcurrency: BATCH_MIN_CONCURRENCY,
    maxConcurrency: BATCH_MAX_CONCURRENCY,
    successStreak: 0,
    rateLimitHits: 0
};

const recordRateLimit = (error) => {
    if (isRateLimitError(error)) {
        throttleState.rateLimitHits += 1;
    }
};

const adjustThrottleAfterGroup = (rateLimited) => {
    if (rateLimited) {
        throttleState.successStreak = 0;
        throttleState.delayMs = clamp(
            Math.round(throttleState.delayMs * 1.5),
            throttleState.minDelayMs,
            throttleState.maxDelayMs
        );
        if (throttleState.concurrency > throttleState.minConcurrency) {
            throttleState.concurrency -= 1;
        }
        return;
    }

    throttleState.successStreak += 1;
    if (throttleState.successStreak >= BATCH_RAMP_GROUPS) {
        throttleState.delayMs = clamp(
            Math.round(throttleState.delayMs * 0.9),
            throttleState.minDelayMs,
            throttleState.maxDelayMs
        );
        if (throttleState.concurrency < throttleState.maxConcurrency) {
            throttleState.concurrency += 1;
        }
        throttleState.successStreak = 0;
    }
};

const computeRetryDelay = (error, attempt) => {
    const isRateLimited = isRateLimitError(error);
    const baseDelay = isRateLimited ? RATE_LIMIT_RETRY_MS : RETRY_DELAY_MS;
    const maxDelay = isRateLimited ? RATE_LIMIT_MAX_DELAY_MS : MAX_RETRY_DELAY_MS;
    const delay = Math.min(baseDelay * 2 ** attempt, maxDelay);
    return delay + jitter(RETRY_JITTER_MS);
};

async function withRetry(task, label) {
    for (let attempt = 0; attempt <= RETRY_LIMIT; attempt += 1) {
        try {
            return await task();
        } catch (error) {
            recordRateLimit(error);
            if (attempt >= RETRY_LIMIT) {
                throw error;
            }
            const delay = computeRetryDelay(error, attempt);
            const status = getErrorStatus(error);
            const statusLabel = status ? `status ${status}` : "ошибка";
            console.warn(`${label}: ${statusLabel}, повтор ${attempt + 1}/${RETRY_LIMIT} через ${delay}мс`);
            await sleep(delay);
        }
    }
    return null;
}

async function fetchBufferWithRetry(url, label) {
    return withRetry(async () => {
        const response = await fetch(url);
        if (!response.ok) {
            const body = await response.text();
            const error = new Error(`${label}: ${response.status} ${body}`);
            error.status = response.status;
            throw error;
        }
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    }, label);
}

function detectXmlEncoding(buffer) {
    if (!buffer || buffer.length === 0) {
        return "utf-8";
    }
    const header = buffer.slice(0, 200).toString("ascii");
    const match = header.match(/encoding=["']([^"']+)["']/i);
    if (!match) {
        return "utf-8";
    }
    const encoding = match[1].trim().toLowerCase();
    if (encoding === "windows-1251" || encoding === "win-1251" || encoding === "cp1251") {
        return "windows-1251";
    }
    return "utf-8";
}

function decodeXmlBuffer(buffer) {
    const encoding = detectXmlEncoding(buffer);
    try {
        return new TextDecoder(encoding).decode(buffer);
    } catch (error) {
        console.warn(`Не удалось декодировать ${encoding}, используем UTF-8`);
        return new TextDecoder("utf-8").decode(buffer);
    }
}

function ensureDirForFile(filePath) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
}

function saveYmlBuffer(buffer, filePath) {
    ensureDirForFile(filePath);
    fs.writeFileSync(filePath, buffer);
}

function normalizeYmlCategories(rawCategories) {
    return rawCategories
        .map((node) => {
            const id = node.id ? String(node.id) : "";
            const name = node.text ? String(node.text).trim() : "";
            if (!id || !name) {
                return null;
            }
            return {
                external_id: id,
                parent_external_id: node.parentId ? String(node.parentId) : null,
                name
            };
        })
        .filter(Boolean);
}

function dedupeByExternalId(rows) {
    const map = new Map();
    rows.forEach((row) => {
        if (row && row.external_id) {
            map.set(row.external_id, row);
        }
    });
    return Array.from(map.values());
}

function parseOfferStock(offer) {
    const availableRaw = offer?.available;
    const available = availableRaw === false ? false : String(availableRaw || "") !== "false";
    if (!available) {
        return 0;
    }

    const outletNodes = asArray(offer?.outlets?.outlet || offer?.outlet);
    let total = 0;
    let parsed = false;
    outletNodes.forEach((outlet) => {
        const instockRaw = outlet && typeof outlet === "object" ? outlet.instock : outlet;
        const value = Number.parseFloat(instockRaw);
        if (Number.isFinite(value)) {
            total += value;
            parsed = true;
        }
    });

    if (parsed) {
        return Math.max(0, Math.round(total));
    }

    const fallbackRaw = firstValue(offer?.stock ?? offer?.quantity ?? offer?.instock ?? offer?.count);
    const fallbackValue = Number.parseFloat(fallbackRaw);
    if (Number.isFinite(fallbackValue)) {
        return Math.max(0, Math.round(fallbackValue));
    }

    return 1;
}

function normalizeOffers(rawOffers) {
    return rawOffers
        .map((offer) => {
            const name = readText(offer?.name);
            if (!name) {
                return null;
            }
            const id = offer?.id ? String(offer.id) : name;
            const vendorCode = readText(offer?.vendorCode);
            const sku = vendorCode || String(id);
            const priceText = readText(offer?.price);
            const priceValue = Number.parseFloat(priceText.replace(",", "."));
            const basePrice = Number.isFinite(priceValue) ? Math.round(priceValue * PRICE_MULTIPLIER) : null;
            const picture = readText(offer?.picture) || null;
            let categoryId = readText(offer?.categoryId) || null;

            const stock = parseOfferStock(offer);

            return {
                external_id: id,
                category_external_id: categoryId,
                sku,
                name,
                base_price: basePrice,
                stock,
                picture_url: picture
            };
        })
        .filter(Boolean);
}

async function loadYmlXml() {
    let buffer = null;

    if (SUPPLIER_YML_URL) {
        console.log(`Скачиваем YML: ${SUPPLIER_YML_URL}`);
        buffer = await fetchBufferWithRetry(SUPPLIER_YML_URL, "yml download");
        if (SHOULD_SAVE_YML) {
            saveYmlBuffer(buffer, SUPPLIER_YML_PATH);
            console.log(`YML сохранен в ${SUPPLIER_YML_PATH}`);
        }
    } else {
        if (!fs.existsSync(SUPPLIER_YML_PATH)) {
            throw new Error(`YML файл не найден: ${SUPPLIER_YML_PATH}`);
        }
        buffer = fs.readFileSync(SUPPLIER_YML_PATH);
    }

    return decodeXmlBuffer(buffer);
}

async function upsertBatches(table, rows, batchSize) {
    const batches = chunk(rows, batchSize);
    for (let i = 0; i < batches.length; i += 1) {
        const batch = batches[i];
        await upsertBatchWithSplit(table, batch, `${table} batch ${i + 1}/${batches.length}`);
        console.log(`${table}: ${Math.min((i + 1) * batchSize, rows.length)}/${rows.length}`);
    }
}

async function upsertBatchesParallel(table, rows, batchSize) {
    const batches = chunk(rows, batchSize);
    let processed = 0;

    for (let i = 0; i < batches.length;) {
        const concurrency = throttleState.concurrency;
        const group = batches.slice(i, Math.min(i + concurrency, batches.length));
        const rateLimitHitsBefore = throttleState.rateLimitHits;

        await Promise.all(group.map((batch, j) =>
            upsertBatchWithSplit(table, batch, `${table} batch ${i + j + 1}/${batches.length}`)
        ));

        processed += group.reduce((sum, batch) => sum + batch.length, 0);
        console.log(`${table}: ${Math.min(processed, rows.length)}/${rows.length}`);

        adjustThrottleAfterGroup(throttleState.rateLimitHits > rateLimitHitsBefore);

        i += group.length;
        if (i < batches.length) {
            const delayMs = throttleState.delayMs + jitter(BATCH_JITTER_MS);
            if (delayMs > 0) {
                await sleep(delayMs);
            }
        }
    }
}

async function upsertBatchWithSplit(table, batch, label) {
    if (!batch.length) {
        return;
    }
    try {
        await withRetry(async () => {
            const { error } = await supabase
                .from(table)
                .upsert(batch, { onConflict: "external_id" });
            if (error) {
                throw error;
            }
        }, label);
    } catch (error) {
        if (batch.length <= 1) {
            throw error;
        }
        const mid = Math.ceil(batch.length / 2);
        console.warn(`${label}: батч не прошел, делим на ${mid} и ${batch.length - mid}`);
        await upsertBatchWithSplit(table, batch.slice(0, mid), `${label}a`);
        await upsertBatchWithSplit(table, batch.slice(mid), `${label}b`);
    }
}

async function clearTable(table) {
    await withRetry(async () => {
        const { error } = await supabase
            .from(table)
            .delete()
            .gte("created_at", "1970-01-01");
        if (error) {
            throw error;
        }
    }, `${table} wipe`);
    console.log(`${table}: cleared`);
}

function createSupabaseClient() {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    }
    const fetchWithTimeout = async (url, options = {}) => {
        if (!SUPABASE_REQUEST_TIMEOUT_MS || SUPABASE_REQUEST_TIMEOUT_MS <= 0) {
            return fetch(url, options);
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), SUPABASE_REQUEST_TIMEOUT_MS);
        try {
            return await fetch(url, { ...options, signal: controller.signal });
        } finally {
            clearTimeout(timeoutId);
        }
    };
    return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
        global: { fetch: fetchWithTimeout }
    });
}

async function downloadYml() {
    if (!SUPPLIER_YML_URL) {
        throw new Error("SUPPLIER_YML_URL is missing");
    }
    const buffer = await fetchBufferWithRetry(SUPPLIER_YML_URL, "yml download");
    saveYmlBuffer(buffer, SUPPLIER_YML_PATH);
    console.log(`YML сохранен в ${SUPPLIER_YML_PATH}`);
    return buffer;
}

async function runImport() {
    supabase = createSupabaseClient();

    if (SHOULD_WIPE) {
        console.log("Режим вайпа включен: таблицы будут очищены перед импортом");
    }

    const xml = await loadYmlXml();
    const data = parser.parse(xml);
    const shop = data?.yml_catalog?.shop;
    if (!shop) {
        throw new Error("Invalid catalog format");
    }

    const rawCategories = asArray(shop.categories?.category);
    const rawOffers = asArray(shop.offers?.offer);

    if (!rawOffers.length) {
        throw new Error("Offers section is empty");
    }

    console.log(`YML categories: ${rawCategories.length}`);
    console.log(`YML offers: ${rawOffers.length}`);

    const categories = dedupeByExternalId(normalizeYmlCategories(rawCategories));
    const categoryIds = new Set(categories.map((category) => String(category.external_id)));
    const missingParentCategories = categories.filter((category) => {
        const parentId = category.parent_external_id
            ? String(category.parent_external_id)
            : null;
        return parentId && !categoryIds.has(parentId);
    });
    if (missingParentCategories.length > 0) {
        console.warn(`Категорий с отсутствующим parentId: ${missingParentCategories.length}`);
        console.warn(missingParentCategories.map((item) => ({
            id: item.external_id,
            parentId: item.parent_external_id,
            name: item.name
        })));
    }

    const categoriesToUpsert = categories.map((category) => ({
        external_id: category.external_id,
        parent_external_id: category.parent_external_id || null,
        name: category.name
    }));

    const offers = dedupeByExternalId(normalizeOffers(rawOffers));
    const missingProductCategories = offers.filter((offer) => {
        if (!offer.category_external_id) {
            return false;
        }
        return !categoryIds.has(String(offer.category_external_id));
    });
    if (missingProductCategories.length > 0) {
        console.warn(`Товаров с отсутствующей категорией: ${missingProductCategories.length}`);
        console.warn(missingProductCategories.map((item) => ({
            id: item.external_id,
            categoryId: item.category_external_id,
            sku: item.sku,
            name: item.name
        })));
    }

    if (!categories.length) {
        throw new Error("Categories list is empty");
    }
    if (!offers.length) {
        throw new Error("Products list is empty");
    }

    console.log(`Categories to import: ${categories.length}`);
    console.log(`Products to import: ${offers.length}`);

    if (SHOULD_WIPE) {
        console.log("Wipe enabled: удаляем товары и категории...");
        await clearTable("products");
        await clearTable("categories");
    }

    await upsertBatchesParallel("categories", categoriesToUpsert, BATCH_SIZE);
    await upsertBatchesParallel("products", offers, PRODUCT_BATCH_SIZE);
    console.log("Import completed");
    return { categories: categories.length, products: offers.length };
}

async function main() {
    try {
        if (SHOULD_DOWNLOAD_ONLY) {
            await downloadYml();
            return;
        }

        await runImport();
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    downloadYml,
    loadYmlXml,
    runImport,
    fetchBufferWithRetry,
    decodeXmlBuffer,
    saveYmlBuffer
};
