const crypto = require("crypto");
const path = require("path");
const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const nacl = require("tweetnacl");
const { parseChatId, DEFAULT_ADMIN_ID } = require("./bot/lib/env");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_ADMIN_ID = parseChatId(process.env.TELEGRAM_ADMIN_ID) ?? DEFAULT_ADMIN_ID;
const ORDER_TIMEZONE = String(process.env.ORDER_TIMEZONE || process.env.TZ || "Europe/Moscow").trim();

const { formatOrderMessage, formatMoyskladExportFailureMessage } = require("./bot/lib/formatters");
const {
    insertOrderWithItems,
    findOrderByClientOrderId,
    isClientOrderIdConflictError,
    updateOrderMoyskladStatus,
    updateOrderStatusByMoyskladOrderId,
    fetchProductMoyskladMap,
    fetchCustomerOrders
} = require("./lib/order-storage");
const { buildTrustedOrderFromCart } = require("./lib/order-pricing");
const {
    getMoyskladToken,
    getStoreId,
    buildCustomerOrderPayload,
    createCustomerOrder
} = require("./lib/moysklad-orders");
const {
    extractRows,
    resolveEventStatus
} = require("./lib/moysklad-order-status-sync");
const { ensureMoyskladProductLinks } = require("./lib/moysklad-product-sync");
const { withRetries } = require("./lib/retry");
const { createCatalogCache, buildCatalogCacheKey } = require("./lib/catalog-cache");

const DISCOUNTS = {
    base: 0,
    minus5: 0.05,
    minus8: 0.08,
    minus10: 0.1
};
const OPEN_REGISTRATION_STATUSES = ["pending", "claimed"];
const SESSION_STATUS = {
    active: "active",
    pending: "pending",
    notRegistered: "not_registered",
    blocked: "blocked"
};
const CATALOG_DEFAULT_LIMIT = 24;
const CATALOG_MAX_LIMIT = 50;
const PRICING_CHUNK_SIZE = 200;
const CATEGORY_CACHE_TTL_MS = 60 * 1000;
const CATALOG_RESPONSE_CACHE_TTL_MS = Number.parseInt(
    String(process.env.CATALOG_RESPONSE_CACHE_TTL_MS || "30000"),
    10
);
const CATALOG_RESPONSE_CACHE_MAX_ENTRIES = Number.parseInt(
    String(process.env.CATALOG_RESPONSE_CACHE_MAX_ENTRIES || "300"),
    10
);

const categoryCache = {
    loadedAt: 0,
    categories: [],
    hiddenCategoryIds: new Set(),
    visibleCategories: []
};
const catalogResponseCache = createCatalogCache({
    ttlMs: Number.isFinite(CATALOG_RESPONSE_CACHE_TTL_MS) && CATALOG_RESPONSE_CACHE_TTL_MS > 0
        ? CATALOG_RESPONSE_CACHE_TTL_MS
        : 30000,
    maxEntries: Number.isFinite(CATALOG_RESPONSE_CACHE_MAX_ENTRIES) && CATALOG_RESPONSE_CACHE_MAX_ENTRIES > 0
        ? CATALOG_RESPONSE_CACHE_MAX_ENTRIES
        : 300
});

const MOYSKLAD_ORGANIZATION_ID = "9d1894be-4185-11ed-0a80-0b95001b946e";
const MOYSKLAD_STORE_NAME = "Основной склад";

const app = express();
app.use(express.json({ limit: "1mb" }));

const staticRoot = path.join(__dirname, "..");

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.warn("Supabase env is missing; pricing API will stay locked.");
}

if (!TELEGRAM_BOT_TOKEN) {
    console.warn("TELEGRAM_BOT_TOKEN is missing; pricing API will stay locked.");
}

async function sendTelegramMessage(chatId, text) {
    if (!TELEGRAM_BOT_TOKEN) {
        throw new Error("TELEGRAM_BOT_TOKEN is missing");
    }
    if (!chatId) {
        throw new Error("Telegram chatId is missing");
    }

    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            chat_id: chatId,
            text
        })
    });

    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Telegram sendMessage failed (${response.status}): ${body}`.slice(0, 500));
    }

    return response.json().catch(() => null);
}

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false }
    })
    : null;

app.get("/dixel_complete.yml", (req, res) => {
    res.status(404).end();
});

async function fetchAllCategories(
    supabase,
    fields = "external_id, parent_external_id, name, hidden"
) {
    const PAGE_SIZE = 1000;
    let allCategories = [];
    let from = 0;

    while (true) {
        const { data, error } = await supabase
            .from("categories")
            .select(fields)
            .range(from, from + PAGE_SIZE - 1);

        if (error) {
            throw error;
        }

        if (!data || data.length === 0) {
            break;
        }

        allCategories = allCategories.concat(data);

        if (data.length < PAGE_SIZE) {
            break;
        }

        from += PAGE_SIZE;
    }

    return allCategories;
}

function buildHiddenCategorySet(categories) {
    const byId = {};
    (categories || []).forEach((category) => {
        if (category && category.external_id) {
            byId[String(category.external_id)] = category;
        }
    });

    const hiddenById = {};
    const visiting = new Set();

    const resolveHidden = (id) => {
        if (!id || !byId[id]) {
            return false;
        }
        if (hiddenById[id] !== undefined) {
            return hiddenById[id];
        }
        if (visiting.has(id)) {
            hiddenById[id] = false;
            return false;
        }
        visiting.add(id);
        const category = byId[id];
        const parentId = category.parent_external_id ? String(category.parent_external_id) : null;
        const hidden = Boolean(category.hidden) || (parentId ? resolveHidden(parentId) : false);
        visiting.delete(id);
        hiddenById[id] = hidden;
        return hidden;
    };

    const hiddenIds = new Set();
    Object.keys(byId).forEach((id) => {
        if (resolveHidden(id)) {
            hiddenIds.add(id);
        }
    });
    return hiddenIds;
}

function parseCatalogLimit(rawValue) {
    const parsed = Number.parseInt(String(rawValue || ""), 10);
    if (!Number.isFinite(parsed)) {
        return CATALOG_DEFAULT_LIMIT;
    }
    return Math.max(1, Math.min(CATALOG_MAX_LIMIT, parsed));
}

function parseCatalogOffset(rawValue) {
    const parsed = Number.parseInt(String(rawValue || ""), 10);
    if (!Number.isFinite(parsed)) {
        return 0;
    }
    return Math.max(0, parsed);
}

function parseCategoryIds(rawValue) {
    const rawItems = Array.isArray(rawValue)
        ? rawValue
        : String(rawValue || "").split(",");
    return Array.from(
        new Set(
            rawItems
                .map((value) => String(value || "").trim())
                .filter(Boolean)
        )
    );
}

function parseSearchQuery(rawValue) {
    return String(rawValue || "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 120);
}

function buildSearchOrFilter(searchQuery) {
    if (!searchQuery) {
        return "";
    }

    const sanitized = searchQuery
        .replace(/[(),]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    if (!sanitized) {
        return "";
    }

    const pattern = `*${sanitized}*`;
    return `name.ilike.${pattern},sku.ilike.${pattern}`;
}

function buildPostgrestInList(values) {
    const escaped = values.map((value) => {
        const text = String(value || "")
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"');
        return `"${text}"`;
    });
    return `(${escaped.join(",")})`;
}

function chunkArray(items, chunkSize) {
    const chunks = [];
    for (let i = 0; i < items.length; i += chunkSize) {
        chunks.push(items.slice(i, i + chunkSize));
    }
    return chunks;
}

function mapCategoryForCatalog(category) {
    return {
        id: category.external_id,
        parentId: category.parent_external_id,
        name: category.name
    };
}

function mapProductForCatalog(product) {
    if (!product?.external_id || !product?.name) {
        return null;
    }
    const stock = Number.parseFloat(product.stock);
    return {
        id: product.external_id,
        categoryId: product.category_external_id,
        sku: product.sku,
        name: product.name,
        stock,
        picture: product.picture_url,
        available: Number.isFinite(stock) ? stock > 0 : false
    };
}

async function getCategorySnapshot(supabase, { forceRefresh = false } = {}) {
    const now = Date.now();
    const isFresh = !forceRefresh
        && categoryCache.loadedAt
        && now - categoryCache.loadedAt < CATEGORY_CACHE_TTL_MS;

    if (isFresh) {
        return {
            hiddenCategoryIds: categoryCache.hiddenCategoryIds,
            visibleCategories: categoryCache.visibleCategories
        };
    }

    const categories = await fetchAllCategories(
        supabase,
        "external_id, parent_external_id, name, hidden"
    );
    const hiddenCategoryIds = buildHiddenCategorySet(categories);
    const visibleCategories = (categories || []).filter((category) => {
        if (!category?.external_id) {
            return false;
        }
        return !hiddenCategoryIds.has(String(category.external_id));
    });

    categoryCache.loadedAt = now;
    categoryCache.categories = categories;
    categoryCache.hiddenCategoryIds = hiddenCategoryIds;
    categoryCache.visibleCategories = visibleCategories;
    // Категории влияют на фильтрацию каталога, поэтому сбрасываем кэш выдачи.
    catalogResponseCache.clear();

    return {
        hiddenCategoryIds,
        visibleCategories
    };
}

async function fetchCatalogPayload({
    limit,
    offset,
    withCategories,
    searchQuery,
    requestedCategoryIds
}) {
    const { hiddenCategoryIds, visibleCategories } = await getCategorySnapshot(supabase);
    const visibleRequestedCategoryIds = requestedCategoryIds.filter(
        (categoryId) => !hiddenCategoryIds.has(categoryId)
    );

    if (requestedCategoryIds.length > 0 && !visibleRequestedCategoryIds.length) {
        const emptyPayload = {
            products: [],
            pagination: {
                limit,
                offset,
                hasMore: false,
                nextOffset: offset
            }
        };
        if (withCategories) {
            emptyPayload.categories = visibleCategories.map(mapCategoryForCatalog);
        }
        return emptyPayload;
    }

    let query = supabase
        .from("products")
        .select("external_id, category_external_id, sku, name, stock, picture_url")
        .gt("stock", 0)
        .order("external_id", { ascending: true })
        .range(offset, offset + limit);

    const searchOrFilter = buildSearchOrFilter(searchQuery);
    if (searchOrFilter) {
        query = query.or(searchOrFilter);
    }

    if (visibleRequestedCategoryIds.length) {
        query = query.in("category_external_id", visibleRequestedCategoryIds);
    } else if (hiddenCategoryIds.size) {
        query = query.not(
            "category_external_id",
            "in",
            buildPostgrestInList(Array.from(hiddenCategoryIds))
        );
    }

    const { data: rawProducts, error } = await query;
    if (error) {
        throw error;
    }

    const products = (rawProducts || [])
        .filter((product) => {
            const categoryId = product?.category_external_id
                ? String(product.category_external_id)
                : "";
            if (!categoryId) {
                return true;
            }
            return !hiddenCategoryIds.has(categoryId);
        })
        .map(mapProductForCatalog)
        .filter(Boolean);

    const hasMore = products.length > limit;
    const pageItems = hasMore ? products.slice(0, limit) : products;

    const payload = {
        products: pageItems,
        pagination: {
            limit,
            offset,
            hasMore,
            nextOffset: offset + pageItems.length
        }
    };

    if (withCategories) {
        payload.categories = visibleCategories.map(mapCategoryForCatalog);
    }

    return payload;
}

async function warmupCatalogCache() {
    if (!supabase) {
        return;
    }

    const request = {
        limit: CATALOG_DEFAULT_LIMIT,
        offset: 0,
        withCategories: true,
        searchQuery: "",
        requestedCategoryIds: []
    };
    const key = buildCatalogCacheKey(request);

    if (catalogResponseCache.get(key)) {
        return;
    }

    try {
        const payload = await fetchCatalogPayload(request);
        catalogResponseCache.set(key, payload);
        console.log("✅ [CATALOG] Warmup cache готов");
    } catch (error) {
        console.warn("⚠️ [CATALOG] Warmup cache failed:", String(error?.message || error));
    }
}

app.get("/api/catalog", async (req, res) => {
    const initData = extractInitData(req);

    try {
        const session = await resolveSessionStateByInitData(initData);
        if (!session.ok) {
            return res.status(session.httpStatus).json({ error: session.error });
        }

        if (session.sessionStatus !== SESSION_STATUS.active) {
            return res.status(403).json({ error: mapSessionStatusToAccessError(session.sessionStatus) });
        }

        const request = {
            limit: parseCatalogLimit(req.query?.limit),
            offset: parseCatalogOffset(req.query?.offset),
            withCategories: String(req.query?.withCategories || "0") === "1",
            searchQuery: parseSearchQuery(req.query?.q),
            requestedCategoryIds: parseCategoryIds(req.query?.categoryIds)
        };
        const cacheKey = buildCatalogCacheKey(request);
        const cachedPayload = catalogResponseCache.get(cacheKey);

        if (cachedPayload) {
            res.set("x-catalog-cache", "HIT");
            return res.json(cachedPayload);
        }

        const payload = await fetchCatalogPayload(request);
        catalogResponseCache.set(cacheKey, payload);
        res.set("x-catalog-cache", "MISS");
        return res.json(payload);
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: "catalog_fetch_failed" });
    }
});

app.get("/api/session/status", async (req, res) => {
    const initData = extractInitData(req);

    try {
        const session = await resolveSessionStateByInitData(initData);
        if (!session.ok) {
            return res.status(session.httpStatus).json({
                ok: false,
                status: "unauthorized",
                error: session.error
            });
        }

        return res.json({
            ok: true,
            status: session.sessionStatus
        });
    } catch (error) {
        console.error("❌ [SERVER] /api/session/status failed:", error);
        return res.status(500).json({
            ok: false,
            status: "unauthorized",
            error: "session_status_failed"
        });
    }
});

function verifyTelegramInitData(initData) {
    if (!initData || !TELEGRAM_BOT_TOKEN) {
        console.log("❌ [VERIFY] Отсутствует initData или TELEGRAM_BOT_TOKEN");
        return false;
    }

    const cleanToken = TELEGRAM_BOT_TOKEN.replace(/[\r\n\s]/g, "");
    const params = new URLSearchParams(initData);
    const signature = params.get("signature");
    const hash = params.get("hash");

    // Новый метод: Ed25519 signature (если есть signature)
    if (signature) {
        try {
            const botId = cleanToken.split(':')[0];

            // Собираем параметры, исключая hash и signature
            const dataParams = [];
            for (const [key, value] of params.entries()) {
                if (key !== 'hash' && key !== 'signature') {
                    dataParams.push({ key, value });
                }
            }

            dataParams.sort((a, b) => a.key.localeCompare(b.key));
            const sortedPairs = dataParams.map(p => `${p.key}=${p.value}`);
            const dataCheckString = botId + ":WebAppData\n" + sortedPairs.join("\n");

            // Telegram публичный ключ Ed25519 (продакшн)
            const TELEGRAM_PUBLIC_KEY_HEX = "e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d";
            const publicKey = Buffer.from(TELEGRAM_PUBLIC_KEY_HEX, 'hex');

            // Декодируем signature из base64url
            const signatureBase64url = signature.replace(/-/g, '+').replace(/_/g, '/');
            const paddedSignature = signatureBase64url + '='.repeat((4 - signatureBase64url.length % 4) % 4);
            const signatureBuffer = Buffer.from(paddedSignature, 'base64');

            // Проверяем подпись
            const message = Buffer.from(dataCheckString, 'utf8');
            return nacl.sign.detached.verify(message, signatureBuffer, publicKey);
        } catch (error) {
            console.error("❌ [VERIFY] Ошибка проверки signature:", error);
            return false;
        }
    }

    // Старый метод: HMAC-SHA256 с hash
    if (!hash) {
        return false;
    }

    const pairs = initData.split('&').filter(pair => {
        const key = pair.split('=')[0];
        return key !== 'hash' && key !== 'signature';
    });
    
    pairs.sort((a, b) => {
        const keyA = a.split('=')[0];
        const keyB = b.split('=')[0];
        return keyA.localeCompare(keyB);
    });
    
    const dataCheckString = pairs.join("\n");
    const secret = crypto.createHmac("sha256", "WebAppData").update(cleanToken).digest();
    const hmac = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");

    return hmac === hash;
}

function parseTelegramUser(initData) {
    const params = new URLSearchParams(initData);
    const userRaw = params.get("user");
    if (!userRaw) {
        return null;
    }
    try {
        return JSON.parse(userRaw);
    } catch (error) {
        return null;
    }
}

function extractInitData(req) {
    const bodyValue = req.body?.initData;
    if (typeof bodyValue === "string" && bodyValue.trim()) {
        return bodyValue.trim();
    }

    const headerValue = req.headers["x-telegram-init-data"];
    return typeof headerValue === "string" ? headerValue.trim() : "";
}

function normalizeAccessStatus(value) {
    return String(value || "active").trim().toLowerCase();
}

function isAllowedPriceTier(value) {
    const tier = String(value || "").trim();
    return DISCOUNTS[tier] !== undefined;
}

function isMissingRelationError(error, relationName) {
    const message = String(error?.message || "").toLowerCase();
    if (!message) {
        return false;
    }
    return message.includes("relation") && message.includes(String(relationName || "").toLowerCase());
}

function mapSessionStatusToAccessError(status) {
    if (status === SESSION_STATUS.pending) {
        return "registration_pending";
    }
    if (status === SESSION_STATUS.blocked) {
        return "customer_blocked";
    }
    if (status === SESSION_STATUS.notRegistered) {
        return "registration_required";
    }
    return "registration_required";
}

function mapSessionStatusToOrderError(status) {
    if (status === SESSION_STATUS.blocked) {
        return "customer_blocked";
    }
    if (status === SESSION_STATUS.pending) {
        return "registration_pending";
    }
    return "customer_not_found";
}

async function resolveSessionStateByInitData(initData) {
    if (!verifyTelegramInitData(initData)) {
        return {
            ok: false,
            httpStatus: 401,
            error: "unauthorized",
            sessionStatus: "unauthorized"
        };
    }

    if (!supabase) {
        return {
            ok: false,
            httpStatus: 500,
            error: "supabase_not_configured",
            sessionStatus: SESSION_STATUS.notRegistered
        };
    }

    const tgUser = parseTelegramUser(initData);
    const telegramId = tgUser?.id ? Number(tgUser.id) : null;
    if (!telegramId) {
        return {
            ok: false,
            httpStatus: 400,
            error: "telegram_id_missing",
            sessionStatus: "unauthorized"
        };
    }

    const { data: customer, error: customerError } = await supabase
        .from("customers")
        .select("id, telegram_id, price_tier, access_status, moysklad_counterparty_id")
        .eq("telegram_id", telegramId)
        .maybeSingle();

    if (customerError) {
        throw customerError;
    }

    if (customer?.id) {
        const accessStatus = normalizeAccessStatus(customer.access_status);
        if (accessStatus === SESSION_STATUS.blocked) {
            return {
                ok: true,
                sessionStatus: SESSION_STATUS.blocked,
                telegramId,
                tgUser,
                customer
            };
        }

        if (isAllowedPriceTier(customer.price_tier)) {
            return {
                ok: true,
                sessionStatus: SESSION_STATUS.active,
                telegramId,
                tgUser,
                customer
            };
        }
    }

    let hasOpenRequest = false;
    try {
        const { data: requestRows, error: requestError } = await supabase
            .from("registration_requests")
            .select("id")
            .eq("telegram_id", telegramId)
            .in("status", OPEN_REGISTRATION_STATUSES)
            .limit(1);

        if (requestError) {
            throw requestError;
        }

        hasOpenRequest = Array.isArray(requestRows) && requestRows.length > 0;
    } catch (error) {
        if (!isMissingRelationError(error, "registration_requests")) {
            throw error;
        }
        hasOpenRequest = false;
    }

    return {
        ok: true,
        sessionStatus: hasOpenRequest ? SESSION_STATUS.pending : SESSION_STATUS.notRegistered,
        telegramId,
        tgUser,
        customer: null
    };
}

async function exportOrderToMoysklad({ supabase, order, customer }) {
    const token = getMoyskladToken();
    if (!token) {
        throw new Error("MOYSKLAD_TOKEN не задан");
    }

    const storeId = await getStoreId({ token, name: MOYSKLAD_STORE_NAME });
    const externalIds = (order?.items || [])
        .map((item) => (item?.productId ? String(item.productId) : ""))
        .filter(Boolean);
    const productMap = await fetchProductMoyskladMap(supabase, externalIds);

    const syncResult = await ensureMoyskladProductLinks({
        supabase,
        token,
        items: order?.items || [],
        productMap
    });

    if (syncResult.created.length || syncResult.linked.length) {
        const createdCount = syncResult.created.length;
        const linkedCount = syncResult.linked.length;
        console.log(
            `[MOYSKLAD] Связка товаров: найдено ${linkedCount}, создано ${createdCount}`
        );
    }

    const payload = buildCustomerOrderPayload({
        order,
        customer,
        organizationId: MOYSKLAD_ORGANIZATION_ID,
        storeId,
        productMap: syncResult.productMap
    });

    return createCustomerOrder({ token, payload });
}

function buildDuplicateOrderResponse(existingOrder, clientOrderId) {
    return {
        ok: true,
        duplicate: true,
        order: {
            id: existingOrder?.id || null,
            orderId: clientOrderId || null
        },
        notification: {
            sent: null
        },
        moysklad: {
            exported: existingOrder?.moysklad_exported ?? null,
            orderId: existingOrder?.moysklad_order_id || null,
            alertSent: null
        }
    };
}

app.post("/api/order", async (req, res) => {
    const initData = extractInitData(req);

    const order = req.body?.order;
    if (!order || typeof order !== "object") {
        return res.status(400).json({ ok: false, error: "order is required" });
    }

    if (order.type !== "order") {
        return res.status(400).json({ ok: false, error: "unsupported payload" });
    }

    const items = Array.isArray(order.items) ? order.items : [];
    if (!items.length) {
        return res.status(400).json({ ok: false, error: "order items required" });
    }

    try {
        const session = await resolveSessionStateByInitData(initData);
        if (!session.ok) {
            return res.status(session.httpStatus).json({ ok: false, error: session.error });
        }

        if (session.sessionStatus !== SESSION_STATUS.active) {
            return res.status(403).json({
                ok: false,
                error: mapSessionStatusToOrderError(session.sessionStatus)
            });
        }

        const customer = session.customer;
        const tgUser = session.tgUser || null;
        const trustedOrder = await buildTrustedOrderFromCart({
            supabase,
            rawOrder: order,
            customer,
            discounts: DISCOUNTS,
            pricingChunkSize: PRICING_CHUNK_SIZE
        });

        const existingOrder = await findOrderByClientOrderId(
            supabase,
            customer.id,
            trustedOrder.orderId
        );
        if (existingOrder?.id) {
            return res.json(buildDuplicateOrderResponse(existingOrder, trustedOrder.orderId));
        }

        let orderRecord;
        try {
            orderRecord = await insertOrderWithItems(
                supabase,
                trustedOrder,
                customer
            );
        } catch (error) {
            if (!isClientOrderIdConflictError(error)) {
                throw error;
            }

            const duplicateOrder = await findOrderByClientOrderId(
                supabase,
                customer.id,
                trustedOrder.orderId
            );
            if (duplicateOrder?.id) {
                return res.json(buildDuplicateOrderResponse(duplicateOrder, trustedOrder.orderId));
            }

            throw error;
        }

        let moyskladResult = null;
        let moyskladError = null;

        try {
            if (!customer.moysklad_counterparty_id) {
                throw new Error("У клиента не задан moysklad_counterparty_id");
            }

            moyskladResult = await withRetries(
                async (attempt) => {
                    if (attempt > 0) {
                        console.warn(
                            `[MOYSKLAD] Повтор выгрузки заказа ${trustedOrder.orderId || "unknown"} (попытка ${attempt + 1})`
                        );
                    }

                    return exportOrderToMoysklad({ supabase, order: trustedOrder, customer });
                },
                { retries: 3, delayMs: 5000 }
            );

            await updateOrderMoyskladStatus(supabase, orderRecord.id, {
                exported: true,
                msOrderId: moyskladResult?.id || null,
                errorMessage: null
            });
        } catch (error) {
            moyskladError = error;
            console.error("[MOYSKLAD] Ошибка выгрузки заказа:", error);
            try {
                await updateOrderMoyskladStatus(supabase, orderRecord.id, {
                    exported: false,
                    msOrderId: null,
                    errorMessage: String(error?.message || error)
                });
            } catch (updateError) {
                console.error("[MOYSKLAD] Не удалось обновить статус выгрузки:", updateError);
            }
        }

        let notifyError = null;
        const payload = {
            ...trustedOrder,
            user: tgUser
        };
        const message = formatOrderMessage(payload, { timeZone: ORDER_TIMEZONE });

        try {
            await sendTelegramMessage(TELEGRAM_ADMIN_ID, message);
            console.log(
                `✅ [SERVER] Order notified: ${payload.orderId || "unknown"} -> admin ${TELEGRAM_ADMIN_ID}`
            );
        } catch (error) {
            notifyError = error;
            console.error("❌ [SERVER] Ошибка уведомления Telegram:", error);
        }

        let moyskladAlertError = null;
        if (moyskladError) {
            const failureMessage = formatMoyskladExportFailureMessage(
                {
                    order: payload,
                    localOrderId: orderRecord.id,
                    customer,
                    user: payload.user,
                    error: moyskladError
                },
                { timeZone: ORDER_TIMEZONE }
            );

            try {
                await sendTelegramMessage(TELEGRAM_ADMIN_ID, failureMessage);
                console.warn(
                    `⚠️ [MOYSKLAD] Failure alert sent: ${payload.orderId || "unknown"} -> admin ${TELEGRAM_ADMIN_ID}`
                );
            } catch (error) {
                moyskladAlertError = error;
                console.error("❌ [MOYSKLAD] Ошибка отправки alert-уведомления:", error);
            }
        }

        return res.json({
            ok: true,
            order: {
                id: orderRecord.id,
                orderId: trustedOrder.orderId
            },
            notification: {
                sent: !notifyError
            },
            moysklad: {
                exported: !moyskladError,
                orderId: moyskladResult?.id || null,
                alertSent: moyskladError ? !moyskladAlertError : null
            }
        });
    } catch (error) {
        if (Number.isInteger(error?.httpStatus)) {
            return res.status(error.httpStatus).json({
                ok: false,
                error: error.code || "order_invalid",
                details: error.details || null
            });
        }
        console.error("❌ [SERVER] /api/order failed:", error);
        return res.status(500).json({ ok: false, error: "send_failed" });
    }
});

app.post("/api/moysklad/webhook/customerorder", async (req, res) => {
    if (!supabase) {
        return res.status(500).json({ ok: false, error: "supabase_not_configured" });
    }

    const rows = extractRows(req.body);
    if (!rows.length) {
        return res.status(400).json({ ok: false, error: "empty_webhook_payload" });
    }

    const token = getMoyskladToken();
    let processed = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;

    for (const row of rows) {
        processed += 1;
        try {
            const { orderId, rawStateName, mappedStatus } = await resolveEventStatus({ row, token });

            if (!orderId) {
                skipped += 1;
                console.warn(`[MOYSKLAD-WEBHOOK] Пропуск события #${processed}: не найден id заказа`);
                continue;
            }

            if (!mappedStatus) {
                skipped += 1;
                console.warn(
                    `[MOYSKLAD-WEBHOOK] Пропуск события #${processed}: нет статуса для заказа ${orderId}`
                );
                continue;
            }

            const result = await updateOrderStatusByMoyskladOrderId(supabase, orderId, mappedStatus);
            if (!result.updated) {
                skipped += 1;
                console.warn(
                    `[MOYSKLAD-WEBHOOK] Пропуск события #${processed}: заказ ${orderId} не найден в local orders`
                );
                continue;
            }

            updated += 1;
            console.log(
                `[MOYSKLAD-WEBHOOK] Заказ ${orderId} обновлен: "${rawStateName}" -> "${mappedStatus}"`
            );
        } catch (error) {
            errors += 1;
            console.error(`[MOYSKLAD-WEBHOOK] Ошибка события #${processed}:`, error);
        }
    }

    return res.json({
        ok: true,
        processed,
        updated,
        skipped,
        errors
    });
});

app.get("/api/orders", async (req, res) => {
    const initData = extractInitData(req);
    const rawLimit = Number.parseInt(String(req.query?.limit || ""), 10);
    const rawOffset = Number.parseInt(String(req.query?.offset || ""), 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(50, rawLimit)) : 5;
    const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;

    try {
        const session = await resolveSessionStateByInitData(initData);
        if (!session.ok) {
            return res.status(session.httpStatus).json({ ok: false, error: session.error });
        }

        if (session.sessionStatus !== SESSION_STATUS.active) {
            return res.status(403).json({
                ok: false,
                error: mapSessionStatusToAccessError(session.sessionStatus)
            });
        }

        const { orders, hasMore } = await fetchCustomerOrders(supabase, session.customer.id, {
            limit,
            offset
        });

        return res.json({
            ok: true,
            orders,
            pagination: {
                limit,
                offset,
                hasMore,
                nextOffset: offset + orders.length
            }
        });
    } catch (error) {
        console.error("❌ [SERVER] /api/orders failed:", error);
        return res.status(500).json({ ok: false, error: "orders_fetch_failed" });
    }
});

app.post("/api/pricing", async (req, res) => {
    const initData = extractInitData(req);
    const productIds = Array.from(
        new Set(
            (Array.isArray(req.body?.productIds) ? req.body.productIds : [])
                .map((value) => String(value || "").trim())
                .filter(Boolean)
        )
    ).slice(0, 5000);

    try {
        const session = await resolveSessionStateByInitData(initData);
        if (!session.ok) {
            let reason = "registration_required";
            if (session.error === "unauthorized") {
                reason = "unauthorized";
            } else if (session.error === "supabase_not_configured") {
                reason = "supabase_not_configured";
            }
            return res.json({
                authorized: false,
                prices: {},
                reason
            });
        }

        if (session.sessionStatus !== SESSION_STATUS.active) {
            return res.json({
                authorized: false,
                prices: {},
                reason: mapSessionStatusToAccessError(session.sessionStatus)
            });
        }

        const customer = session.customer;
        const tgUser = session.tgUser;
        const telegramId = session.telegramId;

        if (tgUser) {
            const { error: updateError } = await supabase
                .from("customers")
                .update({
                    username: tgUser.username || null,
                    first_name: tgUser.first_name || null,
                    last_name: tgUser.last_name || null
                })
                .eq("telegram_id", telegramId);

            if (updateError) {
                console.log("⚠️ [SERVER] Ошибка обновления клиента:", updateError);
            }
        }

        if (!productIds.length) {
            return res.json({ authorized: true, prices: {} });
        }

        const discount = DISCOUNTS[customer.price_tier];
        const prices = {};
        const chunks = chunkArray(productIds, PRICING_CHUNK_SIZE);

        for (const idsChunk of chunks) {
            const { data: products, error: productsError } = await supabase
                .from("products")
                .select("external_id, base_price")
                .in("external_id", idsChunk);

            if (productsError) {
                throw productsError;
            }

            (products || []).forEach((product) => {
                const base = Number.parseFloat(product.base_price);
                if (!Number.isFinite(base)) {
                    return;
                }
                const price = Math.round(base * (1 - discount));
                prices[product.external_id] = price;
            });
        }

        console.log("✅ [SERVER] Цены рассчитаны:", Object.keys(prices).length, "из", productIds.length);
        return res.json({ authorized: true, prices });
    } catch (error) {
        console.error("❌ [SERVER] Ошибка в /api/pricing:", error);
        return res.status(500).json({ authorized: false, prices: {}, reason: "internal_error" });
    }
});

app.use(express.static(staticRoot));

app.listen(PORT, () => {
    console.log(`DIXEL server running on http://localhost:${PORT}`);
    warmupCatalogCache();
});
