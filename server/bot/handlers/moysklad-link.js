const crypto = require("crypto");
const { Markup } = require("telegraf");

const { extractEmails, normalizeEmail } = require("../lib/email");
const { fetchAllCounterparties, getMoyskladToken } = require("../lib/moysklad");
const { getSupabaseAdminClient } = require("../lib/supabase");
const { isAdminUser } = require("../lib/admin-access");

const PENDING_TTL_MS = 15 * 60 * 1000;
const pendingByNonce = new Map();

function purgeExpiredPending() {
    const now = Date.now();
    for (const [nonce, pending] of pendingByNonce.entries()) {
        if (!pending?.createdAt || now - pending.createdAt > PENDING_TTL_MS) {
            pendingByNonce.delete(nonce);
        }
    }
}

function buildNonce() {
    return crypto.randomBytes(8).toString("base64url");
}

function formatCustomerLabel(customer) {
    const name = [customer?.first_name, customer?.last_name].filter(Boolean).join(" ").trim();
    if (name) {
        return name;
    }
    if (customer?.username) {
        return `@${customer.username}`;
    }
    if (customer?.telegram_id) {
        return `tg:${customer.telegram_id}`;
    }
    return customer?.id || "—";
}

function chunkLines(lines, { maxChars = 3500 } = {}) {
    const chunks = [];
    let current = [];
    let currentLen = 0;

    lines.forEach((line) => {
        const nextLen = currentLen + line.length + (current.length ? 1 : 0);
        if (current.length && nextLen > maxChars) {
            chunks.push(current);
            current = [];
            currentLen = 0;
        }
        current.push(line);
        currentLen += line.length + (current.length > 1 ? 1 : 0);
    });

    if (current.length) {
        chunks.push(current);
    }

    return chunks;
}

function buildPlan({ customers, counterparties }) {
    const customersByEmail = new Map();
    const counterpartiesByEmail = new Map();

    (customers || []).forEach((customer) => {
        const email = normalizeEmail(customer?.email);
        if (!email) {
            return;
        }
        const list = customersByEmail.get(email) || [];
        list.push(customer);
        customersByEmail.set(email, list);
    });

    (counterparties || []).forEach((counterparty) => {
        const emails = new Set(extractEmails(counterparty?.email));
        const contactpersons = counterparty?.contactpersons?.rows;
        if (Array.isArray(contactpersons)) {
            contactpersons.forEach((person) => {
                extractEmails(person?.email).forEach((email) => emails.add(email));
            });
        }

        emails.forEach((email) => {
            const list = counterpartiesByEmail.get(email) || [];
            const counterpartyId = counterparty?.id ? String(counterparty.id) : null;
            if (!counterpartyId || !list.some((item) => String(item?.id) === counterpartyId)) {
                list.push(counterparty);
            }
            counterpartiesByEmail.set(email, list);
        });
    });

    const updates = [];
    const problems = {
        duplicateCustomerEmails: [],
        duplicateCounterpartyEmails: [],
        noCounterpartyMatch: [],
        alreadyLinked: [],
        alreadyLinkedDifferent: []
    };

    for (const [email, customersWithEmail] of customersByEmail.entries()) {
        if (customersWithEmail.length > 1) {
            problems.duplicateCustomerEmails.push({ email, count: customersWithEmail.length });
            continue;
        }

        const customer = customersWithEmail[0];
        const counterpartiesWithEmail = counterpartiesByEmail.get(email) || [];

        if (!counterpartiesWithEmail.length) {
            problems.noCounterpartyMatch.push(email);
            continue;
        }

        if (counterpartiesWithEmail.length > 1) {
            problems.duplicateCounterpartyEmails.push({ email, count: counterpartiesWithEmail.length });
            continue;
        }

        const counterparty = counterpartiesWithEmail[0];
        const msId = counterparty?.id || null;
        if (!msId) {
            continue;
        }

        const currentMsId = customer?.moysklad_counterparty_id || null;
        if (currentMsId) {
            if (String(currentMsId) === String(msId)) {
                problems.alreadyLinked.push(email);
                continue;
            }
            problems.alreadyLinkedDifferent.push({ email, customerMsId: currentMsId, msId });
            continue;
        }

        updates.push({
            customerId: customer.id,
            telegramId: customer.telegram_id,
            email,
            moyskladCounterpartyId: msId,
            moyskladCounterpartyName: counterparty?.name || "—",
            customerLabel: formatCustomerLabel(customer)
        });
    }

    return { updates, problems };
}

function buildPreviewLines({ updates, problems }) {
    const lines = [];
    lines.push(`Найдено изменений: ${updates.length}`);

    if (updates.length) {
        lines.push("");
        lines.push("План обновлений (email -> UUID МС):");
        updates.forEach((entry, index) => {
            lines.push(
                `${index + 1}) ${entry.customerLabel} (${entry.email}) -> ${entry.moyskladCounterpartyId} (${entry.moyskladCounterpartyName})`
            );
        });
    }

    const hasProblems = Object.values(problems || {}).some((list) => Array.isArray(list) && list.length);
    if (hasProblems) {
        lines.push("");
        lines.push("⚠️ Проблемы (не будут изменены автоматически):");

        if (problems.duplicateCustomerEmails?.length) {
            lines.push(`- Дубли email у клиентов: ${problems.duplicateCustomerEmails.length}`);
        }
        if (problems.duplicateCounterpartyEmails?.length) {
            lines.push(`- Дубли email у контрагентов МС: ${problems.duplicateCounterpartyEmails.length}`);
        }
        if (problems.noCounterpartyMatch?.length) {
            lines.push(`- Нет контрагента МС по email: ${problems.noCounterpartyMatch.length}`);
        }
        if (problems.alreadyLinkedDifferent?.length) {
            lines.push(`- Уже привязаны к другому UUID МС: ${problems.alreadyLinkedDifferent.length}`);
        }
    }

    return lines;
}

async function safeEditMessageText(ctx, text) {
    try {
        await ctx.editMessageText(text);
    } catch (error) {
        // ignore (например, если сообщение нельзя редактировать)
    }
}

async function applyUpdates({ updates }) {
    const supabase = getSupabaseAdminClient();
    let applied = 0;
    let skipped = 0;
    const errors = [];

    for (const update of updates) {
        const { data, error } = await supabase
            .from("customers")
            .update({ moysklad_counterparty_id: update.moyskladCounterpartyId })
            .eq("id", update.customerId)
            .is("moysklad_counterparty_id", null)
            .select("id");

        if (error) {
            errors.push({ email: update.email, message: error.message });
            continue;
        }

        if (!data || !data.length) {
            skipped += 1;
            continue;
        }

        applied += 1;
    }

    return { applied, skipped, errors };
}

function registerMoyskladLinking(bot, config) {
    bot.command("ms_link", async (ctx) => {
        if (!(await isAdminUser(ctx.from?.id, config))) {
            await ctx.reply("⛔️ Команда доступна только администратору.");
            return;
        }

        purgeExpiredPending();

        await ctx.reply("⏳ Загружаю контрагентов из МойСклад и клиентов из Supabase…");

        const token = getMoyskladToken();
        if (!token) {
            await ctx.reply("❌ Не задан MOYSKLAD_TOKEN в .env");
            return;
        }

        let counterparties = [];
        try {
            counterparties = await fetchAllCounterparties({ token });
        } catch (error) {
            console.error("[BOT] МойСклад загрузка контрагентов failed:", error);
            await ctx.reply(`❌ Ошибка МойСклад: ${String(error?.message || error)}`.slice(0, 3500));
            return;
        }

        const supabase = getSupabaseAdminClient();
        const { data: customers, error: customersError } = await supabase
            .from("customers")
            .select("id, telegram_id, email, username, first_name, last_name, moysklad_counterparty_id");

        if (customersError) {
            console.error("[BOT] Supabase customers select failed:", customersError);
            const message = customersError.message || "unknown_error";

            if (message.includes("email") || message.includes("moysklad_counterparty_id")) {
                await ctx.reply(
                    [
                        "❌ В Supabase пока нет нужных колонок в `customers`.",
                        "Выполни SQL миграцию и повтори команду:",
                        "scripts/supabase/migrations/2026-01-30_customers_email_moysklad.sql"
                    ].join("\n")
                );
                return;
            }

            await ctx.reply(`❌ Ошибка Supabase: ${message}`.slice(0, 3500));
            return;
        }

        const { updates, problems } = buildPlan({ customers, counterparties });
        const previewLines = buildPreviewLines({ updates, problems });
        const chunks = chunkLines(previewLines);

        for (const chunk of chunks) {
            await ctx.reply(chunk.join("\n"));
        }

        if (!updates.length) {
            return;
        }

        const nonce = buildNonce();
        pendingByNonce.set(nonce, {
            nonce,
            adminId: Number(ctx.from?.id),
            createdAt: Date.now(),
            updates
        });

        const keyboard = Markup.inlineKeyboard([
            Markup.button.callback("✅ Подтвердить", `ms_link:confirm:${nonce}`),
            Markup.button.callback("❌ Отмена", `ms_link:cancel:${nonce}`)
        ]);

        await ctx.reply(`Подтвердить применение ${updates.length} изменений?`, keyboard);
    });

    bot.action(/^ms_link:(confirm|cancel):([A-Za-z0-9_-]+)$/, async (ctx) => {
        const action = ctx.match?.[1];
        const nonce = ctx.match?.[2];

        try {
            await ctx.answerCbQuery();
        } catch (error) {
            // ignore
        }

        if (!(await isAdminUser(ctx.from?.id, config))) {
            await safeEditMessageText(ctx, "⛔️ Команда доступна только администратору.");
            return;
        }

        purgeExpiredPending();
        const pending = pendingByNonce.get(nonce);

        if (!pending) {
            await safeEditMessageText(ctx, "⚠️ План не найден или устарел. Запусти /ms_link заново.");
            return;
        }

        if (Number(ctx.from?.id) !== Number(pending.adminId)) {
            await safeEditMessageText(ctx, "⛔️ Этот запрос подтверждения создан другим админом.");
            return;
        }

        if (action === "cancel") {
            pendingByNonce.delete(nonce);
            await safeEditMessageText(ctx, "❌ Отменено.");
            return;
        }

        await safeEditMessageText(ctx, "⏳ Применяю изменения в Supabase…");

        let result;
        try {
            result = await applyUpdates({ updates: pending.updates });
        } catch (error) {
            console.error("[BOT] Supabase applyUpdates failed:", error);
            pendingByNonce.delete(nonce);
            await safeEditMessageText(
                ctx,
                `❌ Ошибка при обновлении Supabase: ${String(error?.message || error)}`.slice(0, 3500)
            );
            return;
        }

        pendingByNonce.delete(nonce);

        const lines = [
            "✅ Готово.",
            `Применено: ${result.applied}`,
            `Пропущено (уже заполнено/не найдено): ${result.skipped}`
        ];

        if (result.errors?.length) {
            lines.push(`Ошибки: ${result.errors.length}`);
            result.errors.slice(0, 10).forEach((entry) => {
                lines.push(`- ${entry.email}: ${entry.message}`);
            });
            if (result.errors.length > 10) {
                lines.push(`… и еще ${result.errors.length - 10}`);
            }
        }

        await ctx.reply(lines.join("\n"));
    });
}

module.exports = { registerMoyskladLinking };
