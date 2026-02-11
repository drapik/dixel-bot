const { getSupabaseAdminClient } = require("./supabase");

const ADMIN_CACHE_TTL_MS = 30 * 1000;
let cachedActiveIds = {
    expiresAt: 0,
    ids: []
};
let warnedDbIssue = false;

function parseTelegramId(value) {
    const parsed = Number.parseInt(String(value || "").trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeOwnerId(config) {
    return parseTelegramId(config?.adminId);
}

function invalidateAdminCache() {
    cachedActiveIds = {
        expiresAt: 0,
        ids: []
    };
}

function shouldSuppressDbError(error) {
    const message = String(error?.message || "").toLowerCase();
    return message.includes("bot_admins")
        || message.includes("relation")
        || message.includes("does not exist");
}

async function loadActiveAdminIdsFromDb() {
    const now = Date.now();
    if (cachedActiveIds.expiresAt > now) {
        return cachedActiveIds.ids.slice();
    }

    try {
        const supabase = getSupabaseAdminClient();
        const { data, error } = await supabase
            .from("bot_admins")
            .select("telegram_id")
            .eq("is_active", true);

        if (error) {
            throw error;
        }

        const ids = (data || [])
            .map((row) => parseTelegramId(row?.telegram_id))
            .filter(Boolean);

        cachedActiveIds = {
            expiresAt: now + ADMIN_CACHE_TTL_MS,
            ids
        };
        warnedDbIssue = false;
        return ids.slice();
    } catch (error) {
        if (!warnedDbIssue && !shouldSuppressDbError(error)) {
            console.error("[BOT] Не удалось загрузить bot_admins:", error);
            warnedDbIssue = true;
        }
        cachedActiveIds = {
            expiresAt: now + ADMIN_CACHE_TTL_MS,
            ids: []
        };
        return [];
    }
}

async function listActiveAdminIds(config) {
    const ownerId = normalizeOwnerId(config);
    const fromDb = await loadActiveAdminIdsFromDb();
    const unique = new Set(fromDb);
    if (ownerId) {
        unique.add(ownerId);
    }
    return Array.from(unique);
}

async function isAdminUser(userId, config) {
    const normalized = parseTelegramId(userId);
    if (!normalized) {
        return false;
    }

    const ownerId = normalizeOwnerId(config);
    if (ownerId && normalized === ownerId) {
        return true;
    }

    const ids = await loadActiveAdminIdsFromDb();
    return ids.includes(normalized);
}

async function addAdmin(adminTelegramId, { addedBy } = {}) {
    const telegramId = parseTelegramId(adminTelegramId);
    if (!telegramId) {
        throw new Error("Некорректный Telegram ID администратора");
    }

    const supabase = getSupabaseAdminClient();
    const { error } = await supabase
        .from("bot_admins")
        .upsert(
            {
                telegram_id: telegramId,
                is_active: true,
                added_by: parseTelegramId(addedBy)
            },
            { onConflict: "telegram_id" }
        );

    if (error) {
        throw error;
    }

    invalidateAdminCache();
    return telegramId;
}

async function removeAdmin(adminTelegramId, config) {
    const telegramId = parseTelegramId(adminTelegramId);
    if (!telegramId) {
        throw new Error("Некорректный Telegram ID администратора");
    }

    const ownerId = normalizeOwnerId(config);
    if (ownerId && telegramId === ownerId) {
        throw new Error("Нельзя удалить главного админа из TELEGRAM_ADMIN_ID");
    }

    const supabase = getSupabaseAdminClient();
    const { error } = await supabase
        .from("bot_admins")
        .update({ is_active: false })
        .eq("telegram_id", telegramId);

    if (error) {
        throw error;
    }

    invalidateAdminCache();
    return telegramId;
}

async function listAdmins(config) {
    const ownerId = normalizeOwnerId(config);
    const rows = [];

    try {
        const supabase = getSupabaseAdminClient();
        const { data, error } = await supabase
            .from("bot_admins")
            .select("telegram_id, is_active, added_at, added_by")
            .order("telegram_id", { ascending: true });

        if (error) {
            throw error;
        }

        (data || []).forEach((row) => {
            const telegramId = parseTelegramId(row?.telegram_id);
            if (!telegramId) {
                return;
            }
            rows.push({
                telegramId,
                isActive: Boolean(row?.is_active),
                addedAt: row?.added_at || null,
                addedBy: parseTelegramId(row?.added_by),
                source: "db"
            });
        });
    } catch (error) {
        if (!shouldSuppressDbError(error)) {
            throw error;
        }
    }

    if (ownerId && !rows.some((row) => row.telegramId === ownerId)) {
        rows.unshift({
            telegramId: ownerId,
            isActive: true,
            addedAt: null,
            addedBy: null,
            source: "env_owner"
        });
    }

    return rows.sort((a, b) => a.telegramId - b.telegramId);
}

module.exports = {
    parseTelegramId,
    invalidateAdminCache,
    listActiveAdminIds,
    isAdminUser,
    addAdmin,
    removeAdmin,
    listAdmins
};
