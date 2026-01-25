const fs = require("fs");
const path = require("path");
const { XMLParser } = require("fast-xml-parser");
const { createClient } = require("@supabase/supabase-js");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const parsePositiveInt = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const BATCH_SIZE = parsePositiveInt(process.env.UPSERT_BATCH_SIZE, 200);
const PRODUCT_BATCH_SIZE = parsePositiveInt(process.env.UPSERT_PRODUCT_BATCH_SIZE, 50);
const RETRY_LIMIT = parsePositiveInt(process.env.UPSERT_RETRIES, 5);
const RETRY_DELAY_MS = parsePositiveInt(process.env.UPSERT_RETRY_MS, 800);
const MAX_RETRY_DELAY_MS = 8000;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
});

const catalogPath = path.join(__dirname, "..", "dixel_complete.yml");
if (!fs.existsSync(catalogPath)) {
    console.error("dixel_complete.yml not found");
    process.exit(1);
}

const xml = fs.readFileSync(catalogPath, "utf8");
const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    textNodeName: "text",
    trimValues: true
});

const data = parser.parse(xml);
const shop = data?.yml_catalog?.shop;
if (!shop) {
    console.error("Invalid catalog format");
    process.exit(1);
}

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

const categories = asArray(shop.categories?.category)
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

const offers = asArray(shop.offers?.offer)
    .map((offer) => {
        const name = String(firstValue(offer.name) || "").trim();
        if (!name) {
            return null;
        }
        const id = offer.id ? String(offer.id) : name;
        const sku = String(firstValue(offer.vendorCode) || id);
        const priceText = String(firstValue(offer.price) || "");
        const priceValue = Number.parseFloat(priceText);
        const basePrice = Number.isFinite(priceValue) ? Math.round(priceValue * 1.29) : null;
        const categoryId = String(firstValue(offer.categoryId) || "") || null;
        const picture = String(firstValue(offer.picture) || "") || null;
        const available = String(offer.available || "") !== "false";
        const outlet = firstValue(offer.outlet);
        const stockValue = outlet && outlet.instock ? Number.parseFloat(outlet.instock) : 0;
        const stock = available && Number.isFinite(stockValue) ? Math.round(stockValue) : 0;

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

const chunk = (list, size) => {
    const chunks = [];
    for (let i = 0; i < list.length; i += size) {
        chunks.push(list.slice(i, i + size));
    }
    return chunks;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetry(task, label) {
    for (let attempt = 1; attempt <= RETRY_LIMIT; attempt += 1) {
        try {
            return await task();
        } catch (error) {
            if (attempt >= RETRY_LIMIT) {
                throw error;
            }
            const delay = Math.min(RETRY_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
            console.warn(`${label}: ошибка, повтор ${attempt}/${RETRY_LIMIT} через ${delay}мс`);
            await sleep(delay);
        }
    }
    return null;
}

async function upsertBatches(table, rows, batchSize) {
    const batches = chunk(rows, batchSize);
    for (let i = 0; i < batches.length; i += 1) {
        const batch = batches[i];
        await withRetry(async () => {
            const { error } = await supabase
                .from(table)
                .upsert(batch, { onConflict: "external_id" });
            if (error) {
                throw error;
            }
        }, `${table} batch ${i + 1}/${batches.length}`);
        console.log(`${table}: ${Math.min((i + 1) * batchSize, rows.length)}/${rows.length}`);
    }
}

(async () => {
    try {
        console.log(`Categories: ${categories.length}`);
        console.log(`Products: ${offers.length}`);
        await upsertBatches("categories", categories, BATCH_SIZE);
        await upsertBatches("products", offers, PRODUCT_BATCH_SIZE);
        console.log("Import completed");
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
})();
