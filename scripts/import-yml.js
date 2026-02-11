const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { isTruthy, parsePositiveInt, parseNumber } = require("./importer/utils");
const { createWithRetry } = require("./importer/retry");
const { fetchBufferWithRetry, saveBuffer } = require("./importer/xml");
const {
    runFullImport,
    runPriceUpdate,
    runStockUpdate,
    runDeltaUpdate,
    buildSupplierSource
} = require("./importer/import");

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

function buildConfigFromEnv() {
    const SUPABASE_URL = process.env.SUPABASE_URL || "";
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

    const SUPPLIER_YML_URL_LEGACY = process.env.SUPPLIER_YML_URL || "";
    const SUPPLIER_YML_PATH_LEGACY = process.env.SUPPLIER_YML_PATH
        || path.join(__dirname, "..", "tmp", "supplier.yml");

    const config = {
        supabase: {
            url: SUPABASE_URL,
            serviceKey: SUPABASE_SERVICE_ROLE_KEY,
            requestTimeoutMs: parsePositiveInt(process.env.SUPABASE_REQUEST_TIMEOUT_MS, 20000)
        },
        supplier: {
            urls: {
                full: process.env.SUPPLIER_FULL_YML_URL || "",
                price: process.env.SUPPLIER_PRICE_YML_URL || "",
                stock: process.env.SUPPLIER_STOCK_YML_URL || "",
                legacy: SUPPLIER_YML_URL_LEGACY
            },
            paths: {
                full: process.env.SUPPLIER_FULL_YML_PATH || "",
                price: process.env.SUPPLIER_PRICE_YML_PATH || "",
                stock: process.env.SUPPLIER_STOCK_YML_PATH || "",
                legacy: SUPPLIER_YML_PATH_LEGACY
            },
            shouldSave: isTruthy(process.env.SUPPLIER_YML_SAVE),
            // Какую цену берем как базовую (base_price). По умолчанию - розница.
            basePriceType: String(process.env.SUPPLIER_BASE_PRICE_TYPE || "Розничная цена").trim(),
            // Если складов несколько: можно выбрать нужный (иначе суммируем).
            stockStore: String(process.env.SUPPLIER_STOCK_STORE || "").trim(),
            priceMultiplier: parseNumber(process.env.PRICE_MULTIPLIER, 1)
        }
    };

    const retryConfig = {
        retryLimit: parsePositiveInt(process.env.UPSERT_RETRIES, 5),
        retryDelayMs: parsePositiveInt(process.env.UPSERT_RETRY_MS, 800),
        maxRetryDelayMs: parsePositiveInt(process.env.UPSERT_RETRY_MAX_MS, 8000),
        rateLimitRetryMs: parsePositiveInt(process.env.RATE_LIMIT_RETRY_MS, 1000),
        rateLimitMaxDelayMs: parsePositiveInt(process.env.RATE_LIMIT_MAX_DELAY_MS, 16000),
        retryJitterMs: parsePositiveInt(process.env.RETRY_JITTER_MS, 250)
    };

    const { withRetry } = createWithRetry(retryConfig);

    const categoryBatchSize = parsePositiveInt(process.env.UPSERT_BATCH_SIZE, 200);
    const productBatchSize = parsePositiveInt(process.env.UPSERT_PRODUCT_BATCH_SIZE, 50);
    const deltaBatchSize = parsePositiveInt(process.env.UPSERT_DELTA_BATCH_SIZE, 200);

    const batchDelayMinMs = parsePositiveInt(process.env.BATCH_DELAY_MIN_MS, 500);
    const batchDelayMaxMs = Math.max(batchDelayMinMs, parsePositiveInt(process.env.BATCH_DELAY_MAX_MS, 1500));
    const batchConcurrency = parsePositiveInt(process.env.BATCH_CONCURRENCY, 3);
    const batchMinConcurrency = parsePositiveInt(process.env.BATCH_MIN_CONCURRENCY, 1);
    const batchMaxConcurrency = Math.max(batchMinConcurrency, batchConcurrency);

    config.retry = { withRetry };
    config.upsert = {
        retry: retryConfig,
        categoryBatchSize,
        productBatchSize,
        deltaBatchSize,
        batchDelayMs: parsePositiveInt(process.env.BATCH_DELAY_MS, 1000),
        batchDelayMinMs,
        batchDelayMaxMs,
        batchJitterMs: parsePositiveInt(process.env.BATCH_JITTER_MS, 100),
        batchConcurrency,
        batchMinConcurrency,
        batchMaxConcurrency,
        batchRampGroups: parsePositiveInt(process.env.BATCH_RAMP_GROUPS, 3)
    };

    return config;
}

async function downloadSource(config, kind) {
    const source = buildSupplierSource(config, kind);
    if (!source.url) {
        throw new Error(`URL для ${kind} не задан (переменные SUPPLIER_*_YML_URL)`);
    }
    if (!source.savePath) {
        throw new Error(`Путь сохранения для ${kind} не задан (переменные SUPPLIER_*_YML_PATH)`);
    }

    const buffer = await fetchBufferWithRetry(source.url, {
        withRetry: config.retry.withRetry,
        label: `${kind} download`
    });
    saveBuffer(buffer, source.savePath);
    console.log(`${kind.toUpperCase()}: сохранено в ${source.savePath}`);
}

async function main() {
    const argv = collectArgs();
    const config = buildConfigFromEnv();

    const wantFull = argv.has("--full") || argv.has("--catalog");
    const wantDelta = argv.has("--delta") || argv.has("--updates");
    const wantPrice = argv.has("--price");
    const wantStock = argv.has("--stock");
    const wantAll = argv.has("--all");

    const shouldDownloadOnly = argv.has("--download")
        || argv.has("--fetch-only")
        || isTruthy(process.env.IMPORT_FETCH_ONLY);
    const dryRun = argv.has("--dry-run") || argv.has("--check");

    const shouldWipe = argv.has("--wipe")
        || argv.has("--clear")
        || argv.has("--reset")
        || isTruthy(process.env.IMPORT_WIPE);

    const tasks = [];
    if (wantAll) {
        tasks.push("full", "delta");
    } else if (wantFull || (!wantDelta && !wantPrice && !wantStock)) {
        tasks.push("full");
    }
    if (wantDelta) {
        tasks.push("delta");
    } else {
        if (wantPrice) {
            tasks.push("price");
        }
        if (wantStock) {
            tasks.push("stock");
        }
    }

    if (shouldDownloadOnly) {
        for (const task of tasks) {
            if (task === "delta") {
                await downloadSource(config, "price");
                await downloadSource(config, "stock");
            } else {
                await downloadSource(config, task);
            }
        }
        return;
    }

    for (const task of tasks) {
        if (task === "full") {
            await runFullImport(config, { wipe: shouldWipe, dryRun });
        } else if (task === "delta") {
            await runDeltaUpdate(config, { dryRun });
        } else if (task === "price") {
            await runPriceUpdate(config, { dryRun });
        } else if (task === "stock") {
            await runStockUpdate(config, { dryRun });
        } else {
            throw new Error(`Unknown task: ${task}`);
        }
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = {
    buildConfigFromEnv,
    downloadSource,
    runFullImport,
    runPriceUpdate,
    runStockUpdate,
    runDeltaUpdate
};

