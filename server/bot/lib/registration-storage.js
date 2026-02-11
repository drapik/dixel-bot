const { getSupabaseAdminClient } = require("./supabase");
const { normalizeEmail } = require("./email");
const { parseTelegramId } = require("./admin-access");

const OPEN_REQUEST_STATUSES = ["pending", "claimed"];
const ALLOWED_PRICE_TIERS = new Set(["base", "minus5", "minus8", "minus10"]);

class RegistrationStorageError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "RegistrationStorageError";
        this.code = code;
    }
}

function normalizePriceTier(value) {
    const tier = String(value || "").trim().toLowerCase();
    return ALLOWED_PRICE_TIERS.has(tier) ? tier : null;
}

function mapCustomerActive(customer) {
    if (!customer || typeof customer !== "object") {
        return false;
    }
    if (String(customer.access_status || "active").toLowerCase() !== "active") {
        return false;
    }
    const tier = normalizePriceTier(customer.price_tier);
    return Boolean(tier);
}

async function getCustomerByTelegramId(telegramId) {
    const parsedTelegramId = parseTelegramId(telegramId);
    if (!parsedTelegramId) {
        return null;
    }

    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
        .from("customers")
        .select("id, telegram_id, email, username, first_name, last_name, price_tier, access_status")
        .eq("telegram_id", parsedTelegramId)
        .maybeSingle();

    if (error) {
        throw error;
    }

    return data || null;
}

async function getOpenRequestByTelegramId(telegramId) {
    const parsedTelegramId = parseTelegramId(telegramId);
    if (!parsedTelegramId) {
        return null;
    }

    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
        .from("registration_requests")
        .select("*")
        .eq("telegram_id", parsedTelegramId)
        .in("status", OPEN_REQUEST_STATUSES)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) {
        throw error;
    }

    return data || null;
}

async function createOrRefreshPendingRequest({
    telegramId,
    username,
    firstName,
    lastName
}) {
    const parsedTelegramId = parseTelegramId(telegramId);
    if (!parsedTelegramId) {
        throw new RegistrationStorageError("invalid_telegram_id", "Некорректный Telegram ID");
    }

    const supabase = getSupabaseAdminClient();
    const existing = await getOpenRequestByTelegramId(parsedTelegramId);

    if (existing?.id) {
        if (existing.status === "claimed") {
            return {
                request: existing,
                isNew: false,
                isClaimed: true
            };
        }

        const { data, error } = await supabase
            .from("registration_requests")
            .update({
                username: username || null,
                first_name: firstName || null,
                last_name: lastName || null,
                error_code: null,
                error_message: null
            })
            .eq("id", existing.id)
            .select("*")
            .maybeSingle();

        if (error) {
            throw error;
        }

        return {
            request: data || existing,
            isNew: false,
            isClaimed: false
        };
    }

    const { data, error } = await supabase
        .from("registration_requests")
        .insert({
            telegram_id: parsedTelegramId,
            username: username || null,
            first_name: firstName || null,
            last_name: lastName || null,
            status: "pending"
        })
        .select("*")
        .maybeSingle();

    if (error) {
        throw error;
    }

    return {
        request: data,
        isNew: true,
        isClaimed: false
    };
}

async function getRequestById(requestId) {
    const id = String(requestId || "").trim();
    if (!id) {
        return null;
    }

    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
        .from("registration_requests")
        .select("*")
        .eq("id", id)
        .maybeSingle();

    if (error) {
        throw error;
    }

    return data || null;
}

async function claimRequest({ requestId, adminId }) {
    const parsedAdminId = parseTelegramId(adminId);
    const id = String(requestId || "").trim();

    if (!parsedAdminId || !id) {
        throw new RegistrationStorageError("invalid_claim_data", "Некорректные данные для взятия заявки");
    }

    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
        .from("registration_requests")
        .update({
            status: "claimed",
            claimed_by: parsedAdminId,
            claimed_at: new Date().toISOString(),
            error_code: null,
            error_message: null
        })
        .eq("id", id)
        .eq("status", "pending")
        .select("*")
        .maybeSingle();

    if (error) {
        throw error;
    }

    if (data?.id) {
        return {
            ok: true,
            request: data
        };
    }

    const current = await getRequestById(id);
    return {
        ok: false,
        request: current
    };
}

async function assignEmailMatch({
    requestId,
    adminId,
    email,
    moyskladCounterpartyId
}) {
    const parsedAdminId = parseTelegramId(adminId);
    const id = String(requestId || "").trim();
    const normalized = normalizeEmail(email);
    const counterpartyId = String(moyskladCounterpartyId || "").trim();

    if (!parsedAdminId || !id || !normalized || !counterpartyId) {
        throw new RegistrationStorageError("invalid_match_data", "Некорректные данные для привязки email");
    }

    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
        .from("registration_requests")
        .update({
            email: normalized,
            moysklad_counterparty_id: counterpartyId,
            error_code: null,
            error_message: null
        })
        .eq("id", id)
        .eq("status", "claimed")
        .eq("claimed_by", parsedAdminId)
        .select("*")
        .maybeSingle();

    if (error) {
        throw error;
    }

    if (!data?.id) {
        throw new RegistrationStorageError("request_not_claimed", "Заявка не закреплена за админом");
    }

    return data;
}

async function markRequestError({
    requestId,
    adminId,
    errorCode,
    errorMessage
}) {
    const parsedAdminId = parseTelegramId(adminId);
    const id = String(requestId || "").trim();
    if (!parsedAdminId || !id) {
        throw new RegistrationStorageError("invalid_error_data", "Некорректные данные ошибки заявки");
    }

    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
        .from("registration_requests")
        .update({
            status: "error",
            resolved_by: parsedAdminId,
            resolved_at: new Date().toISOString(),
            error_code: String(errorCode || "unknown_error"),
            error_message: String(errorMessage || "").slice(0, 1000)
        })
        .eq("id", id)
        .select("*")
        .maybeSingle();

    if (error) {
        throw error;
    }

    return data || null;
}

async function markRequestApproved({
    requestId,
    adminId,
    priceTier
}) {
    const parsedAdminId = parseTelegramId(adminId);
    const id = String(requestId || "").trim();
    const tier = normalizePriceTier(priceTier);

    if (!parsedAdminId || !id || !tier) {
        throw new RegistrationStorageError("invalid_approve_data", "Некорректные данные подтверждения");
    }

    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
        .from("registration_requests")
        .update({
            status: "approved",
            resolved_by: parsedAdminId,
            resolved_at: new Date().toISOString(),
            price_tier: tier,
            error_code: null,
            error_message: null
        })
        .eq("id", id)
        .select("*")
        .maybeSingle();

    if (error) {
        throw error;
    }

    return data || null;
}

async function activateCustomerFromRequest({
    request,
    priceTier
}) {
    const parsedTelegramId = parseTelegramId(request?.telegram_id);
    const tier = normalizePriceTier(priceTier);
    const email = normalizeEmail(request?.email);
    const moyskladCounterpartyId = String(request?.moysklad_counterparty_id || "").trim();

    if (!parsedTelegramId || !tier || !email || !moyskladCounterpartyId) {
        throw new RegistrationStorageError("invalid_activation_data", "Невозможно активировать клиента: неполные данные");
    }

    const supabase = getSupabaseAdminClient();

    const { data: existingByTelegram, error: telegramError } = await supabase
        .from("customers")
        .select("id, telegram_id, email")
        .eq("telegram_id", parsedTelegramId)
        .maybeSingle();

    if (telegramError) {
        throw telegramError;
    }

    const { data: existingByEmail, error: emailError } = await supabase
        .from("customers")
        .select("id, telegram_id, email")
        .ilike("email", email)
        .maybeSingle();

    if (emailError) {
        throw emailError;
    }

    if (
        existingByEmail?.telegram_id
        && Number(existingByEmail.telegram_id) !== parsedTelegramId
    ) {
        throw new RegistrationStorageError(
            "email_already_bound",
            "Этот email уже привязан к другому Telegram аккаунту"
        );
    }

    if (
        existingByTelegram?.id
        && existingByEmail?.id
        && String(existingByTelegram.id) !== String(existingByEmail.id)
    ) {
        throw new RegistrationStorageError(
            "telegram_email_conflict",
            "Конфликт данных: Telegram и email принадлежат разным учеткам"
        );
    }

    const target = existingByEmail || existingByTelegram || null;
    const payload = {
        telegram_id: parsedTelegramId,
        email,
        username: request?.username || null,
        first_name: request?.first_name || null,
        last_name: request?.last_name || null,
        moysklad_counterparty_id: moyskladCounterpartyId,
        price_tier: tier,
        access_status: "active",
        bound_at: new Date().toISOString()
    };

    if (target?.id) {
        const { data, error } = await supabase
            .from("customers")
            .update(payload)
            .eq("id", target.id)
            .select("id, telegram_id, email, price_tier, access_status")
            .maybeSingle();

        if (error) {
            throw error;
        }

        return data || null;
    }

    const { data, error } = await supabase
        .from("customers")
        .insert(payload)
        .select("id, telegram_id, email, price_tier, access_status")
        .maybeSingle();

    if (error) {
        throw error;
    }

    return data || null;
}

module.exports = {
    RegistrationStorageError,
    normalizePriceTier,
    mapCustomerActive,
    getCustomerByTelegramId,
    getOpenRequestByTelegramId,
    createOrRefreshPendingRequest,
    getRequestById,
    claimRequest,
    assignEmailMatch,
    markRequestError,
    markRequestApproved,
    activateCustomerFromRequest
};
