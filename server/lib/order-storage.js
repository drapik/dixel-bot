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

function isMissingClientOrderIdColumnError(error) {
    const code = String(error?.code || "").trim();
    if (code === "42703") {
        return true;
    }

    const message = String(error?.message || "").toLowerCase();
    return message.includes("client_order_id") && message.includes("column");
}

function buildOrderRow(order, customer) {
    const total = Number(order?.total);
    const clientOrderId = order?.orderId ? String(order.orderId).trim() : "";
    const row = {
        customer_id: customer?.id || null,
        status: "pending",
        price_tier: customer?.price_tier || "minus5",
        total_amount: Number.isFinite(total) ? total : 0
    };

    if (clientOrderId) {
        row.client_order_id = clientOrderId;
    }

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
    let { data: orderData, error: orderError } = await supabase
        .from("orders")
        .insert(orderRow)
        .select("id")
        .single();

    if (
        orderError
        && isMissingClientOrderIdColumnError(orderError)
        && Object.prototype.hasOwnProperty.call(orderRow, "client_order_id")
    ) {
        const fallbackOrderRow = { ...orderRow };
        delete fallbackOrderRow.client_order_id;
        ({ data: orderData, error: orderError } = await supabase
            .from("orders")
            .insert(fallbackOrderRow)
            .select("id")
            .single());
    }

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

async function findOrderByClientOrderId(supabase, customerId, clientOrderId) {
    const customer = customerId ? String(customerId).trim() : "";
    const orderId = clientOrderId ? String(clientOrderId).trim() : "";
    if (!customer || !orderId) {
        return null;
    }

    const { data, error } = await supabase
        .from("orders")
        .select("id, moysklad_exported, moysklad_order_id")
        .eq("customer_id", customer)
        .eq("client_order_id", orderId)
        .maybeSingle();

    if (error) {
        if (isMissingClientOrderIdColumnError(error)) {
            return null;
        }
        throw error;
    }

    return data || null;
}

function isClientOrderIdConflictError(error) {
    if (String(error?.code || "") !== "23505") {
        return false;
    }

    const message = String(error?.message || "").toLowerCase();
    return message.includes("orders_customer_client_order_id_unique");
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

async function updateOrderStatusByMoyskladOrderId(supabase, moyskladOrderId, status) {
    const orderId = moyskladOrderId ? String(moyskladOrderId).trim() : "";
    const nextStatus = status ? String(status).trim() : "";
    if (!orderId || !nextStatus) {
        return { updated: false };
    }

    const { data, error } = await supabase
        .from("orders")
        .update({ status: nextStatus })
        .eq("moysklad_order_id", orderId)
        .select("id");

    if (error) {
        throw error;
    }

    return {
        updated: Array.isArray(data) && data.length > 0
    };
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

function normalizeOrderItemRow(row) {
    const qty = Number(row?.qty);
    const price = Number(row?.unit_price);
    return {
        productId: row?.product_external_id ? String(row.product_external_id) : null,
        sku: row?.sku ? String(row.sku) : null,
        name: row?.name ? String(row.name) : null,
        qty: Number.isFinite(qty) ? qty : 0,
        price: Number.isFinite(price) ? price : 0
    };
}

function normalizeOrderRow(row) {
    const total = Number(row?.total_amount);
    const items = Array.isArray(row?.order_items)
        ? row.order_items.map(normalizeOrderItemRow)
        : [];

    return {
        id: row?.id ? String(row.id) : "",
        status: row?.status ? String(row.status) : "pending",
        total: Number.isFinite(total) ? total : 0,
        createdAt: row?.created_at || null,
        items
    };
}

async function fetchCustomerOrders(supabase, customerId, { limit = 5, offset = 0 } = {}) {
    if (!customerId) {
        return { orders: [], hasMore: false };
    }

    const pageSize = Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.floor(limit))) : 5;
    const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;

    const { data, error } = await supabase
        .from("orders")
        .select("id, status, total_amount, created_at, order_items(qty, unit_price, name, sku, product_external_id)")
        .eq("customer_id", customerId)
        .order("created_at", { ascending: false })
        .range(safeOffset, safeOffset + pageSize);

    if (error) {
        throw error;
    }

    const rows = Array.isArray(data) ? data : [];
    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;

    return {
        orders: pageRows.map(normalizeOrderRow),
        hasMore
    };
}

module.exports = {
    insertOrderWithItems,
    findOrderByClientOrderId,
    isClientOrderIdConflictError,
    updateOrderMoyskladStatus,
    updateOrderStatusByMoyskladOrderId,
    fetchProductMoyskladMap,
    fetchProductsByExternalIds,
    updateProductMoyskladId,
    fetchCustomerOrders
};
