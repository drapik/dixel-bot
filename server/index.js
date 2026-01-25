const crypto = require("crypto");
const path = require("path");
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

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

        const { data: products, error: productsError } = await supabase
            .from("products")
            .select("external_id, category_external_id, sku, name, stock, picture_url");

        if (productsError) {
            throw productsError;
        }

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
        return false;
    }
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) {
        return false;
    }
    params.delete("hash");
    const entries = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b));
    const dataCheckString = entries.map(([key, value]) => `${key}=${value}`).join("\n");
    const secret = crypto.createHash("sha256").update(TELEGRAM_BOT_TOKEN).digest();
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
        return res.json({ authorized: false, prices: {} });
    }

    const tgUser = parseTelegramUser(initData);
    const telegramId = tgUser && tgUser.id ? tgUser.id : null;
    if (!telegramId) {
        return res.json({ authorized: false, prices: {} });
    }

    try {
        const { data: customer, error: customerError } = await supabase
            .from("customers")
            .select("id, price_tier")
            .eq("telegram_id", telegramId)
            .maybeSingle();

        if (customerError) {
            throw customerError;
        }

        if (!customer || !customer.price_tier || DISCOUNTS[customer.price_tier] === undefined) {
            return res.json({ authorized: false, prices: {} });
        }

        if (tgUser) {
            await supabase
                .from("customers")
                .update({
                    username: tgUser.username || null,
                    first_name: tgUser.first_name || null,
                    last_name: tgUser.last_name || null
                })
                .eq("telegram_id", telegramId);
        }

        const productIds = Array.isArray(req.body?.productIds)
            ? req.body.productIds.map((id) => String(id))
            : [];
        let query = supabase.from("products").select("external_id, base_price");
        if (productIds.length) {
            query = query.in("external_id", productIds);
        }

        const { data: products, error: productsError } = await query;
        if (productsError) {
            throw productsError;
        }

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

        return res.json({ authorized: true, prices });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ authorized: false, prices: {} });
    }
});

app.use(express.static(staticRoot));

app.listen(PORT, () => {
    console.log(`DIXEL server running on http://localhost:${PORT}`);
});
