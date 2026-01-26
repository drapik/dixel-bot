const crypto = require("crypto");
const path = require("path");
const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const nacl = require("tweetnacl");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

const DISCOUNTS = {
    base: 0,
    minus5: 0.05,
    minus8: 0.08,
    minus10: 0.1
};

const app = express();
app.use(express.json({ limit: "1mb" }));

const staticRoot = path.join(__dirname, "..");

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.warn("Supabase env is missing; pricing API will stay locked.");
}

if (!TELEGRAM_BOT_TOKEN) {
    console.warn("TELEGRAM_BOT_TOKEN is missing; pricing API will stay locked.");
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

app.get("/api/catalog", async (req, res) => {
    if (!supabase) {
        return res.status(500).json({ error: "Supabase not configured" });
    }

    try {
        const { data: categories, error: categoriesError } = await supabase
            .from("categories")
            .select("external_id, parent_external_id, name");

        if (categoriesError) {
            throw categoriesError;
        }

        const products = await fetchAllProducts(
            supabase,
            "external_id, category_external_id, sku, name, stock, picture_url",
            { minStock: 0 }
        );
        console.log(`📦 [SERVER] Загружено товаров: ${products.length}`);

        const payload = {
            categories: (categories || []).map((category) => ({
                id: category.external_id,
                parentId: category.parent_external_id,
                name: category.name
            })),
            products: (products || []).map((product) => ({
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
