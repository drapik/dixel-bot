const { createXmlParser, loadXmlString } = require("./xml");
const { parseFullCatalog, parsePriceUpdates, parseStockUpdates } = require("./parse");
const { createSupabaseClient, createUpsertRunner } = require("./supabase");

function buildSupplierSource(config, kind) {
    const supplier = config.supplier || {};
    const paths = supplier.paths || {};
    const urls = supplier.urls || {};

    if (kind === "full") {
        return {
            url: urls.full || urls.legacy || "",
            filePath: paths.full || paths.legacy || "",
            savePath: paths.full || paths.legacy || ""
        };
    }

    if (kind === "price") {
        return {
            url: urls.price || "",
            filePath: paths.price || "",
            savePath: paths.price || ""
        };
    }

    if (kind === "stock") {
        return {
            url: urls.stock || "",
            filePath: paths.stock || "",
            savePath: paths.stock || ""
        };
    }

    throw new Error(`Unknown supplier source kind: ${kind}`);
}

async function loadParsedData(config, kind, { withRetry, shouldSave } = {}) {
    const parser = createXmlParser();
    const source = buildSupplierSource(config, kind);
    const xml = await loadXmlString({
        url: source.url,
        filePath: source.filePath,
        savePath: source.savePath,
        shouldSave: Boolean(shouldSave),
        withRetry,
        label: `${kind} xml download`
    });
    return parser.parse(xml);
}

function createRuntime(config) {
    const supabase = createSupabaseClient({
        url: config.supabase.url,
        serviceKey: config.supabase.serviceKey,
        requestTimeoutMs: config.supabase.requestTimeoutMs
    });

    const upsert = createUpsertRunner(supabase, config.upsert);

    return { supabase, upsert };
}

async function runFullImport(config, { wipe = false, dryRun = false } = {}) {
    const { withRetry } = config.retry;
    const data = await loadParsedData(config, "full", {
        withRetry,
        shouldSave: config.supplier.shouldSave
    });

    const { categories, offers } = parseFullCatalog(data, config.supplier);

    console.log(`FULL: categories=${categories.length} offers=${offers.length}`);
    if (dryRun) {
        return { categories: categories.length, products: offers.length, dryRun: true };
    }

    const { upsert } = createRuntime(config);

    if (wipe) {
        console.log("Wipe enabled: удаляем товары и категории...");
        await upsert.clearTable("products");
        await upsert.clearTable("categories");
    }

    const categoriesToUpsert = categories.map((category) => ({
        external_id: category.external_id,
        parent_external_id: category.parent_external_id || null,
        name: category.name
    }));

    await upsert.upsertBatchesParallel("categories", categoriesToUpsert, config.upsert.categoryBatchSize);
    await upsert.upsertBatchesParallel("products", offers, config.upsert.productBatchSize);

    console.log("Full import completed");
    return { categories: categories.length, products: offers.length };
}

async function runPriceUpdate(config, { dryRun = false } = {}) {
    const { withRetry } = config.retry;
    const data = await loadParsedData(config, "price", {
        withRetry,
        shouldSave: config.supplier.shouldSave
    });

    const { updates } = parsePriceUpdates(data, config.supplier);
    console.log(`PRICE: offers=${updates.length}`);
    if (dryRun) {
        return { updated: updates.length, dryRun: true };
    }

    const { upsert } = createRuntime(config);

    const ids = updates.map((row) => row.external_id);
    const nameMap = await upsert.fetchProductNameMap(ids);
    const filtered = updates
        .map((row) => {
            const id = String(row.external_id);
            const name = nameMap.get(id);
            if (!name) {
                return null;
            }
            return { external_id: id, name, base_price: row.base_price };
        })
        .filter(Boolean);

    if (filtered.length !== updates.length) {
        console.warn(`PRICE: пропускаем новых товаров: ${updates.length - filtered.length}`);
    }

    if (!filtered.length) {
        console.log("PRICE: нет данных для обновления");
        return { updated: 0 };
    }

    await upsert.upsertBatchesParallel("products", filtered, config.upsert.deltaBatchSize);
    console.log("Price update completed");
    return { updated: filtered.length };
}

async function runStockUpdate(config, { dryRun = false } = {}) {
    const { withRetry } = config.retry;
    const data = await loadParsedData(config, "stock", {
        withRetry,
        shouldSave: config.supplier.shouldSave
    });

    const { updates } = parseStockUpdates(data, config.supplier);
    console.log(`STOCK: offers=${updates.length}`);
    if (dryRun) {
        return { updated: updates.length, dryRun: true };
    }

    const { upsert } = createRuntime(config);

    const ids = updates.map((row) => row.external_id);
    const nameMap = await upsert.fetchProductNameMap(ids);
    const filtered = updates
        .map((row) => {
            const id = String(row.external_id);
            const name = nameMap.get(id);
            if (!name) {
                return null;
            }
            return { external_id: id, name, stock: row.stock };
        })
        .filter(Boolean);

    if (filtered.length !== updates.length) {
        console.warn(`STOCK: пропускаем новых товаров: ${updates.length - filtered.length}`);
    }

    if (!filtered.length) {
        console.log("STOCK: нет данных для обновления");
        return { updated: 0 };
    }

    await upsert.upsertBatchesParallel("products", filtered, config.upsert.deltaBatchSize);
    console.log("Stock update completed");
    return { updated: filtered.length };
}

async function runDeltaUpdate(config, { dryRun = false } = {}) {
    const priceResult = await runPriceUpdate(config, { dryRun });
    const stockResult = await runStockUpdate(config, { dryRun });
    return { price: priceResult, stock: stockResult };
}

module.exports = {
    runFullImport,
    runPriceUpdate,
    runStockUpdate,
    runDeltaUpdate,
    buildSupplierSource,
    loadParsedData
};
