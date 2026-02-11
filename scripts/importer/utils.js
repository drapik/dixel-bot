const TRUTHY = new Set(["1", "true", "yes", "y", "on"]);

const isTruthy = (value) => {
    if (value === undefined || value === null) {
        return false;
    }
    return TRUTHY.has(String(value).trim().toLowerCase());
};

const parsePositiveInt = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseNumber = (value, fallback) => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const asArray = (value) => {
    if (!value) {
        return [];
    }
    return Array.isArray(value) ? value : [value];
};

const firstValue = (value) => {
    if (Array.isArray(value)) {
        return value[0];
    }
    return value;
};

const readText = (value) => {
    const raw = firstValue(value);
    if (raw && typeof raw === "object") {
        return raw.text ? String(raw.text).trim() : "";
    }
    return raw ? String(raw).trim() : "";
};

const chunk = (list, size) => {
    const chunks = [];
    for (let i = 0; i < list.length; i += size) {
        chunks.push(list.slice(i, i + size));
    }
    return chunks;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const jitter = (maxMs) => (maxMs > 0 ? Math.floor(Math.random() * maxMs) : 0);

const dedupeByExternalId = (rows) => {
    const map = new Map();
    rows.forEach((row) => {
        if (row && row.external_id) {
            map.set(row.external_id, row);
        }
    });
    return Array.from(map.values());
};

const normalizeLabel = (value) => {
    return String(value || "")
        .replace(/_/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
};

module.exports = {
    isTruthy,
    parsePositiveInt,
    parseNumber,
    clamp,
    asArray,
    firstValue,
    readText,
    chunk,
    sleep,
    jitter,
    dedupeByExternalId,
    normalizeLabel
};

