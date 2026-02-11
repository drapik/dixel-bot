const API_ROOT = "https://api.moysklad.ru/api/remap/1.2";

function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeRowArray(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((item) => isObject(item));
}

function extractRows(payload) {
    if (Array.isArray(payload)) {
        return normalizeRowArray(payload);
    }

    if (!isObject(payload)) {
        return [];
    }

    const rows = normalizeRowArray(payload.rows);
    if (rows.length) {
        return rows;
    }

    const events = normalizeRowArray(payload.events);
    if (events.length) {
        return events;
    }

    return [payload];
}

function cleanText(value) {
    if (value === null || value === undefined) {
        return "";
    }
    return String(value).trim().replace(/\s+/g, " ");
}

function normalizeStateName(value) {
    return cleanText(value).toLowerCase();
}

function extractIdFromHref(href) {
    const value = cleanText(href);
    if (!value) {
        return null;
    }

    const customerOrderMatch = value.match(/\/entity\/customerorder\/([^/?#]+)/i);
    if (customerOrderMatch?.[1]) {
        return customerOrderMatch[1];
    }

    const genericMatch = value.match(/\/([^/?#]+)(?:[?#].*)?$/);
    if (!genericMatch?.[1]) {
        return null;
    }

    return genericMatch[1];
}

function getValueByPath(row, path) {
    return path.reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), row);
}

function firstTextValue(row, paths) {
    for (const path of paths) {
        const value = getValueByPath(row, path);
        const text = cleanText(value);
        if (text) {
            return text;
        }
    }
    return null;
}

function extractMoyskladOrderId(row) {
    if (!isObject(row)) {
        return null;
    }

    const directId = firstTextValue(row, [
        ["id"],
        ["entity", "id"],
        ["object", "id"],
        ["customerorder", "id"]
    ]);
    if (directId) {
        return directId;
    }

    const hrefId = firstTextValue(row, [
        ["meta", "href"],
        ["entity", "meta", "href"],
        ["object", "meta", "href"],
        ["customerorder", "meta", "href"]
    ]);

    if (!hrefId) {
        return null;
    }

    return extractIdFromHref(hrefId);
}

function extractStateName(row) {
    if (!isObject(row)) {
        return null;
    }

    return firstTextValue(row, [
        ["state", "name"],
        ["entity", "state", "name"],
        ["object", "state", "name"],
        ["customerorder", "state", "name"]
    ]);
}

const STATUS_MAP = {
    "новый": "Новый",
    "в сборке": "В работе",
    "в сборку доукомплектовать": "В работе",
    "собран на пвз": "Собран на ПВЗ",
    "отгружен": "Отгружен"
};

function mapToProfileStatus(stateName) {
    const normalized = normalizeStateName(stateName);
    if (!normalized) {
        return null;
    }

    return STATUS_MAP[normalized] || cleanText(stateName);
}

function buildHeaders(token) {
    return {
        Authorization: `Bearer ${token}`,
        "Accept-Encoding": "gzip",
        Accept: "application/json;charset=utf-8"
    };
}

async function requestJson(url, { token } = {}) {
    const response = await fetch(url, {
        method: "GET",
        headers: buildHeaders(token)
    });

    if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
            `МойСклад API: GET ${url} -> ${response.status} ${text}`.slice(0, 500)
        );
    }

    return response.json();
}

async function fetchCustomerOrderStateName({ token, orderId }) {
    const normalizedOrderId = cleanText(orderId);
    if (!normalizedOrderId) {
        return null;
    }
    if (!token) {
        throw new Error("MOYSKLAD_TOKEN не задан");
    }

    const order = await requestJson(
        `${API_ROOT}/entity/customerorder/${normalizedOrderId}?expand=state`,
        { token }
    );

    const expandedStateName = cleanText(order?.state?.name);
    if (expandedStateName) {
        return expandedStateName;
    }

    const stateHref = cleanText(order?.state?.meta?.href);
    if (!stateHref) {
        return null;
    }

    try {
        const state = await requestJson(stateHref, { token });
        const fallbackStateName = cleanText(state?.name);
        return fallbackStateName || null;
    } catch (error) {
        return null;
    }
}

async function resolveEventStatus({ row, token }) {
    const orderId = extractMoyskladOrderId(row);
    if (!orderId) {
        return {
            orderId: null,
            rawStateName: null,
            mappedStatus: null
        };
    }

    let rawStateName = extractStateName(row);
    if (!rawStateName && token) {
        rawStateName = await fetchCustomerOrderStateName({ token, orderId });
    }

    if (!rawStateName) {
        return {
            orderId,
            rawStateName: null,
            mappedStatus: null
        };
    }

    return {
        orderId,
        rawStateName,
        mappedStatus: mapToProfileStatus(rawStateName)
    };
}

module.exports = {
    extractRows,
    extractMoyskladOrderId,
    extractStateName,
    normalizeStateName,
    mapToProfileStatus,
    fetchCustomerOrderStateName,
    resolveEventStatus
};
