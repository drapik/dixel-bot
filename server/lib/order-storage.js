function parseCreatedAt(value) {
    if (!value) {
        return null;
    }
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
        return null;
    }
    return date.toISOString();
}

function buildOrderRow(order, customer) {
    const total = Number(order?.total);
    const row = {
        customer_id: customer?.id || null,
        status: "pending",
        price_tier: customer?.price_tier || "minus5",
        total_amount: Number.isFinite(total) ? total : 0
    };

    const createdAt = parseCreatedAt(order?.createdAt);
    if (createdAt) {
        row.created_at = createdAt;
    }

    return row;
}

function normalizeOrderItems(orderItems) {
    const items = Array.isArray(orderItems) ? orderItems : [];
    return items.map((item) => {
        const qty = Number(item?.qty);
        const price = Number(item?.price);
        return {
            product_external_id: item?.productId ? String(item.productId) : null,
            sku: item?.sku ? String(item.sku) : null,
            name: item?.name ? String(item.name) : null,
            qty: Number.isFinite(qty) ? qty : 1,
            unit_price: Number.isFinite(price) ? price : 0
        };
    });
}

async function insertOrderWithItems(supabase, order, customer) {
    const orderRow = buildOrderRow(order, customer);
    const { data: orderData, error: orderError } = await supabase
        .from("orders")
        .insert(orderRow)
        .select("id")
        .single();

    if (orderError) {
        throw orderError;
    }

    const items = normalizeOrderItems(order?.items);
    if (!items.length) {
        throw new Error("Заказ без позиций");
    }

    const rows = items.map((item) => ({
        ...item,
        order_id: orderData.id
    }));

    const { error: itemsError } = await supabase
        .from("order_items")
        .insert(rows);

    if (itemsError) {
        throw itemsError;
    }

    return orderData;
}

async function updateOrderMoyskladStatus(supabase, orderId, { exported, msOrderId, errorMessage }) {
    const payload = {
        moysklad_exported: Boolean(exported),
        moysklad_export_error: errorMessage || null
    };

    if (msOrderId !== undefined) {
        payload.moysklad_order_id = msOrderId;
    }

    const { error } = await supabase
        .from("orders")
        .update(payload)
        .eq("id", orderId);

    if (error) {
        throw error;
    }
}

async function fetchProductMoyskladMap(supabase, externalIds) {
    const uniqueIds = Array.from(new Set((externalIds || [])
        .map((id) => (id ? String(id) : ""))
        .filter(Boolean)));

    if (!uniqueIds.length) {
        return new Map();
    }

    const { data, error } = await supabase
        .from("products")
        .select("external_id, moysklad_product_id")
        .in("external_id", uniqueIds);

    if (error) {
        throw error;
    }

    const map = new Map();
    (data || []).forEach((row) => {
        if (row?.external_id) {
            map.set(String(row.external_id), row?.moysklad_product_id || null);
        }
    });

    return map;
}

async function fetchProductsByExternalIds(supabase, externalIds) {
    const uniqueIds = Array.from(new Set((externalIds || [])
        .map((id) => (id ? String(id) : ""))
        .filter(Boolean)));

    if (!uniqueIds.length) {
        return new Map();
    }

    const { data, error } = await supabase
        .from("products")
        .select("external_id, sku, name")
        .in("external_id", uniqueIds);

    if (error) {
        throw error;
    }

    const map = new Map();
    (data || []).forEach((row) => {
        if (row?.external_id) {
            map.set(String(row.external_id), row);
        }
    });

    return map;
}

async function updateProductMoyskladId(supabase, externalId, moyskladProductId) {
    if (!externalId || !moyskladProductId) {
        return;
    }

    const { error } = await supabase
        .from("products")
        .update({ moysklad_product_id: moyskladProductId })
        .eq("external_id", String(externalId))
        .is("moysklad_product_id", null);

    if (error) {
        throw error;
    }
}

module.exports = {
    insertOrderWithItems,
    updateOrderMoyskladStatus,
    fetchProductMoyskladMap,
    fetchProductsByExternalIds,
    updateProductMoyskladId
};
