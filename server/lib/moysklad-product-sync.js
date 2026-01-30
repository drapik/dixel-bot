const { findProductByCode, createProduct } = require("./moysklad-orders");
const { fetchProductsByExternalIds, updateProductMoyskladId } = require("./order-storage");

function normalizeCode(value) {
    if (value === null || value === undefined) {
        return "";
    }
    return String(value).trim();
}

function buildMissingItems(items, productMap) {
    const missing = new Map();

    (Array.isArray(items) ? items : []).forEach((item) => {
        const externalId = item?.productId ? String(item.productId) : "";
        if (!externalId) {
            return;
        }
        const msId = productMap.get(externalId);
        if (msId) {
            return;
        }
        if (!missing.has(externalId)) {
            missing.set(externalId, {
                externalId,
                sku: item?.sku ? String(item.sku) : "",
                name: item?.name ? String(item.name) : ""
            });
        }
    });

    return Array.from(missing.values());
}

function resolveItemDetails(item, dbRow) {
    const sku = normalizeCode(item?.sku) || normalizeCode(dbRow?.sku);
    const name = normalizeCode(item?.name) || normalizeCode(dbRow?.name);
    return { sku, name };
}

async function ensureMoyskladProductLinks({ supabase, token, items, productMap }) {
    const missingItems = buildMissingItems(items, productMap);
    if (!missingItems.length) {
        return { productMap, linked: [], created: [] };
    }

    const externalIds = missingItems.map((item) => item.externalId);
    const dbProducts = await fetchProductsByExternalIds(supabase, externalIds);

    const linked = [];
    const created = [];

    for (const item of missingItems) {
        const dbRow = dbProducts.get(item.externalId);
        const { sku, name } = resolveItemDetails(item, dbRow);
        const code = sku;

        if (!code) {
            throw new Error(`Не найден код товара для позиции ${item.externalId}`);
        }

        let msProduct = await findProductByCode({ token, code });

        if (!msProduct) {
            msProduct = await createProduct({ token, code, name: name || code });
            created.push({ externalId: item.externalId, code, msId: msProduct?.id || null });
        } else {
            linked.push({ externalId: item.externalId, code, msId: msProduct?.id || null });
        }

        const msProductId = msProduct?.id;
        if (!msProductId) {
            throw new Error(`Не удалось получить id товара МойСклад для кода ${code}`);
        }

        await updateProductMoyskladId(supabase, item.externalId, msProductId);
        productMap.set(item.externalId, msProductId);
    }

    return { productMap, linked, created };
}

module.exports = {
    ensureMoyskladProductLinks
};
