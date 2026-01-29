const path = require("path");
const { spawn } = require("child_process");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const parsePositiveInt = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const TRUTHY = new Set(["1", "true", "yes", "y", "on"]);
const isTruthy = (value) => {
    if (value === undefined || value === null) {
        return false;
    }
    return TRUTHY.has(String(value).trim().toLowerCase());
};

const argv = new Set(process.argv.slice(2));
const RUN_ONCE = argv.has("--once") || argv.has("--run-once");
const INTERVAL_MINUTES = parsePositiveInt(process.env.IMPORT_INTERVAL_MINUTES, 30);
const WIPE_ON_START = isTruthy(process.env.IMPORT_WIPE_ON_START);

const intervalMs = INTERVAL_MINUTES * 60 * 1000;
let isRunning = false;
let hasRun = false;

function runImport() {
    if (isRunning) {
        console.log("[IMPORT] Предыдущий импорт еще выполняется, пропускаем");
        return;
    }

    isRunning = true;
    const args = [path.join(__dirname, "import-yml.js")];
    if (!hasRun && WIPE_ON_START) {
        args.push("--wipe");
    }

    console.log(`[IMPORT] Старт: ${new Date().toISOString()}`);
    const child = spawn(process.execPath, args, { stdio: "inherit", env: process.env });

    child.on("exit", (code) => {
        isRunning = false;
        hasRun = true;
        console.log(`[IMPORT] Завершен (code ${code ?? 0})`);
        if (RUN_ONCE) {
            process.exit(code ?? 0);
        }
    });

    child.on("error", (error) => {
        isRunning = false;
        console.error("[IMPORT] Ошибка запуска импорта:", error);
        if (RUN_ONCE) {
            process.exit(1);
        }
    });
}

runImport();
if (!RUN_ONCE) {
    console.log(`[IMPORT] Следующий запуск через ${INTERVAL_MINUTES} минут`);
    setInterval(runImport, intervalMs);
}
