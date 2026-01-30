const API_ROOT = "https://api.moysklad.ru/api/remap/1.2";

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

async function requestJson(url, { token, method = "GET" } = {}) {
    const response = await fetch(url, {
        method,
        headers: buildHeaders(token)
    });

    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
            `МойСклад API: ${method} ${url} -> ${response.status} ${body}`.slice(0, 500)
        );
    }

    return response.json();
}

function normalizeCode(value) {
    if (value === undefined || value === null) {
        return "";
    }
    return String(value).trim();
}

async function fetchAllCounterparties({ token, limit = 1000 } = {}) {
    if (!token) {
        throw new Error("MOYSKLAD_TOKEN не задан");
    }

    const all = [];
    let offset = 0;

    while (true) {
        const params = new URLSearchParams();
        params.set("limit", String(limit));
        params.set("offset", String(offset));
        params.set("expand", "contactpersons");
        const url = `${API_ROOT}/entity/counterparty?${params.toString()}`;

        const page = await requestJson(url, { token });
        const rows = Array.isArray(page?.rows) ? page.rows : [];
        all.push(...rows);

        const total = Number.parseInt(page?.meta?.size, 10);
        if (Number.isFinite(total) && all.length >= total) {
            break;
        }

        if (!rows.length || rows.length < limit) {
            break;
        }

        offset += rows.length;
    }

    return all;
}

async function fetchAllProducts({ token, limit = 1000 } = {}) {
    if (!token) {
        throw new Error("MOYSKLAD_TOKEN не задан");
    }

    const all = [];
    let offset = 0;

    while (true) {
        const params = new URLSearchParams();
        params.set("limit", String(limit));
        params.set("offset", String(offset));
        const url = `${API_ROOT}/entity/product?${params.toString()}`;

        const page = await requestJson(url, { token });
        const rows = Array.isArray(page?.rows) ? page.rows : [];
        all.push(...rows);

        const total = Number.parseInt(page?.meta?.size, 10);
        if (Number.isFinite(total) && all.length >= total) {
            break;
        }

        if (!rows.length || rows.length < limit) {
            break;
        }

        offset += rows.length;
    }

    return all;
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

module.exports = {
    fetchAllCounterparties,
    fetchAllProducts,
    getMoyskladToken,
    findProductByCode
};
