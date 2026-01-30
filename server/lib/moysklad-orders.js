const API_ROOT = "https://api.moysklad.ru/api/remap/1.2";
const DEFAULT_STORE_NAME = "Основной склад";

let cachedStoreId = null;

function getMoyskladToken() {
    return String(process.env.MOYSKLAD_TOKEN || "").trim();
}

function buildHeaders(token) {
    return {
        Authorization: `Bearer ${token}`,
        "Accept-Encoding": "gzip",
        Accept: "application/json;charset=utf-8",
        "Content-Type": "application/json;charset=utf-8"
    };
}

async function requestJson(url, { token, method = "GET", body } = {}) {
    const options = {
        method,
        headers: buildHeaders(token)
    };

    if (body !== undefined) {
        options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
            `МойСклад API: ${method} ${url} -> ${response.status} ${text}`.slice(0, 500)
        );
    }

    return response.json();
}

function buildMeta(type, id) {
    if (!id) {
        throw new Error(`Не задан id для ${type}`);
    }

    return {
        meta: {
            href: `${API_ROOT}/entity/${type}/${id}`,
            type,
            mediaType: "application/json"
        }
    };
}

async function getStoreId({ token, name = DEFAULT_STORE_NAME } = {}) {
    const configuredId = String(process.env.MOYSKLAD_STORE_ID || "").trim();
    if (configuredId) {
        return configuredId;
    }

    if (cachedStoreId) {
        return cachedStoreId;
    }

    const params = new URLSearchParams();
    params.set("filter", `name=${name}`);
    const url = `${API_ROOT}/entity/store?${params.toString()}`;

    const data = await requestJson(url, { token });
    const rows = Array.isArray(data?.rows) ? data.rows : [];
    const exact = rows.find((row) => String(row?.name || "").trim() === name);
    const store = exact || rows[0];

    if (!store?.id) {
        throw new Error(`Склад "${name}" не найден в МойСклад`);
    }

    cachedStoreId = store.id;
    console.log(`[MOYSKLAD] Склад "${name}" найден: ${cachedStoreId}`);
    return cachedStoreId;
}

function normalizePriceToKopeks(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return null;
    }
    return Math.round(numeric * 100);
}

function buildCustomerOrderPayload({ order, customer, organizationId, storeId, productMap }) {
    if (!order || typeof order !== "object") {
        throw new Error("Некорректный заказ");
    }

    const agentId = customer?.moysklad_counterparty_id;
    if (!agentId) {
        throw new Error("У клиента не задан moysklad_counterparty_id");
    }

    const items = Array.isArray(order.items) ? order.items : [];
    if (!items.length) {
        throw new Error("В заказе нет позиций");
    }

    const missingProducts = [];
    const positions = items
        .map((item) => {
            const externalId = item?.productId ? String(item.productId) : "";
            const msProductId = productMap.get(externalId);
            if (!msProductId) {
                missingProducts.push(externalId || "?");
                return null;
            }

            const quantity = Number(item?.qty);
            if (!Number.isFinite(quantity) || quantity <= 0) {
                throw new Error(`Некорректное количество для товара ${externalId}`);
            }

            const price = normalizePriceToKopeks(item?.price);
            if (price === null) {
                throw new Error(`Некорректная цена для товара ${externalId}`);
            }

            return {
                quantity,
                price,
                assortment: buildMeta("product", msProductId)
            };
        })
        .filter(Boolean);

    if (missingProducts.length) {
        throw new Error(`Товары не привязаны к МойСклад: ${missingProducts.join(", ")}`);
    }

    const orderCode = order?.orderId ? String(order.orderId) : null;

    const payload = {
        organization: buildMeta("organization", organizationId),
        agent: buildMeta("counterparty", agentId),
        store: buildMeta("store", storeId),
        positions
    };

    if (orderCode) {
        payload.name = orderCode;
        payload.code = orderCode;
    }

    return payload;
}

async function createCustomerOrder({ token, payload }) {
    if (!token) {
        throw new Error("MOYSKLAD_TOKEN не задан");
    }

    return requestJson(`${API_ROOT}/entity/customerorder`, {
        token,
        method: "POST",
        body: payload
    });
}

function normalizeCode(value) {
    if (value === null || value === undefined) {
        return "";
    }
    return String(value).trim();
}

async function findProductByCode({ token, code }) {
    if (!token) {
        throw new Error("MOYSKLAD_TOKEN не задан");
    }

    const normalized = normalizeCode(code);
    if (!normalized) {
        return null;
    }

    const params = new URLSearchParams();
    params.set("filter", `code=${normalized}`);
    params.set("limit", "1");
    const url = `${API_ROOT}/entity/product?${params.toString()}`;

    const data = await requestJson(url, { token });
    const rows = Array.isArray(data?.rows) ? data.rows : [];
    return rows[0] || null;
}

async function createProduct({ token, code, name }) {
    if (!token) {
        throw new Error("MOYSKLAD_TOKEN не задан");
    }

    const normalized = normalizeCode(code);
    if (!normalized) {
        throw new Error("Не задан код товара для создания в МойСклад");
    }

    const title = String(name || normalized).trim() || normalized;

    return requestJson(`${API_ROOT}/entity/product`, {
        token,
        method: "POST",
        body: {
            name: title,
            code: normalized
        }
    });
}

module.exports = {
    getMoyskladToken,
    getStoreId,
    buildCustomerOrderPayload,
    createCustomerOrder,
    findProductByCode,
    createProduct
};
