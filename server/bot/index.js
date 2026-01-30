const path = require("path");
const { Telegraf } = require("telegraf");

require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { getBotConfig } = require("./lib/env");
const { registerCommands } = require("./handlers/commands");
const { registerMoyskladLinking } = require("./handlers/moysklad-link");
const { registerMoyskladProductLinking } = require("./handlers/moysklad-link-products");
const { registerWebAppHandlers } = require("./handlers/webapp");

const TRUTHY = new Set(["1", "true", "yes", "y", "on"]);
const isTruthy = (value) => {
    if (value === undefined || value === null) {
        return false;
    }
    return TRUTHY.has(String(value).trim().toLowerCase());
};

const config = getBotConfig();
const dropPendingUpdates = isTruthy(process.env.DROP_PENDING_UPDATES);

if (!config.token) {
    console.error("[BOT] TELEGRAM_BOT_TOKEN is missing; bot will not start.");
    process.exit(1);
}

const bot = new Telegraf(config.token);

registerCommands(bot, config);
registerMoyskladLinking(bot, config);
registerMoyskladProductLinking(bot, config);
registerWebAppHandlers(bot, config);

bot.catch((error) => {
    console.error("[BOT] Unhandled error:", error);
});

async function start() {
    try {
        const me = await bot.telegram.getMe();
        console.log(`[BOT] Logged in as @${me.username} (id ${me.id})`);
    } catch (error) {
        console.warn("[BOT] getMe failed:", error);
    }

    await bot.launch({ dropPendingUpdates });
    console.log(`[BOT] Ready. Admin chat id: ${config.adminId}`);
}

start().catch((error) => {
    console.error("[BOT] Startup failed:", error);
    process.exit(1);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
