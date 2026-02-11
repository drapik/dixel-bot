const {
    asArray,
    readText,
    dedupeByExternalId,
    normalizeLabel
} = require("./utils");

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

function extractPriceNodes(offer) {
    const fromPrices = offer?.prices?.price;
    if (fromPrices) {
        return asArray(fromPrices);
    }
    return asArray(offer?.price);
}

function parseOfferBasePrice(offer, config) {
    const priceNodes = extractPriceNodes(offer);
    if (!priceNodes.length) {
        return null;
    }

    const preferred = normalizeLabel(config.basePriceType);
    let chosen = null;

    if (preferred) {
        chosen = priceNodes.find((node) => normalizeLabel(node?.type) === preferred) || null;
    }
    if (!chosen) {
        chosen = priceNodes[0];
    }

    const priceText = readText(chosen);
    if (!priceText) {
        return null;
    }
    const value = Number.parseFloat(String(priceText).replace(",", "."));
    if (!Number.isFinite(value)) {
        return null;
    }

    const multiplied = value * (Number.isFinite(config.priceMultiplier) ? config.priceMultiplier : 1);
    // Держим 2 знака (numeric(12,2)), а округление до рублей делаем уже в API.
    return Math.round(multiplied * 100) / 100;
}

function parseOfferStock(offer, config) {
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
        const value = Number.parseFloat(String(instockRaw).replace(",", "."));
        if (Number.isFinite(value)) {
            total += value;
            parsed = true;
        }
    });

    const quantityNodes = asArray(offer?.quantity);
    if (quantityNodes.length) {
        const preferredStore = normalizeLabel(config.stockStore);
        let quantityTotal = 0;
        let quantityParsed = false;

        quantityNodes.forEach((node) => {
            const storeLabel = normalizeLabel(node?.store);
            if (preferredStore && storeLabel && storeLabel !== preferredStore) {
                return;
            }
            const value = Number.parseFloat(String(readText(node)).replace(",", "."));
            if (Number.isFinite(value)) {
                quantityTotal += value;
                quantityParsed = true;
            }
        });

        if (quantityParsed) {
            return Math.max(0, Math.round(quantityTotal));
        }
    }

    if (parsed) {
        return Math.max(0, Math.round(total));
    }

    const fallbackRaw = readText(
        offer?.stock ?? offer?.quantity ?? offer?.instock ?? offer?.count
    );
    const fallbackValue = Number.parseFloat(String(fallbackRaw).replace(",", "."));
    if (Number.isFinite(fallbackValue)) {
        return Math.max(0, Math.round(fallbackValue));
    }

    return 1;
}

function normalizeCatalogOffers(rawOffers, config) {
    return rawOffers
        .map((offer) => {
            const name = readText(offer?.name);
            if (!name) {
                return null;
            }

            const id = offer?.id ? String(offer.id) : name;
            const vendorCode = readText(offer?.vendorCode);
            const sku = vendorCode || String(id);
            const picture = readText(offer?.picture) || null;
            const categoryId = readText(offer?.categoryId) || null;

            const basePrice = parseOfferBasePrice(offer, config);
            const stock = parseOfferStock(offer, config);

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

function parseFullCatalog(data, config) {
    const shop = data?.yml_catalog?.shop;
    if (!shop) {
        throw new Error("Неверный формат full_catalog: отсутствует yml_catalog.shop");
    }

    const rawCategories = asArray(shop.categories?.category);
    const rawOffers = asArray(shop.offers?.offer);

    if (!rawOffers.length) {
        throw new Error("В full_catalog отсутствуют offers");
    }

    const categories = dedupeByExternalId(normalizeYmlCategories(rawCategories));
    const offers = dedupeByExternalId(normalizeCatalogOffers(rawOffers, config));

    return { categories, offers };
}

function parsePriceUpdates(data, config) {
    const root = data?.price_updates;
    if (!root) {
        throw new Error("Неверный формат price_update: отсутствует price_updates");
    }

    const rawOffers = asArray(root.offer);
    const updates = rawOffers
        .map((offer) => {
            const id = offer?.id ? String(offer.id) : "";
            if (!id) {
                return null;
            }
            const basePrice = parseOfferBasePrice(offer, config);
            if (basePrice === null) {
                return null;
            }
            return { external_id: id, base_price: basePrice };
        })
        .filter(Boolean);

    return { updates };
}

function parseStockUpdates(data, config) {
    const root = data?.stock_updates;
    if (!root) {
        throw new Error("Неверный формат stock_update: отсутствует stock_updates");
    }

    const rawOffers = asArray(root.offer);
    const updates = rawOffers
        .map((offer) => {
            const id = offer?.id ? String(offer.id) : "";
            if (!id) {
                return null;
            }
            const stock = parseOfferStock(offer, config);
            return { external_id: id, stock };
        })
        .filter(Boolean);

    return { updates };
}

module.exports = {
    parseFullCatalog,
    parsePriceUpdates,
    parseStockUpdates,
    parseOfferBasePrice,
    parseOfferStock,
    normalizeYmlCategories,
    normalizeCatalogOffers
};

