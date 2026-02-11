const { Markup } = require("telegraf");

const { extractEmails, normalizeEmail } = require("../lib/email");
const { fetchAllCounterparties, getMoyskladToken } = require("../lib/moysklad");
const {
    parseTelegramId,
    listActiveAdminIds,
    isAdminUser,
    addAdmin,
    removeAdmin,
    listAdmins
} = require("../lib/admin-access");
const {
    RegistrationStorageError,
    normalizePriceTier,
    mapCustomerActive,
    getCustomerByTelegramId,
    createOrRefreshPendingRequest,
    getRequestById,
    claimRequest,
    assignEmailMatch,
    markRequestError,
    markRequestApproved,
    activateCustomerFromRequest
} = require("../lib/registration-storage");

function formatUserLabel(user) {
    const parts = [];
    const fullName = [user?.first_name, user?.last_name].filter(Boolean).join(" ").trim();
    if (fullName) {
        parts.push(fullName);
    }
    if (user?.username) {
        parts.push(`@${user.username}`);
    }
    if (user?.id) {
        parts.push(`id:${user.id}`);
    }
    return parts.length ? parts.join(" • ") : "Пользователь";
}

function requestLinkText(request) {
    return `#${request?.id || "unknown"}`;
}

function extractCounterpartyEmails(counterparty) {
    const emails = new Set(extractEmails(counterparty?.email));
    const contactRows = counterparty?.contactpersons?.rows;

    if (Array.isArray(contactRows)) {
        contactRows.forEach((contact) => {
            extractEmails(contact?.email).forEach((email) => emails.add(email));
        });
    }

    return Array.from(emails);
}

function findCounterpartyMatches(counterparties, email) {
    const normalized = normalizeEmail(email);
    if (!normalized) {
        return [];
    }

    const matched = [];
    const seen = new Set();

    (counterparties || []).forEach((counterparty) => {
        const counterpartyId = String(counterparty?.id || "").trim();
        if (!counterpartyId || seen.has(counterpartyId)) {
            return;
        }

        const emails = extractCounterpartyEmails(counterparty);
        if (!emails.includes(normalized)) {
            return;
        }

        seen.add(counterpartyId);
        matched.push(counterparty);
    });

    return matched;
}

function buildClaimKeyboard(requestId) {
    return Markup.inlineKeyboard([
        Markup.button.callback("✅ Взять", `regreq:claim:${requestId}`)
    ]);
}

function buildTierKeyboard(requestId) {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback("base", `regreq:tier:${requestId}:base`),
            Markup.button.callback("minus5", `regreq:tier:${requestId}:minus5`)
        ],
        [
            Markup.button.callback("minus8", `regreq:tier:${requestId}:minus8`),
            Markup.button.callback("minus10", `regreq:tier:${requestId}:minus10`)
        ]
    ]);
}

async function notifyAdmins(bot, config, text, extra) {
    const adminIds = await listActiveAdminIds(config);

    for (const adminId of adminIds) {
        try {
            await bot.telegram.sendMessage(adminId, text, extra || {});
        } catch (error) {
            console.warn(`[BOT] Не удалось уведомить админа ${adminId}:`, String(error?.message || error));
        }
    }
}

function parseCommandParts(text) {
    return String(text || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
}

function formatRequestMessage(request) {
    const user = {
        id: request?.telegram_id,
        username: request?.username,
        first_name: request?.first_name,
        last_name: request?.last_name
    };
    return [
        "🆕 Новая заявка на регистрацию",
        `Заявка: ${requestLinkText(request)}`,
        `Пользователь: ${formatUserLabel(user)}`
    ].join("\n");
}

function formatAdminList(rows, ownerId) {
    if (!rows.length) {
        return "Список админов пуст.";
    }

    const lines = ["Список админов:"];
    rows.forEach((row) => {
        const isOwner = ownerId && row.telegramId === ownerId;
        const ownerMark = isOwner ? " (owner)" : "";
        const state = row.isActive ? "active" : "inactive";
        lines.push(`- ${row.telegramId}${ownerMark} — ${state}`);
    });
    return lines.join("\n");
}

async function withAdminGuard(ctx, config) {
    const adminId = parseTelegramId(ctx.from?.id);
    if (!adminId) {
        return null;
    }

    const allowed = await isAdminUser(adminId, config);
    if (!allowed) {
        await ctx.reply("⛔️ Команда доступна только администратору.");
        return null;
    }

    return adminId;
}

async function handleRegEmail(bot, ctx, config) {
    const adminId = await withAdminGuard(ctx, config);
    if (!adminId) {
        return;
    }

    const parts = parseCommandParts(ctx.message?.text);
    const [, requestIdRaw, emailRaw] = parts;
    const requestId = String(requestIdRaw || "").trim();
    const email = normalizeEmail(emailRaw);

    if (!requestId || !email) {
        await ctx.reply("Формат: /reg_email <request_id> <email>");
        return;
    }

    const request = await getRequestById(requestId);
    if (!request?.id) {
        await ctx.reply("❌ Заявка не найдена.");
        return;
    }

    if (request.status !== "claimed" || Number(request.claimed_by) !== adminId) {
        await ctx.reply("❌ Заявка не закреплена за вами. Сначала нажмите «Взять».");
        return;
    }

    const token = getMoyskladToken();
    if (!token) {
        await ctx.reply("❌ Не задан MOYSKLAD_TOKEN в .env");
        return;
    }

    let counterparties;
    try {
        counterparties = await fetchAllCounterparties({ token });
    } catch (error) {
        console.error("[BOT] Ошибка загрузки контрагентов МойСклад:", error);
        await ctx.reply(`❌ Ошибка МойСклад: ${String(error?.message || error)}`.slice(0, 3500));
        return;
    }

    const matches = findCounterpartyMatches(counterparties, email);
    if (matches.length !== 1) {
        const errorCode = matches.length === 0 ? "counterparty_not_found" : "counterparty_ambiguous";
        const errorMessage = matches.length === 0
            ? `Не найден контрагент МойСклад по email ${email}`
            : `Найдено несколько контрагентов МойСклад по email ${email}`;

        await markRequestError({
            requestId,
            adminId,
            errorCode,
            errorMessage
        });

        await notifyAdmins(
            bot,
            config,
            [
                "⚠️ Ошибка регистрации",
                `Заявка: ${requestLinkText(request)}`,
                errorMessage,
                "Исправьте дубль/данные в МойСклад и повторите обработку."
            ].join("\n")
        );

        await ctx.reply(
            [
                "❌ Не удалось автоматически привязать контрагента.",
                errorMessage,
                "Заявка переведена в ошибку."
            ].join("\n")
        );
        return;
    }

    const matched = matches[0];
    await assignEmailMatch({
        requestId,
        adminId,
        email,
        moyskladCounterpartyId: matched.id
    });

    const tierKeyboard = buildTierKeyboard(requestId);
    await ctx.reply(
        [
            `✅ Email принят: ${email}`,
            `Контрагент МойСклад: ${matched.name || matched.id}`,
            "Выберите price_tier:"
        ].join("\n"),
        tierKeyboard
    );
}

async function handleTierSelection(bot, ctx, config) {
    const requestId = String(ctx.match?.[1] || "").trim();
    const tier = normalizePriceTier(ctx.match?.[2]);

    try {
        await ctx.answerCbQuery();
    } catch (error) {
        // ignore
    }

    const adminId = parseTelegramId(ctx.from?.id);
    if (!adminId || !(await isAdminUser(adminId, config))) {
        try {
            await ctx.answerCbQuery("Только админ может обработать заявку.", { show_alert: true });
        } catch (error) {
            // ignore
        }
        return;
    }

    if (!requestId || !tier) {
        await ctx.reply("❌ Некорректные данные выбора прайса.");
        return;
    }

    const request = await getRequestById(requestId);
    if (!request?.id) {
        await ctx.reply("❌ Заявка не найдена.");
        return;
    }

    if (request.status !== "claimed" || Number(request.claimed_by) !== adminId) {
        await ctx.reply("❌ Заявка не закреплена за вами или уже обработана.");
        return;
    }

    if (!normalizeEmail(request.email) || !request.moysklad_counterparty_id) {
        await ctx.reply("❌ Сначала укажите email через /reg_email.");
        return;
    }

    try {
        await activateCustomerFromRequest({
            request,
            priceTier: tier
        });

        await markRequestApproved({
            requestId: request.id,
            adminId,
            priceTier: tier
        });
    } catch (error) {
        const code = error instanceof RegistrationStorageError ? error.code : "activate_failed";
        const message = String(error?.message || error);

        await markRequestError({
            requestId: request.id,
            adminId,
            errorCode: code,
            errorMessage: message
        });

        await notifyAdmins(
            bot,
            config,
            [
                "⚠️ Ошибка регистрации",
                `Заявка: ${requestLinkText(request)}`,
                `Ошибка: ${message}`
            ].join("\n")
        );

        await ctx.reply(`❌ Не удалось активировать клиента: ${message}`.slice(0, 3500));
        return;
    }

    try {
        if (request.telegram_id) {
            const webAppKeyboard = config.webappUrl
                ? Markup.inlineKeyboard([Markup.button.webApp("Открыть mini app", config.webappUrl)])
                : null;
            await bot.telegram.sendMessage(
                request.telegram_id,
                "✅ Мы вас зарегистрировали, можете пользоваться сайтом.",
                webAppKeyboard || {}
            );
        }
    } catch (error) {
        console.warn("[BOT] Не удалось отправить уведомление пользователю:", error);
    }

    await notifyAdmins(
        bot,
        config,
        [
            "✅ Заявка обработана",
            `Заявка: ${requestLinkText(request)}`,
            `Обработал админ: ${adminId}`,
            `Пользователь: ${formatUserLabel({
                id: request.telegram_id,
                username: request.username,
                first_name: request.first_name,
                last_name: request.last_name
            })}`
        ].join("\n")
    );

    try {
        await ctx.editMessageText("✅ Регистрация завершена.");
    } catch (error) {
        await ctx.reply("✅ Регистрация завершена.");
    }
}

async function handleClaim(bot, ctx, config) {
    const requestId = String(ctx.match?.[1] || "").trim();

    try {
        await ctx.answerCbQuery();
    } catch (error) {
        // ignore
    }

    const adminId = parseTelegramId(ctx.from?.id);
    if (!adminId || !(await isAdminUser(adminId, config))) {
        try {
            await ctx.answerCbQuery("Только админ может взять заявку.", { show_alert: true });
        } catch (error) {
            // ignore
        }
        return;
    }

    const claimResult = await claimRequest({
        requestId,
        adminId
    });

    if (!claimResult.ok) {
        const current = claimResult.request;
        if (current?.status === "claimed" && current?.claimed_by) {
            try {
                await ctx.answerCbQuery(`Заявку уже взял админ ${current.claimed_by}`, { show_alert: true });
            } catch (error) {
                // ignore
            }
            await ctx.reply(`⚠️ Заявка уже в работе у админа ${current.claimed_by}.`);
            return;
        }
        await ctx.reply("⚠️ Заявка уже обработана или недоступна.");
        return;
    }

    const request = claimResult.request;
    try {
        await ctx.editMessageText(`✅ Заявка ${requestLinkText(request)} закреплена за вами.`);
    } catch (error) {
        await ctx.reply(`✅ Заявка ${requestLinkText(request)} закреплена за вами.`);
    }

    await ctx.reply(
        [
            "Следующий шаг:",
            `Используйте команду /reg_email ${request.id} email@company.com`
        ].join("\n")
    );
}

function registerRegistrationRequests(bot, config) {
    bot.start(async (ctx) => {
        const userId = parseTelegramId(ctx.from?.id);
        if (!userId) {
            await ctx.reply("❌ Не удалось определить Telegram ID.");
            return;
        }

        try {
            const customer = await getCustomerByTelegramId(userId);
            if (mapCustomerActive(customer)) {
                const keyboard = config.webappUrl
                    ? Markup.inlineKeyboard([Markup.button.webApp("Открыть mini app", config.webappUrl)])
                    : null;
                await ctx.reply("✅ Вы уже зарегистрированы.", keyboard || {});
                return;
            }

            const { request, isNew, isClaimed } = await createOrRefreshPendingRequest({
                telegramId: userId,
                username: ctx.from?.username || null,
                firstName: ctx.from?.first_name || null,
                lastName: ctx.from?.last_name || null
            });

            if (isClaimed) {
                await ctx.reply("⏳ Ваша заявка уже в обработке у менеджера.");
                return;
            }

            await ctx.reply("✅ Заявка отправлена менеджеру.");

            const text = formatRequestMessage(request);
            await notifyAdmins(bot, config, text, buildClaimKeyboard(request.id));

            if (!isNew) {
                await ctx.reply("ℹ️ Напоминание отправлено администраторам.");
            }
        } catch (error) {
            console.error("[BOT] Ошибка /start регистрации:", error);
            await ctx.reply("❌ Не удалось создать заявку. Попробуйте позже.");
        }
    });

    bot.action(/^regreq:claim:([0-9a-f-]{36})$/i, async (ctx) => {
        await handleClaim(bot, ctx, config);
    });

    bot.command("reg_email", async (ctx) => {
        await handleRegEmail(bot, ctx, config);
    });

    bot.action(/^regreq:tier:([0-9a-f-]{36}):(base|minus5|minus8|minus10)$/i, async (ctx) => {
        await handleTierSelection(bot, ctx, config);
    });

    bot.command("admin_add", async (ctx) => {
        const ownerId = parseTelegramId(config.adminId);
        const actorId = parseTelegramId(ctx.from?.id);

        if (!actorId || actorId !== ownerId) {
            await ctx.reply("⛔️ Команда доступна только главному админу.");
            return;
        }

        const parts = parseCommandParts(ctx.message?.text);
        const adminId = parseTelegramId(parts[1]);
        if (!adminId) {
            await ctx.reply("Формат: /admin_add <telegram_id>");
            return;
        }

        try {
            await addAdmin(adminId, { addedBy: actorId });
            await ctx.reply(`✅ Админ ${adminId} добавлен.`);
        } catch (error) {
            await ctx.reply(`❌ Ошибка: ${String(error?.message || error)}`.slice(0, 3500));
        }
    });

    bot.command("admin_remove", async (ctx) => {
        const ownerId = parseTelegramId(config.adminId);
        const actorId = parseTelegramId(ctx.from?.id);

        if (!actorId || actorId !== ownerId) {
            await ctx.reply("⛔️ Команда доступна только главному админу.");
            return;
        }

        const parts = parseCommandParts(ctx.message?.text);
        const adminId = parseTelegramId(parts[1]);
        if (!adminId) {
            await ctx.reply("Формат: /admin_remove <telegram_id>");
            return;
        }

        try {
            await removeAdmin(adminId, config);
            await ctx.reply(`✅ Админ ${adminId} отключен.`);
        } catch (error) {
            await ctx.reply(`❌ Ошибка: ${String(error?.message || error)}`.slice(0, 3500));
        }
    });

    bot.command("admins", async (ctx) => {
        const actorId = await withAdminGuard(ctx, config);
        if (!actorId) {
            return;
        }

        try {
            const rows = await listAdmins(config);
            const ownerId = parseTelegramId(config.adminId);
            await ctx.reply(formatAdminList(rows, ownerId));
        } catch (error) {
            await ctx.reply(`❌ Ошибка: ${String(error?.message || error)}`.slice(0, 3500));
        }
    });
}

module.exports = {
    registerRegistrationRequests
};
