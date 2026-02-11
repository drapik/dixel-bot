function formatMoneyRub(value) {
    if (!Number.isFinite(value)) {
        return "—";
    }

    const rounded = Math.round(value);
    const formatted = new Intl.NumberFormat("ru-RU").format(rounded);
    return `${formatted} ₽`;
}

function formatOrderDate(isoString, timeZone) {
    if (!isoString) {
        return "—";
    }

    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) {
        return String(isoString);
    }

    const options = {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
    };

    try {
        return new Intl.DateTimeFormat("ru-RU", { ...options, timeZone }).format(date);
    } catch (error) {
        return new Intl.DateTimeFormat("ru-RU", options).format(date);
    }
}

function formatUser(user) {
    if (!user || typeof user !== "object") {
        return "—";
    }

    const parts = [];
    const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
    if (name) {
        parts.push(name);
    }

    if (user.username) {
        parts.push(`@${user.username}`);
    }

    if (user.id) {
        parts.push(`id ${user.id}`);
    }

    return parts.length ? parts.join(" · ") : "—";
}

function formatOrderItem(item, index) {
    if (!item || typeof item !== "object") {
        return `${index + 1}) —`;
    }

    const qty = Number.isFinite(item.qty) ? item.qty : null;
    const sku = item.sku ? `[${item.sku}] ` : "";
    const name = item.name || item.productId || "—";
    const price = Number.isFinite(item.price) ? item.price : null;

    if (price === null || qty === null) {
        return `${index + 1}) ${sku}${name}${qty !== null ? ` × ${qty}` : ""}`;
    }

    const lineTotal = price * qty;
    return `${index + 1}) ${sku}${name} — ${formatMoneyRub(price)} × ${qty} = ${formatMoneyRub(lineTotal)}`;
}

function formatOrderMessage(payload, { timeZone } = {}) {
    const lines = ["🧾 Новый заказ"];

    if (payload.orderId) {
        lines.push(`ID: ${payload.orderId}`);
    }

    lines.push(`Дата: ${formatOrderDate(payload.createdAt, timeZone)}`);

    if (payload.user) {
        lines.push(`Клиент: ${formatUser(payload.user)}`);
    }

    if (payload.total !== undefined) {
        lines.push(`Сумма: ${formatMoneyRub(payload.total)}`);
    }

    const items = Array.isArray(payload.items) ? payload.items : [];
    if (items.length) {
        const MAX_ITEMS = 25;
        lines.push("");
        lines.push(`Позиции (${items.length}):`);
        items.slice(0, MAX_ITEMS).forEach((item, index) => {
            lines.push(formatOrderItem(item, index));
        });
        if (items.length > MAX_ITEMS) {
            lines.push(`… и еще ${items.length - MAX_ITEMS}`);
        }
    }

    return lines.join("\n");
}

function normalizeErrorText(error) {
    if (!error) {
        return "—";
    }

    const raw = error instanceof Error
        ? (error.message || String(error))
        : String(error);

    const normalized = raw.trim().replace(/\s+/g, " ");
    if (!normalized) {
        return "—";
    }

    const MAX_LENGTH = 280;
    if (normalized.length <= MAX_LENGTH) {
        return normalized;
    }

    return `${normalized.slice(0, MAX_LENGTH - 1)}…`;
}

function formatMoyskladExportFailureMessage(
    { order, localOrderId, customer, user, error } = {},
    { timeZone } = {}
) {
    const payload = order && typeof order === "object" ? order : {};
    const lines = ["⚠️ Ошибка выгрузки заказа в МойСклад"];

    if (payload.orderId) {
        lines.push(`ID заказа: ${payload.orderId}`);
    }

    if (localOrderId) {
        lines.push(`Локальный ID: ${localOrderId}`);
    }

    lines.push(`Дата: ${formatOrderDate(payload.createdAt, timeZone)}`);

    if (user) {
        lines.push(`Клиент: ${formatUser(user)}`);
    }

    if (customer?.id) {
        lines.push(`Customer ID: ${customer.id}`);
    }

    if (payload.total !== undefined) {
        lines.push(`Сумма: ${formatMoneyRub(Number(payload.total))}`);
    }

    const items = Array.isArray(payload.items) ? payload.items : [];
    lines.push(`Позиций: ${items.length}`);
    lines.push(`Ошибка: ${normalizeErrorText(error)}`);

    return lines.join("\n");
}

module.exports = {
    formatMoneyRub,
    formatOrderDate,
    formatOrderMessage,
    formatMoyskladExportFailureMessage,
    formatUser
};
