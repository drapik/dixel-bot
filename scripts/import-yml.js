const fs = require("fs");
const path = require("path");
const { XMLParser } = require("fast-xml-parser");
const { createClient } = require("@supabase/supabase-js");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const DIXEL_BASE_URL = process.env.DIXEL_BASE_URL || "https://dixel-light.ru";
const DIXEL_API_BASE_URL = process.env.DIXEL_API_BASE_URL || `${DIXEL_BASE_URL}/api/rest/v1`;
const DIXEL_LOGIN = process.env.DIXEL_LOGIN || "";
const DIXEL_PASSWORD = process.env.DIXEL_PASSWORD || "";
const DIXEL_YML_URL = process.env.DIXEL_YML_URL || "";
const DIXEL_YML_PATH = process.env.DIXEL_YML_PATH || path.join(__dirname, "..", "dixel_complete.yml");

const parsePositiveInt = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const BATCH_SIZE = parsePositiveInt(process.env.UPSERT_BATCH_SIZE, 200);
const PRODUCT_BATCH_SIZE = parsePositiveInt(process.env.UPSERT_PRODUCT_BATCH_SIZE, 500);
const RETRY_LIMIT = parsePositiveInt(process.env.UPSERT_RETRIES, 5);
const RETRY_DELAY_MS = parsePositiveInt(process.env.UPSERT_RETRY_MS, 800);
const MAX_RETRY_DELAY_MS = 8000;
const PAGE_DELAY_MS = parsePositiveInt(process.env.DIXEL_PAGE_DELAY_MS, 50);
const PAGE_SIZE = Math.max(1, Math.min(parsePositiveInt(process.env.DIXEL_PAGE_SIZE, 20), 20));
const PRICE_MULTIPLIER = 1.29;
const argv = new Set(process.argv.slice(2));
const SHOULD_WIPE = argv.has("--wipe")
    || argv.has("--clear")
    || argv.has("--reset")
    || ["1", "true", "yes", "y", "on"].includes(String(process.env.IMPORT_WIPE || "").trim().toLowerCase());

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
});

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    textNodeName: "text",
    trimValues: true
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

function mergeCookies(cookies, response) {
    const setCookie = response.headers.getSetCookie
        ? response.headers.getSetCookie()
        : (response.headers.get("set-cookie") ? [response.headers.get("set-cookie")] : []);

    setCookie.forEach((cookieStr) => {
        if (!cookieStr) {
            return;
        }
        const [pair] = cookieStr.split(";");
        const eqIndex = pair.indexOf("=");
        if (eqIndex === -1) {
            return;
        }
        const name = pair.slice(0, eqIndex).trim();
        const value = pair.slice(eqIndex + 1).trim();
        if (name) {
            cookies[name] = value;
        }
    });
}

function cookieHeader(cookies) {
    return Object.entries(cookies)
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");
}

async function fetchTextWithRetry(url, label) {
    return withRetry(async () => {
        const response = await fetch(url);
        if (!response.ok) {
            const body = await response.text();
            throw new Error(`${label}: ${response.status} ${body}`);
        }
        return response.text();
    }, label);
}

async function requestJson(session, url, options, label) {
    return withRetry(async () => {
        const response = await fetch(url, options);
        mergeCookies(session.cookies, response);
        if (!response.ok) {
            const body = await response.text();
            throw new Error(`${label}: ${response.status} ${body}`);
        }
        return response.json();
    }, label);
}

async function createDixelSession() {
    if (!DIXEL_LOGIN || !DIXEL_PASSWORD) {
        return null;
    }

    const session = { cookies: {}, csrfToken: "" };
    await withRetry(async () => {
        const response = await fetch(`${DIXEL_BASE_URL}/login/`);
        mergeCookies(session.cookies, response);
        if (!response.ok) {
            throw new Error(`login page: ${response.status}`);
        }
    }, "login page");

    const csrfToken = session.cookies.csrftoken;
    if (!csrfToken) {
        throw new Error("Не удалось получить csrftoken");
    }

    await requestJson(
        session,
        `${DIXEL_API_BASE_URL}/login/`,
        {
            method: "POST",
            headers: {
                Referer: `${DIXEL_BASE_URL}/login/`,
                "X-CSRFToken": csrfToken,
                "Content-Type": "application/json",
                Cookie: cookieHeader(session.cookies)
            },
            body: JSON.stringify({ username: DIXEL_LOGIN, password: DIXEL_PASSWORD })
        },
        "login"
    );

    session.csrfToken = session.cookies.csrftoken || csrfToken;
    return session;
}

function apiHeaders(session, referer = `${DIXEL_BASE_URL}/catalog/`) {
    return {
        Referer: referer,
        "X-CSRFToken": session.csrfToken,
        "Content-Type": "application/json",
        Cookie: cookieHeader(session.cookies)
    };
}

async function fetchApiCategories(session) {
    const data = await requestJson(
        session,
        `${DIXEL_API_BASE_URL}/catalog/categories/`,
        {
            method: "POST",
            headers: apiHeaders(session),
            body: JSON.stringify({ search_text: null, categories: [] })
        },
        "categories"
    );
    return Array.isArray(data) ? data : [];
}

async function fetchAllApiProducts(session) {
    const products = [];
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages) {
        const payload = await requestJson(
            session,
            `${DIXEL_API_BASE_URL}/catalog/products/`,
            {
                method: "POST",
                headers: apiHeaders(session),
                body: JSON.stringify({ page, page_size: PAGE_SIZE })
            },
            `products page ${page}`
        );

        const results = Array.isArray(payload?.results) ? payload.results : [];
        const pagination = payload?.pagination || {};
        const totalFromApi = Number.parseInt(pagination.count_pages, 10);
        if (Number.isFinite(totalFromApi) && totalFromApi > 0) {
            totalPages = totalFromApi;
        }

        products.push(...results);

        if (page >= totalPages) {
            break;
        }

        page += 1;
        if (PAGE_DELAY_MS > 0) {
            await sleep(PAGE_DELAY_MS);
        }
    }

    return products;
}

function normalizeApiCategories(apiCategories) {
    return apiCategories
        .map((category) => {
            const id = category?.id ? String(category.id) : "";
            const name = category?.name ? String(category.name).trim() : "";
            if (!id || !name) {
                return null;
            }
            return {
                external_id: id,
                parent_external_id: category.parent_id ? String(category.parent_id) : null,
                name
            };
        })
        .filter(Boolean);
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

function buildCategoryDepth(categories) {
    const byId = {};
    categories.forEach((category) => {
        byId[category.external_id] = category;
    });

    const depthById = {};
    const visiting = new Set();

    const getDepth = (id) => {
        if (depthById[id]) {
            return depthById[id];
        }
        if (visiting.has(id)) {
            return 1;
        }
        visiting.add(id);
        const parentId = byId[id]?.parent_external_id;
        const depth = parentId && byId[parentId] ? getDepth(parentId) + 1 : 1;
        visiting.delete(id);
        depthById[id] = depth;
        return depth;
    };

    Object.keys(byId).forEach((id) => getDepth(id));
    return depthById;
}

function pickDeepestCategory(categoryIds, depthById) {
    let bestId = null;
    let bestDepth = -1;
    categoryIds.forEach((categoryId) => {
        if (!categoryId) {
            return;
        }
        const id = String(categoryId);
        const depth = depthById[id] || 1;
        if (depth > bestDepth) {
            bestDepth = depth;
            bestId = id;
        }
    });
    return bestId;
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
    return Number.isFinite(fallbackValue) ? Math.max(0, Math.round(fallbackValue)) : 0;
}

function normalizeOffers(rawOffers, apiSnapshot) {
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
            const priceValue = Number.parseFloat(priceText);
            const basePrice = Number.isFinite(priceValue) ? Math.round(priceValue * PRICE_MULTIPLIER) : null;
            const picture = readText(offer?.picture) || null;
            let categoryId = readText(offer?.categoryId) || null;

            if (apiSnapshot && vendorCode) {
                const apiProduct = apiSnapshot.productsByCode[vendorCode];
                if (apiProduct && Array.isArray(apiProduct.categories) && apiProduct.categories.length) {
                    const deepest = pickDeepestCategory(apiProduct.categories, apiSnapshot.categoryDepthById);
                    if (deepest) {
                        categoryId = deepest;
                    }
                }
            }

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
    if (DIXEL_YML_URL) {
        console.log(`Скачиваем YML: ${DIXEL_YML_URL}`);
        return fetchTextWithRetry(DIXEL_YML_URL, "yml download");
    }

    if (!fs.existsSync(DIXEL_YML_PATH)) {
        throw new Error(`YML файл не найден: ${DIXEL_YML_PATH}`);
    }
    return fs.readFileSync(DIXEL_YML_PATH, "utf8");
}

async function loadApiSnapshot() {
    if (!DIXEL_LOGIN || !DIXEL_PASSWORD) {
        console.warn("DIXEL_LOGIN/DIXEL_PASSWORD не заданы, используем категории из YML");
        return null;
    }

    console.log("Авторизация в Dixel API...");
    const session = await createDixelSession();
    if (!session) {
        return null;
    }

    console.log("Загружаем категории из API...");
    const apiCategories = await fetchApiCategories(session);
    const categories = normalizeApiCategories(apiCategories);
    console.log(`Категорий из API: ${categories.length}`);

    console.log("Загружаем товары из API...");
    const apiProducts = await fetchAllApiProducts(session);
    const productsByCode = {};
    apiProducts.forEach((product) => {
        const code = product?.code ? String(product.code) : "";
        if (code) {
            productsByCode[code] = product;
        }
    });
    console.log(`Товаров из API: ${Object.keys(productsByCode).length}`);

    const categoryDepthById = buildCategoryDepth(categories);

    return {
        categories,
        productsByCode,
        categoryDepthById
    };
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

(async () => {
    try {
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

        const apiSnapshot = await loadApiSnapshot();
        const categories = dedupeByExternalId(
            apiSnapshot ? apiSnapshot.categories : normalizeYmlCategories(rawCategories)
        );
        const offers = dedupeByExternalId(normalizeOffers(rawOffers, apiSnapshot));

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

        await upsertBatches("categories", categories, BATCH_SIZE);
        await upsertBatches("products", offers, PRODUCT_BATCH_SIZE);
        console.log("Import completed");
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
})();
