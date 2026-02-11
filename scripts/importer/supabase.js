const { createClient } = require("@supabase/supabase-js");

const { chunk, clamp, jitter, sleep } = require("./utils");
const { createWithRetry, isRateLimitError } = require("./retry");

function createSupabaseClient({ url, serviceKey, requestTimeoutMs }) {
    if (!url || !serviceKey) {
        throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    }

    const fetchWithTimeout = async (input, init = {}) => {
        if (!requestTimeoutMs || requestTimeoutMs <= 0) {
            return fetch(input, init);
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);
        try {
            return await fetch(input, { ...init, signal: controller.signal });
        } finally {
            clearTimeout(timeoutId);
        }
    };

    return createClient(url, serviceKey, {
        auth: { persistSession: false },
        global: { fetch: fetchWithTimeout }
    });
}

function createUpsertRunner(supabase, config) {
    const throttleState = {
        delayMs: clamp(config.batchDelayMs, config.batchDelayMinMs, config.batchDelayMaxMs),
        minDelayMs: config.batchDelayMinMs,
        maxDelayMs: config.batchDelayMaxMs,
        concurrency: clamp(config.batchConcurrency, config.batchMinConcurrency, config.batchMaxConcurrency),
        minConcurrency: config.batchMinConcurrency,
        maxConcurrency: config.batchMaxConcurrency,
        successStreak: 0,
        rateLimitHits: 0
    };

    const { withRetry } = createWithRetry(config.retry, {
        onRateLimit: () => {
            throttleState.rateLimitHits += 1;
        }
    });

    const adjustThrottleAfterGroup = (rateLimited) => {
        if (rateLimited) {
            throttleState.successStreak = 0;
            throttleState.delayMs = clamp(
                Math.round(throttleState.delayMs * 1.5),
                throttleState.minDelayMs,
                throttleState.maxDelayMs
            );
            if (throttleState.concurrency > throttleState.minConcurrency) {
                throttleState.concurrency -= 1;
            }
            return;
        }

        throttleState.successStreak += 1;
        if (throttleState.successStreak >= config.batchRampGroups) {
            throttleState.delayMs = clamp(
                Math.round(throttleState.delayMs * 0.9),
                throttleState.minDelayMs,
                throttleState.maxDelayMs
            );
            if (throttleState.concurrency < throttleState.maxConcurrency) {
                throttleState.concurrency += 1;
            }
            throttleState.successStreak = 0;
        }
    };

    async function upsertBatchWithSplit(table, batch, label, { onConflict = "external_id" } = {}) {
        if (!batch.length) {
            return;
        }
        try {
            await withRetry(async () => {
                const { error } = await supabase
                    .from(table)
                    .upsert(batch, { onConflict });
                if (error) {
                    throw error;
                }
            }, label);
        } catch (error) {
            if (batch.length <= 1) {
                throw error;
            }
            const mid = Math.ceil(batch.length / 2);
            console.warn(`${label}: батч не прошел, делим на ${mid} и ${batch.length - mid}`);
            await upsertBatchWithSplit(table, batch.slice(0, mid), `${label}a`, { onConflict });
            await upsertBatchWithSplit(table, batch.slice(mid), `${label}b`, { onConflict });
        }
    }

    async function upsertBatchesParallel(table, rows, batchSize, options = {}) {
        const batches = chunk(rows, batchSize);
        let processed = 0;

        for (let i = 0; i < batches.length;) {
            const concurrency = throttleState.concurrency;
            const group = batches.slice(i, Math.min(i + concurrency, batches.length));
            const rateLimitHitsBefore = throttleState.rateLimitHits;

            await Promise.all(group.map((batch, j) =>
                upsertBatchWithSplit(
                    table,
                    batch,
                    `${table} batch ${i + j + 1}/${batches.length}`,
                    options
                )
            ));

            processed += group.reduce((sum, batch) => sum + batch.length, 0);
            console.log(`${table}: ${Math.min(processed, rows.length)}/${rows.length}`);

            adjustThrottleAfterGroup(throttleState.rateLimitHits > rateLimitHitsBefore);

            i += group.length;
            if (i < batches.length) {
                const delayMs = throttleState.delayMs + jitter(config.batchJitterMs);
                if (delayMs > 0) {
                    // eslint-disable-next-line no-await-in-loop
                    await sleep(delayMs);
                }
            }
        }
    }

    async function clearTable(table) {
        await withRetry(async () => {
            const { error } = await supabase
                .from(table)
                .delete()
                .gte("created_at", "1970-01-01");
            if (error) {
                throw error;
            }
        }, `${table} wipe`);
        console.log(`${table}: cleared`);
    }

    async function fetchExistingExternalIds(ids, { chunkSize = 500 } = {}) {
        const result = new Set();
        const uniqueIds = Array.from(new Set((ids || []).map((id) => String(id)).filter(Boolean)));
        const chunks = chunk(uniqueIds, chunkSize);

        for (let i = 0; i < chunks.length; i += 1) {
            const idsChunk = chunks[i];
            if (!idsChunk.length) {
                continue;
            }

            const { data, error } = await withRetry(async () => {
                return await supabase
                    .from("products")
                    .select("external_id")
                    .in("external_id", idsChunk);
            }, `products existence ${i + 1}/${chunks.length}`);

            if (error) {
                throw error;
            }
            (data || []).forEach((row) => {
                if (row && row.external_id) {
                    result.add(String(row.external_id));
                }
            });

            // Небольшая пауза между запросами, если Supabase начинает отвечать 429.
            if (chunks.length > 1 && throttleState.rateLimitHits > 0) {
                // eslint-disable-next-line no-await-in-loop
                await sleep(200);
            }
        }

        return result;
    }

    async function fetchProductNameMap(ids, { chunkSize = 500 } = {}) {
        const map = new Map();
        const uniqueIds = Array.from(new Set((ids || []).map((id) => String(id)).filter(Boolean)));
        const chunks = chunk(uniqueIds, chunkSize);

        for (let i = 0; i < chunks.length; i += 1) {
            const idsChunk = chunks[i];
            if (!idsChunk.length) {
                continue;
            }

            const { data, error } = await withRetry(async () => {
                return await supabase
                    .from("products")
                    .select("external_id, name")
                    .in("external_id", idsChunk);
            }, `products name map ${i + 1}/${chunks.length}`);

            if (error) {
                throw error;
            }

            (data || []).forEach((row) => {
                if (row && row.external_id && row.name) {
                    map.set(String(row.external_id), String(row.name));
                }
            });
        }

        return map;
    }

    return {
        upsertBatchesParallel,
        clearTable,
        fetchExistingExternalIds,
        fetchProductNameMap,
        isRateLimitError
    };
}

module.exports = {
    createSupabaseClient,
    createUpsertRunner
};
