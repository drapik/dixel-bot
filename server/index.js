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

const { formatOrderMessage } = require("./bot/lib/formatters");
const {
    insertOrderWithItems,
    updateOrderMoyskladStatus,
    updateOrderStatusByMoyskladOrderId,
    fetchProductMoyskladMap,
    fetchCustomerOrders
} = require("./lib/order-storage");
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

const DISCOUNTS = {
    base: 0,
    minus5: 0.05,
    minus8: 0.08,
    minus10: 0.1
};

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

async function fetchAllProducts(
    supabase,
    fields = "external_id, category_external_id, sku, name, stock, picture_url",
    options = {}
) {
    const PAGE_SIZE = 1000;
    let allProducts = [];
    let from = 0;
    const minStock = options.minStock;
    const hasMinStock = Number.isFinite(minStock);

    while (true) {
        let query = supabase
            .from("products")
            .select(fields)
            .range(from, from + PAGE_SIZE - 1);

        if (hasMinStock) {
            query = query.gt("stock", minStock);
        }

        const { data, error } = await query;

        if (error) {
            throw error;
        }

        if (!data || data.length === 0) {
            break;
        }

        allProducts = allProducts.concat(data);

        if (data.length < PAGE_SIZE) {
            break;
        }

        from += PAGE_SIZE;
    }

    return allProducts;
}

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

app.get("/api/catalog", async (req, res) => {
    if (!supabase) {
        return res.status(500).json({ error: "Supabase not configured" });
    }

    try {
        const categories = await fetchAllCategories(
            supabase,
            "external_id, parent_external_id, name, hidden"
        );

        const hiddenCategoryIds = buildHiddenCategorySet(categories);
        const visibleCategories = (categories || []).filter(
            (category) => !hiddenCategoryIds.has(category.external_id)
        );

        const products = await fetchAllProducts(
            supabase,
            "external_id, category_external_id, sku, name, stock, picture_url",
            { minStock: 0 }
        );
        console.log(`📦 [SERVER] Загружено товаров: ${products.length}`);

        const visibleProducts = (products || []).filter((product) => {
            const categoryId = product.category_external_id;
            if (!categoryId) {
                return true;
            }
            return !hiddenCategoryIds.has(categoryId);
        });

        const payload = {
            categories: visibleCategories.map((category) => ({
                id: category.external_id,
                parentId: category.parent_external_id,
                name: category.name
            })),
            products: visibleProducts.map((product) => ({
                id: product.external_id,
                categoryId: product.category_external_id,
                sku: product.sku,
                name: product.name,
                stock: product.stock,
                picture: product.picture_url,
                available: product.stock > 0
            }))
        };

        return res.json(payload);
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: "Catalog fetch failed" });
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

app.post("/api/order", async (req, res) => {
    const initData = req.body?.initData || req.headers["x-telegram-init-data"] || "";

    if (!verifyTelegramInitData(initData)) {
        return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const order = req.body?.order;
    if (!order || typeof order !== "object") {
        return res.status(400).json({ ok: false, error: "order is required" });
    }

    if (order.type !== "order") {
        return res.status(400).json({ ok: false, error: "unsupported payload" });
    }

    if (!supabase) {
        console.warn("⚠️ [SERVER] Supabase НЕ настроен!");
        return res.status(500).json({ ok: false, error: "supabase_not_configured" });
    }

    const items = Array.isArray(order.items) ? order.items : [];
    if (!items.length) {
        return res.status(400).json({ ok: false, error: "order items required" });
    }

    const total = Number(order.total);
    if (!Number.isFinite(total)) {
        return res.status(400).json({ ok: false, error: "order total invalid" });
    }

    try {
        const tgUser = parseTelegramUser(initData);
        const telegramId = tgUser?.id ? Number(tgUser.id) : null;
        if (!telegramId) {
            return res.status(400).json({ ok: false, error: "telegram_id_missing" });
        }

        const { data: customer, error: customerError } = await supabase
            .from("customers")
            .select("id, price_tier, moysklad_counterparty_id")
            .eq("telegram_id", telegramId)
            .maybeSingle();

        if (customerError) {
            throw customerError;
        }

        if (!customer?.id) {
            return res.status(403).json({ ok: false, error: "customer_not_found" });
        }

        const orderRecord = await insertOrderWithItems(
            supabase,
            { ...order, total, items },
            customer
        );

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
                            `[MOYSKLAD] Повтор выгрузки заказа ${order.orderId || "unknown"} (попытка ${attempt + 1})`
                        );
                    }

                    return exportOrderToMoysklad({ supabase, order, customer });
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
            ...order,
            user: order.user || tgUser || null
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

        return res.json({
            ok: true,
            order: {
                id: orderRecord.id
            },
            notification: {
                sent: !notifyError
            },
            moysklad: {
                exported: !moyskladError,
                orderId: moyskladResult?.id || null
            }
        });
    } catch (error) {
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
    const initDataHeader = req.headers["x-telegram-init-data"];
    const initData = typeof initDataHeader === "string" ? initDataHeader : "";
    const rawLimit = Number.parseInt(String(req.query?.limit || ""), 10);
    const rawOffset = Number.parseInt(String(req.query?.offset || ""), 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(50, rawLimit)) : 5;
    const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;

    if (!verifyTelegramInitData(initData)) {
        return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    if (!supabase) {
        return res.status(500).json({ ok: false, error: "supabase_not_configured" });
    }

    try {
        const tgUser = parseTelegramUser(initData);
        const telegramId = tgUser?.id ? Number(tgUser.id) : null;
        if (!telegramId) {
            return res.status(400).json({ ok: false, error: "telegram_id_missing" });
        }

        const { data: customer, error: customerError } = await supabase
            .from("customers")
            .select("id")
            .eq("telegram_id", telegramId)
            .maybeSingle();

        if (customerError) {
            throw customerError;
        }

        if (!customer?.id) {
            return res.json({
                ok: true,
                orders: [],
                pagination: {
                    limit,
                    offset,
                    hasMore: false,
                    nextOffset: offset
                }
            });
        }

        const { orders, hasMore } = await fetchCustomerOrders(supabase, customer.id, {
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
    const initData = req.body?.initData || req.headers["x-telegram-init-data"] || "";

    if (!verifyTelegramInitData(initData)) {
        return res.json({ authorized: false, prices: {} });
    }

    if (!supabase) {
        console.warn("⚠️ [SERVER] Supabase НЕ настроен!");
        return res.json({ authorized: false, prices: {} });
    }

    const tgUser = parseTelegramUser(initData);
    const telegramId = tgUser && tgUser.id ? tgUser.id : null;
    console.log("🔍 [SERVER] Telegram ID из initData:", telegramId);

    if (!telegramId) {
        console.warn("⚠️ [SERVER] Не удалось извлечь telegram_id!");
        return res.json({ authorized: false, prices: {} });
    }

    try {
        console.log("🔍 [SERVER] Поиск клиента в БД с telegram_id:", telegramId);
        const { data: customer, error: customerError } = await supabase
            .from("customers")
            .select("id, price_tier")
            .eq("telegram_id", telegramId)
            .maybeSingle();

        if (customerError) {
            console.error("❌ [SERVER] Ошибка БД:", customerError);
            throw customerError;
        }

        console.log("🔍 [SERVER] Найден клиент:", customer);

        if (!customer || !customer.price_tier || DISCOUNTS[customer.price_tier] === undefined) {
            console.warn("⚠️ [SERVER] Клиент НЕ найден или некорректный price_tier!");
            console.warn("⚠️ [SERVER] customer:", customer);
            return res.json({ authorized: false, prices: {} });
        }

        console.log("✅ [SERVER] Клиент найден, price_tier:", customer.price_tier);

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

        // Получаем ВСЕ продукты с пагинацией
        const products = await fetchAllProducts(supabase, "external_id, base_price");
        console.log("🔍 [SERVER] Загружено продуктов для цен:", products.length);

        const discount = DISCOUNTS[customer.price_tier];
        const prices = {};
        (products || []).forEach((product) => {
            const base = Number.parseFloat(product.base_price);
            if (!Number.isFinite(base)) {
                return;
            }
            const price = Math.round(base * (1 - discount));
            prices[product.external_id] = price;
        });

        console.log("✅ [SERVER] Цены рассчитаны:", Object.keys(prices).length);
        return res.json({ authorized: true, prices });
    } catch (error) {
        console.error("❌ [SERVER] Ошибка в /api/pricing:", error);
        return res.status(500).json({ authorized: false, prices: {} });
    }
});

app.use(express.static(staticRoot));

app.listen(PORT, () => {
    console.log(`DIXEL server running on http://localhost:${PORT}`);
});
