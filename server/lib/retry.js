function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetries(task, { retries = 3, delayMs = 5000 } = {}) {
    let attempt = 0;

    while (true) {
        try {
            return await task(attempt);
        } catch (error) {
            if (attempt >= retries) {
                throw error;
            }
            attempt += 1;
            await sleep(delayMs);
        }
    }
}

module.exports = {
    sleep,
    withRetries
};
