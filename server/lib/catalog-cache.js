"use strict";

function normalizeCategoryIds(value) {
    return (Array.isArray(value) ? value : [])
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .sort();
}

function buildCatalogCacheKey({
    limit,
    offset,
    searchQuery,
    requestedCategoryIds,
    withCategories
}) {
    const normalizedSearch = String(searchQuery || "").trim().toLowerCase();
    const normalizedCategoryIds = normalizeCategoryIds(requestedCategoryIds);

    return JSON.stringify({
        limit: Number(limit) || 0,
        offset: Number(offset) || 0,
        q: normalizedSearch,
        categoryIds: normalizedCategoryIds,
        withCategories: Boolean(withCategories)
    });
}

function createCatalogCache({
    ttlMs = 30000,
    maxEntries = 300
} = {}) {
    const cache = new Map();

    function cleanup(now = Date.now()) {
        for (const [key, entry] of cache.entries()) {
            if (entry.expiresAt <= now) {
                cache.delete(key);
            }
        }
        while (cache.size > maxEntries) {
            const oldestKey = cache.keys().next().value;
            if (!oldestKey) {
                break;
            }
            cache.delete(oldestKey);
        }
    }

    function get(key) {
        const entry = cache.get(key);
        if (!entry) {
            return null;
        }

        if (entry.expiresAt <= Date.now()) {
            cache.delete(key);
            return null;
        }

        return entry.value;
    }

    function set(key, value) {
        cleanup();
        cache.set(key, {
            value,
            expiresAt: Date.now() + Math.max(1, Number(ttlMs) || 1)
        });
    }

    function clear() {
        cache.clear();
    }

    function getStats() {
        cleanup();
        return { size: cache.size };
    }

    return {
        get,
        set,
        clear,
        getStats
    };
}

module.exports = {
    buildCatalogCacheKey,
    createCatalogCache
};
