const path = require("path");
const { spawn } = require("child_process");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { isTruthy, parsePositiveInt } = require("./importer/utils");

const parseTimeHHMM = (value, fallback) => {
    const raw = String(value || "").trim();
    const match = raw.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) {
        return fallback;
    }
    const hour = Number.parseInt(match[1], 10);
    const minute = Number.parseInt(match[2], 10);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
        return fallback;
    }
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        return fallback;
    }
    return { hour, minute };
};

const msUntilNextDailyRun = ({ hour, minute }) => {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
    if (next <= now) {
        next.setDate(next.getDate() + 1);
    }
    return next.getTime() - now.getTime();
};

const formatLocal = (date) => {
    try {
        return new Intl.DateTimeFormat("ru-RU", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit"
        }).format(date);
    } catch (error) {
        return date.toISOString();
    }
};

const argv = new Set(process.argv.slice(2));
const RUN_ONCE = argv.has("--once") || argv.has("--run-once");
const RUN_FULL_ONCE = argv.has("--full-once");
const RUN_DELTA_ONCE = argv.has("--delta-once") || RUN_ONCE;

const DELTA_INTERVAL_MINUTES = parsePositiveInt(process.env.IMPORT_DELTA_INTERVAL_MINUTES, 20);
const FULL_AT = parseTimeHHMM(
    process.env.IMPORT_FULL_AT,
    { hour: 3, minute: 0 }
);

const WIPE_ON_START = isTruthy(process.env.IMPORT_WIPE_ON_START);

const deltaIntervalMs = DELTA_INTERVAL_MINUTES * 60 * 1000;

let isRunning = false;
let hasRunFull = false;

function spawnImport(args, label) {
    if (isRunning) {
        console.log(`[SCHED] ${label}: предыдущий импорт еще выполняется, пропускаем`);
        return Promise.resolve({ skipped: true, code: null });
    }

    isRunning = true;
    const startedAt = new Date();
    console.log(`[SCHED] ${label} старт: ${formatLocal(startedAt)} (TZ=${process.env.TZ || "system"})`);

    const scriptPath = path.join(__dirname, "import-yml.js");
    const child = spawn(process.execPath, [scriptPath, ...args], {
        stdio: "inherit",
        env: process.env
    });

    return new Promise((resolve) => {
        child.on("exit", (code) => {
            isRunning = false;
            const finishedAt = new Date();
            console.log(`[SCHED] ${label} завершен: ${formatLocal(finishedAt)} (code ${code ?? 0})`);
            resolve({ skipped: false, code: code ?? 0 });
        });

        child.on("error", (error) => {
            isRunning = false;
            console.error(`[SCHED] ${label} ошибка запуска:`, error);
            resolve({ skipped: false, code: 1 });
        });
    });
}

async function runFull() {
    const args = ["--full"];
    if (!hasRunFull && WIPE_ON_START) {
        args.push("--wipe");
    }
    const result = await spawnImport(args, "FULL");
    if (!result.skipped) {
        hasRunFull = true;
    }
    return result;
}

async function runDelta() {
    return spawnImport(["--delta"], "DELTA");
}

async function deltaLoop() {
    while (true) {
        if (RUN_FULL_ONCE && !RUN_DELTA_ONCE) {
            return;
        }
        if (RUN_DELTA_ONCE) {
            await runDelta();
            return;
        }

        await runDelta();
        console.log(`[SCHED] DELTA следующий запуск через ${DELTA_INTERVAL_MINUTES} минут`);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, deltaIntervalMs));
    }
}

function scheduleNextFull() {
    if (RUN_DELTA_ONCE && !RUN_FULL_ONCE) {
        return;
    }
    if (RUN_FULL_ONCE) {
        runFull().then(() => process.exit(0));
        return;
    }

    const delayMs = msUntilNextDailyRun(FULL_AT);
    const nextAt = new Date(Date.now() + delayMs);
    console.log(`[SCHED] FULL следующий запуск: ${formatLocal(nextAt)} (в ${FULL_AT.hour}:${String(FULL_AT.minute).padStart(2, "0")})`);

    setTimeout(async () => {
        await runFull();
        scheduleNextFull();
    }, delayMs);
}

// Стартуем: дельту сразу, full по расписанию.
deltaLoop().catch((error) => console.error("[SCHED] DELTA loop crashed:", error));
scheduleNextFull();

