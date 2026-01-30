const { formatOrderMessage } = require("../lib/formatters");

function safeJsonParse(raw) {
    if (!raw) {
        return null;
    }

    try {
        return JSON.parse(raw);
    } catch (error) {
        return null;
    }
}

async function notifyAdmin(ctx, adminId, message) {
    if (!adminId) {
        return;
    }

    await ctx.telegram.sendMessage(adminId, message);
}

function registerWebAppHandlers(bot, config) {
    bot.on("message", async (ctx) => {
        const webAppData = ctx.message?.web_app_data;
        if (!webAppData?.data) {
            return;
        }

        console.log(
            `[BOT] web_app_data from ${ctx.from?.id ?? "unknown"} (${String(webAppData.data).length} chars)`
        );

        const payload = safeJsonParse(webAppData.data);
        if (!payload) {
            console.warn("[BOT] web_app_data JSON parse failed");
            await ctx.reply("❌ Не удалось прочитать данные из mini app.");
            return;
        }

        if (payload.type === "order") {
            const orderMessage = formatOrderMessage(payload, { timeZone: config.orderTimeZone });

            try {
                await notifyAdmin(ctx, config.adminId, orderMessage);
                console.log(`[BOT] Order forwarded to admin ${config.adminId}`);
            } catch (error) {
                console.error("[BOT] Failed to notify admin:", error);
                await ctx.reply("⚠️ Заказ получен, но не удалось отправить админу.");
                return;
            }

            await ctx.reply("✅ Заказ отправлен.");
            return;
        }

        await ctx.reply("✅ Данные получены.");
    });
}

module.exports = { registerWebAppHandlers };
