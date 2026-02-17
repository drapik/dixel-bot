const MAX_ORDER_ITEMS = 200;
const MAX_QTY_PER_ITEM = 1000;
const ORDER_ID_MAX_LENGTH = 64;

function createOrderValidationError(code, message, details) {
    const error = new Error(message);
    error.code = code;
    error.httpStatus = 400;
    if (details !== undefined) {
        error.details = details;
    }
    return error;
}

function chunkArray(items, chunkSize) {
    const chunks = [];
    for (let i = 0; i < items.length; i += chunkSize) {
        chunks.push(items.slice(i, i + chunkSize));
    }
    return chunks;
}

function normalizeOrderId(value) {
    const trimmed = String(value || "").trim();
    if (!trimmed) {
        return "";
    }
    return trimmed.slice(0, ORDER_ID_MAX_LENGTH);
}

function createOrderId() {
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
    const rnd = Math.floor(Math.random() * 90 + 10);
    return `DX-${stamp}-${rnd}`;
}

function normalizeCreatedAt(value) {
    const date = value ? new Date(value) : new Date();
    if (!Number.isFinite(date.getTime())) {
        return new Date().toISOString();
    }
    return date.toISOString();
}

function normalizeCartItems(rawItems) {
    const source = Array.isArray(rawItems) ? rawItems : [];
    if (!source.length) {
        throw createOrderValidationError("order_items_required", "В заказе нет позиций");
    }

    const aggregated = new Map();
    source.forEach((item, index) => {
        const productId = item?.productId ? String(item.productId).trim() : "";
        if (!productId) {
            throw createOrderValidationError(
                "order_item_invalid",
                "Некорректная позиция заказа",
                { index, reason: "product_id_missing" }
            );
        }

        const qty = Number(item?.qty);
        if (!Number.isInteger(qty) || qty <= 0 || qty > MAX_QTY_PER_ITEM) {
            throw createOrderValidationError(
                "order_item_invalid",
                "Некорректное количество в позиции заказа",
                { index, productId, reason: "qty_invalid" }
            );
        }

        const prevQty = aggregated.get(productId) || 0;
        const nextQty = prevQty + qty;
        if (nextQty > MAX_QTY_PER_ITEM) {
            throw createOrderValidationError(
                "order_item_invalid",
                "Слишком большое количество товара в заказе",
                { index, productId, reason: "qty_too_large" }
            );
        }
        aggregated.set(productId, nextQty);
    });

    if (aggregated.size > MAX_ORDER_ITEMS) {
        throw createOrderValidationError(
            "order_items_too_many",
            "Слишком много позиций в заказе"
        );
    }

    return Array.from(aggregated.entries()).map(([productId, qty]) => ({
        productId,
        qty
    }));
}

function resolveDiscount(customer, discounts) {
    const tier = customer?.price_tier ? String(customer.price_tier) : "";
    const value = Number(discounts?.[tier]);
    if (!Number.isFinite(value) || value < 0 || value > 0.99) {
        return 0;
    }
    return value;
}

async function fetchProductsForOrder(supabase, productIds, chunkSize) {
    const map = new Map();
    const chunks = chunkArray(productIds, chunkSize);

    for (const idsChunk of chunks) {
        const { data, error } = await supabase
            .from("products")
            .select("external_id, sku, name, base_price")
            .in("external_id", idsChunk);

        if (error) {
            throw error;
        }

        (data || []).forEach((row) => {
            if (row?.external_id) {
                map.set(String(row.external_id), row);
            }
        });
    }

    return map;
}

async function buildTrustedOrderFromCart({
    supabase,
    rawOrder,
    customer,
    discounts,
    pricingChunkSize
}) {
    const cartItems = normalizeCartItems(rawOrder?.items);
    const productIds = cartItems.map((item) => item.productId);
    const productsById = await fetchProductsForOrder(
        supabase,
        productIds,
        Number.isFinite(pricingChunkSize) && pricingChunkSize > 0 ? pricingChunkSize : 200
    );

    const missingProductIds = productIds.filter((productId) => !productsById.has(productId));
    if (missingProductIds.length) {
        throw createOrderValidationError(
            "order_items_not_found",
            "Часть товаров недоступна в каталоге",
            { productIds: missingProductIds }
        );
    }

    const discount = resolveDiscount(customer, discounts);
    const trustedItems = cartItems.map((item) => {
        const product = productsById.get(item.productId);
        const basePrice = Number.parseFloat(product?.base_price);
        if (!Number.isFinite(basePrice)) {
            throw createOrderValidationError(
                "order_price_not_found",
                "Цена товара недоступна",
                { productId: item.productId }
            );
        }

        return {
            productId: item.productId,
            sku: product?.sku ? String(product.sku) : null,
            name: product?.name ? String(product.name) : null,
            qty: item.qty,
            price: Math.round(basePrice * (1 - discount))
        };
    });

    const total = trustedItems.reduce((sum, item) => sum + item.price * item.qty, 0);
    const orderId = normalizeOrderId(rawOrder?.orderId) || createOrderId();

    return {
        type: "order",
        orderId,
        createdAt: normalizeCreatedAt(rawOrder?.createdAt),
        total,
        items: trustedItems
    };
}

module.exports = {
    buildTrustedOrderFromCart
};
