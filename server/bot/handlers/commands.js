const { Markup } = require("telegraf");

function registerCommands(bot, config) {
    bot.start(async (ctx) => {
        const lines = [
            "DIXEL бот запущен.",
            "",
            "Команды:",
            "/ping — проверить, что бот жив",
            "/id — показать ваш Telegram ID"
        ];

        if (ctx.from?.id && Number(ctx.from.id) === Number(config.adminId)) {
            lines.push("/ms_link — привязать контрагентов МойСклад по email (только админ)");
            lines.push("/ms_link_products — привязать товары к МойСклад по SKU/UUID (только админ)");
        }

        if (config.webappUrl) {
            const keyboard = Markup.inlineKeyboard([
                Markup.button.webApp("Открыть mini app", config.webappUrl)
            ]);
            await ctx.reply(lines.join("\n"), keyboard);
            return;
        }

        await ctx.reply(lines.join("\n"));
    });

    bot.command("ping", async (ctx) => {
        await ctx.reply(`pong ${new Date().toISOString()}`);
    });

    bot.command("id", async (ctx) => {
        await ctx.reply(`Ваш Telegram ID: ${ctx.from?.id ?? "—"}`);
    });
}

module.exports = { registerCommands };
