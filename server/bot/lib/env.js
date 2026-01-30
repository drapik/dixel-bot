const DEFAULT_ADMIN_ID = 314009331;

function parseChatId(value) {
    if (value === undefined || value === null) {
        return null;
    }

    const parsed = Number.parseInt(String(value).trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function getBotConfig() {
    const token = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
    const adminId = parseChatId(process.env.TELEGRAM_ADMIN_ID) ?? DEFAULT_ADMIN_ID;
    const webappUrl = String(process.env.WEBAPP_URL || "").trim() || null;
    const orderTimeZone = String(
        process.env.ORDER_TIMEZONE || process.env.TZ || "Europe/Moscow"
    ).trim();

    return {
        token,
        adminId,
        webappUrl,
        orderTimeZone
    };
}

module.exports = {
    DEFAULT_ADMIN_ID,
    getBotConfig
};

