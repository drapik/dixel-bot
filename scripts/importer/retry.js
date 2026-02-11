const { jitter } = require("./utils");

const getErrorStatus = (error) => {
    if (!error) {
        return null;
    }
    const status = Number.parseInt(error.status, 10);
    if (Number.isFinite(status)) {
        return status;
    }
    const code = Number.parseInt(error.code, 10);
    if (Number.isFinite(code)) {
        return code;
    }
    return null;
};

const isRateLimitError = (error) => {
    const status = getErrorStatus(error);
    if (status === 429) {
        return true;
    }
    const message = String(error?.message || "").toLowerCase();
    return message.includes("too many requests") || message.includes("rate limit");
};

const computeRetryDelay = (config, error, attempt) => {
    const isRateLimited = isRateLimitError(error);
    const baseDelay = isRateLimited ? config.rateLimitRetryMs : config.retryDelayMs;
    const maxDelay = isRateLimited ? config.rateLimitMaxDelayMs : config.maxRetryDelayMs;
    const delay = Math.min(baseDelay * 2 ** attempt, maxDelay);
    return delay + jitter(config.retryJitterMs);
};

function createWithRetry(config, hooks = {}) {
    const { onRateLimit } = hooks;

    async function withRetry(task, label) {
        for (let attempt = 0; attempt <= config.retryLimit; attempt += 1) {
            try {
                return await task();
            } catch (error) {
                if (isRateLimitError(error) && typeof onRateLimit === "function") {
                    onRateLimit(error);
                }
                if (attempt >= config.retryLimit) {
                    throw error;
                }
                const delay = computeRetryDelay(config, error, attempt);
                const status = getErrorStatus(error);
                const statusLabel = status ? `status ${status}` : "ошибка";
                console.warn(`${label}: ${statusLabel}, повтор ${attempt + 1}/${config.retryLimit} через ${delay}мс`);
                // eslint-disable-next-line no-await-in-loop
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
        return null;
    }

    return { withRetry };
}

module.exports = {
    getErrorStatus,
    isRateLimitError,
    createWithRetry
};

