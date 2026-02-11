const { isAdminUser } = require("../lib/admin-access");

function registerCommands(bot, config) {
    bot.command("help", async (ctx) => {
        const lines = [
            "Команды:",
            "",
            "/ping — проверить, что бот жив",
            "/id — показать ваш Telegram ID",
            "/start — создать заявку на регистрацию"
        ];

        const isAdmin = await isAdminUser(ctx.from?.id, config);
        if (isAdmin) {
            lines.push("/ms_link — привязать контрагентов МойСклад по email (только админ)");
            lines.push("/ms_link_products — привязать товары к МойСклад по SKU/UUID (только админ)");
            lines.push("/reg_email <request_id> <email> — обработать заявку регистрации");
            lines.push("/admins — список админов");
        }

        if (ctx.from?.id && Number(ctx.from.id) === Number(config.adminId)) {
            lines.push("/admin_add <telegram_id> — добавить админа");
            lines.push("/admin_remove <telegram_id> — отключить админа");
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
