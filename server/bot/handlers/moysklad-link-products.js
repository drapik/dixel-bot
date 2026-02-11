const crypto = require("crypto");
const { Markup } = require("telegraf");

const { fetchAllProducts, getMoyskladToken, findProductByCode } = require("../lib/moysklad");
const { getSupabaseAdminClient } = require("../lib/supabase");
const { fetchAllSupabaseProducts } = require("../lib/supabase-products");
const { isAdminUser } = require("../lib/admin-access");

const PENDING_TTL_MS = 15 * 60 * 1000;
const pendingByNonce = new Map();

function purgeExpiredPending() {
    const now = Date.now();
    for (const [nonce, pending] of pendingByNonce.entries()) {
        if (!pending?.createdAt || now - pending.createdAt > PENDING_TTL_MS) {
            pendingByNonce.delete(nonce);
        }
    }
}

function buildNonce() {
    return crypto.randomBytes(8).toString("base64url");
}

function normalizeKey(value) {
    if (value === undefined || value === null) {
        return "";
    }
    return String(value).trim().toLowerCase();
}

function normalizeRaw(value) {
    if (value === undefined || value === null) {
        return "";
    }
    return String(value).trim();
}

function formatProductLabel(product) {
    const sku = product?.sku ? String(product.sku).trim() : "";
    const name = product?.name ? String(product.name).trim() : "";
    if (sku && name) {
        return `${sku} — ${name}`;
    }
    if (sku) {
        return sku;
    }
    if (name) {
        return name;
    }
    return product?.external_id || product?.id || "—";
}

function formatMsLabel(product) {
    const name = product?.name ? String(product.name).trim() : "";
    const code = product?.code ? String(product.code).trim() : "";
    const article = product?.article ? String(product.article).trim() : "";
    const fallback = name || code || article || product?.externalCode || "—";
    return fallback;
}

function formatMsSummary(product) {
    return `${product?.id || "—"} (${formatMsLabel(product)})`;
}

function chunkLines(lines, { maxChars = 3500 } = {}) {
    const chunks = [];
    let current = [];
    let currentLen = 0;

    lines.forEach((line) => {
        const nextLen = currentLen + line.length + (current.length ? 1 : 0);
        if (current.length && nextLen > maxChars) {
            chunks.push(current);
            current = [];
            currentLen = 0;
        }
        current.push(line);
        currentLen += line.length + (current.length > 1 ? 1 : 0);
    });

    if (current.length) {
        chunks.push(current);
    }

    return chunks;
}

function indexByKey(items, keyGetter) {
    const map = new Map();
    (items || []).forEach((item) => {
        const key = normalizeKey(keyGetter(item));
        if (!key) {
            return;
        }
        const list = map.get(key) || [];
        list.push(item);
        map.set(key, list);
    });
    return map;
}

function countDuplicates(index) {
    let total = 0;
    for (const list of index.values()) {
        if (list.length > 1) {
            total += 1;
        }
    }
    return total;
}

function normalizeMsProducts(rawProducts) {
    return (rawProducts || [])
        .map((product) => {
            const id = product?.id ? String(product.id) : null;
            if (!id) {
                return null;
            }
            return {
                id,
                name: product?.name ? String(product.name) : "",
                code: product?.code ? String(product.code) : "",
                article: product?.article ? String(product.article) : "",
                externalCode: product?.externalCode ? String(product.externalCode) : ""
            };
        })
        .filter(Boolean);
}

function buildPlan({ products, msProducts }) {
    const msByCode = indexByKey(msProducts, (item) => item.code);
    const msByArticle = indexByKey(msProducts, (item) => item.article);
    const msByExternalCode = indexByKey(msProducts, (item) => item.externalCode);
    const msByName = indexByKey(msProducts, (item) => item.name);

    const dbBySku = indexByKey(products, (item) => item.sku);
    const dbByExternalId = indexByKey(products, (item) => item.external_id);
    const dbByName = indexByKey(products, (item) => item.name);

    const updates = [];
    const usedMsIds = new Set();
    (products || []).forEach((product) => {
        const linkedId = product?.moysklad_product_id;
        if (linkedId) {
            usedMsIds.add(String(linkedId));
        }
    });
    const problems = {
        duplicateDbSku: countDuplicates(dbBySku),
        duplicateDbExternalId: countDuplicates(dbByExternalId),
        duplicateDbName: countDuplicates(dbByName),
        duplicateMsCode: countDuplicates(msByCode),
        duplicateMsArticle: countDuplicates(msByArticle),
        duplicateMsExternalCode: countDuplicates(msByExternalCode),
        duplicateMsName: countDuplicates(msByName),
        alreadyLinkedDifferent: [],
        noMatch: [],
        msAlreadyUsed: []
    };

    (products || []).forEach((product) => {
        const currentMsId = product?.moysklad_product_id || null;
        const skuKey = normalizeKey(product?.sku);
        const externalKey = normalizeKey(product?.external_id);
        const nameKey = normalizeKey(product?.name);

        const candidates = [
            {
                key: skuKey,
                dbIndex: dbBySku,
                msIndex: msByCode,
                msLabel: "code"
            },
            {
                key: skuKey,
                dbIndex: dbBySku,
                msIndex: msByArticle,
                msLabel: "article"
            },
            {
                key: externalKey,
                dbIndex: dbByExternalId,
                msIndex: msByExternalCode,
                msLabel: "externalCode"
            },
            {
                key: nameKey,
                dbIndex: dbByName,
                msIndex: msByName,
                msLabel: "name"
            }
        ];

        let matched = null;
        let hadPotentialMatch = false;

        for (const candidate of candidates) {
            if (!candidate.key) {
                continue;
            }

            const dbList = candidate.dbIndex.get(candidate.key) || [];
            if (dbList.length > 1) {
                hadPotentialMatch = true;
                continue;
            }

            const msList = candidate.msIndex.get(candidate.key) || [];
            if (!msList.length) {
                continue;
            }

            hadPotentialMatch = true;
            if (msList.length > 1) {
                continue;
            }

            const msProduct = msList[0];
            if (!msProduct?.id) {
                continue;
            }

            if (usedMsIds.has(msProduct.id) && String(currentMsId || "") !== String(msProduct.id)) {
                hadPotentialMatch = true;
                problems.msAlreadyUsed.push({
                    productLabel: formatProductLabel(product),
                    msLabel: formatMsSummary(msProduct)
                });
                continue;
            }

            matched = msProduct;
            break;
        }

        if (!matched) {
            if (currentMsId) {
                return;
            }
            if (!hadPotentialMatch) {
                problems.noMatch.push({
                    productLabel: formatProductLabel(product),
                    sku: product?.sku ? String(product.sku) : "",
                    externalId: product?.external_id ? String(product.external_id) : "",
                    name: product?.name ? String(product.name) : ""
                });
            }
            return;
        }

        if (currentMsId) {
            if (String(currentMsId) !== String(matched.id)) {
                problems.alreadyLinkedDifferent.push({
                    productLabel: formatProductLabel(product),
                    msLabel: formatMsSummary(matched)
                });
            }
            return;
        }

        usedMsIds.add(matched.id);
        updates.push({
            productId: product.id,
            productLabel: formatProductLabel(product),
            moyskladProductId: matched.id,
            moyskladProductLabel: formatMsLabel(matched)
        });
    });

    return { updates, problems };
}

function buildPreviewLines({ updates, problems, stats }) {
    const lines = [];
    const totalDb = stats?.totalDb ?? 0;
    const totalMs = stats?.totalMs ?? 0;
    const linked = stats?.linked ?? 0;
    const updatesCount = updates.length;
    const noMatch = problems?.noMatch?.length ?? 0;
    const conflicts = (problems?.alreadyLinkedDifferent?.length ?? 0) + (problems?.msAlreadyUsed?.length ?? 0);
    const duplicateCounts = [
        problems?.duplicateDbSku,
        problems?.duplicateDbExternalId,
        problems?.duplicateDbName,
        problems?.duplicateMsCode,
        problems?.duplicateMsArticle,
        problems?.duplicateMsExternalCode,
        problems?.duplicateMsName
    ].reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
    const coveredAfter = Math.min(totalDb, linked + updatesCount);
    const remainingAfter = Math.max(0, totalDb - coveredAfter);

    lines.push("Итоги связки товаров:");
    lines.push(`- В Supabase: ${totalDb}`);
    lines.push(`- В МойСклад: ${totalMs}`);
    lines.push(`- Уже связаны: ${linked}`);
    lines.push(`- Найдено совпадений (к обновлению): ${updatesCount}`);
    lines.push(`- Без пары в МС: ${noMatch}`);
    if (conflicts) {
        lines.push(`- Конфликты/занятые UUID: ${conflicts}`);
    }
    if (duplicateCounts) {
        lines.push(`- Дубли (SKU/имя/коды): ${duplicateCounts}`);
    }
    lines.push(`- После применения: ${coveredAfter}/${totalDb} с UUID МС`);
    lines.push(`- Без UUID после применения: ${remainingAfter}`);
    lines.push(`- Все товары закрыты: ${remainingAfter === 0 ? "да" : "нет"}`);

    return lines;
}

async function buildDiagnosticsLines({ token, missingItems, limit = 5 }) {
    const samples = (missingItems || [])
        .map((item) => ({
            label: item?.productLabel || "—",
            code: normalizeRaw(item?.sku)
        }))
        .filter((item) => item.code)
        .slice(0, limit);

    if (!samples.length) {
        return [];
    }

    let found = 0;
    const lines = [
        `Диагностика МойСклад (по коду, выборка ${samples.length}):`
    ];

    for (const sample of samples) {
        try {
            const msProduct = await findProductByCode({ token, code: sample.code });
            if (msProduct?.id) {
                found += 1;
                lines.push(`- ${sample.code}: найден (${msProduct.id})`);
            } else {
                lines.push(`- ${sample.code}: не найден`);
            }
        } catch (error) {
            const message = String(error?.message || error).slice(0, 160);
            lines.push(`- ${sample.code}: ошибка ${message}`);
        }
    }

    lines.splice(1, 0, `- Найдено: ${found}/${samples.length}`);
    return lines;
}

async function safeEditMessageText(ctx, text) {
    try {
        await ctx.editMessageText(text);
    } catch (error) {
        // ignore
    }
}

async function applyUpdates({ updates, onProgress }) {
    const supabase = getSupabaseAdminClient();
    let applied = 0;
    let skipped = 0;
    const errors = [];

    const BATCH_SIZE = 50;
    const batches = [];
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
        batches.push(updates.slice(i, i + BATCH_SIZE));
    }

    let processed = 0;
    for (const batch of batches) {
        const results = await Promise.all(
            batch.map(async (update) => {
                try {
                    const { data, error } = await supabase
                        .from("products")
                        .update({ moysklad_product_id: update.moyskladProductId })
                        .eq("id", update.productId)
                        .is("moysklad_product_id", null)
                        .select("id");

                    if (error) {
                        return { status: "error", productLabel: update.productLabel, message: error.message };
                    }

                    if (!data || !data.length) {
                        return { status: "skipped" };
                    }

                    return { status: "applied" };
                } catch (err) {
                    return { status: "error", productLabel: update.productLabel, message: String(err?.message || err) };
                }
            })
        );

        for (const result of results) {
            if (result.status === "applied") {
                applied += 1;
            } else if (result.status === "skipped") {
                skipped += 1;
            } else if (result.status === "error") {
                errors.push({ productLabel: result.productLabel, message: result.message });
            }
        }

        processed += batch.length;
        if (onProgress) {
            onProgress({ processed, total: updates.length });
        }
    }

    return { applied, skipped, errors };
}

function registerMoyskladProductLinking(bot, config) {
    bot.command("ms_link_products", async (ctx) => {
        if (!(await isAdminUser(ctx.from?.id, config))) {
            await ctx.reply("⛔️ Команда доступна только администратору.");
            return;
        }

        purgeExpiredPending();

        await ctx.reply("⏳ Загружаю товары из МойСклад и из Supabase…");

        const token = getMoyskladToken();
        if (!token) {
            await ctx.reply("❌ Не задан MOYSKLAD_TOKEN в .env");
            return;
        }

        let msProducts = [];
        try {
            const raw = await fetchAllProducts({ token });
            msProducts = normalizeMsProducts(raw);
        } catch (error) {
            console.error("[BOT] МойСклад загрузка товаров failed:", error);
            await ctx.reply(`❌ Ошибка МойСклад: ${String(error?.message || error)}`.slice(0, 3500));
            return;
        }

        const supabase = getSupabaseAdminClient();
        let products = [];
        try {
            products = await fetchAllSupabaseProducts({
                supabase,
                fields: "id, external_id, sku, name, moysklad_product_id"
            });
        } catch (error) {
            console.error("[BOT] Supabase products select failed:", error);
            const message = String(error?.message || error || "unknown_error");

            if (message.includes("moysklad_product_id")) {
                await ctx.reply(
                    [
                        "❌ В Supabase пока нет нужной колонки в `products`.",
                        "Выполни SQL миграцию и повтори команду:",
                        "scripts/supabase/migrations/2026-01-30_products_moysklad.sql"
                    ].join("\n")
                );
                return;
            }

            await ctx.reply(`❌ Ошибка Supabase: ${message}`.slice(0, 3500));
            return;
        }

        const linkedCount = (products || []).filter((item) => item?.moysklad_product_id).length;
        const stats = {
            totalDb: products?.length ?? 0,
            totalMs: msProducts?.length ?? 0,
            linked: linkedCount
        };

        const { updates, problems } = buildPlan({ products, msProducts });
        const previewLines = buildPreviewLines({ updates, problems, stats });
        const chunks = chunkLines(previewLines);

        for (const chunk of chunks) {
            await ctx.reply(chunk.join("\n"));
        }

        if (problems?.noMatch?.length) {
            const diagnosticsLines = await buildDiagnosticsLines({
                token,
                missingItems: problems.noMatch,
                limit: 5
            });

            if (diagnosticsLines.length) {
                const diagnosticsChunks = chunkLines(diagnosticsLines);
                for (const chunk of diagnosticsChunks) {
                    await ctx.reply(chunk.join("\n"));
                }
            }
        }

        if (!updates.length) {
            return;
        }

        const nonce = buildNonce();
        pendingByNonce.set(nonce, {
            nonce,
            adminId: Number(ctx.from?.id),
            createdAt: Date.now(),
            updates,
            problems,
            stats
        });

        const keyboard = Markup.inlineKeyboard([
            Markup.button.callback("✅ Подтвердить", `ms_link_products:confirm:${nonce}`),
            Markup.button.callback("❌ Отмена", `ms_link_products:cancel:${nonce}`)
        ]);

        await ctx.reply(`Подтвердить применение ${updates.length} изменений?`, keyboard);
    });

    bot.action(/^ms_link_products:(confirm|cancel):([A-Za-z0-9_-]+)$/, async (ctx) => {
        const action = ctx.match?.[1];
        const nonce = ctx.match?.[2];

        try {
            await ctx.answerCbQuery();
        } catch (error) {
            // ignore
        }

        if (!(await isAdminUser(ctx.from?.id, config))) {
            await safeEditMessageText(ctx, "⛔️ Команда доступна только администратору.");
            return;
        }

        purgeExpiredPending();
        const pending = pendingByNonce.get(nonce);

        if (!pending) {
            await safeEditMessageText(ctx, "⚠️ План не найден или устарел. Запусти /ms_link_products заново.");
            return;
        }

        if (Number(ctx.from?.id) !== Number(pending.adminId)) {
            await safeEditMessageText(ctx, "⛔️ Этот запрос подтверждения создан другим админом.");
            return;
        }

        if (action === "cancel") {
            pendingByNonce.delete(nonce);
            await safeEditMessageText(ctx, "❌ Отменено.");
            return;
        }

        const progressMsg = await ctx.reply("⏳ Применяю изменения в Supabase… 0%");
        const progressMsgId = progressMsg?.message_id;

        let lastProgressPercent = 0;
        const onProgress = async ({ processed, total }) => {
            const percent = Math.floor((processed / total) * 100);
            if (percent >= lastProgressPercent + 10 || percent === 100) {
                lastProgressPercent = percent;
                try {
                    await ctx.telegram.editMessageText(
                        ctx.chat.id,
                        progressMsgId,
                        null,
                        `⏳ Применяю изменения в Supabase… ${percent}% (${processed}/${total})`
                    );
                } catch (e) {
                    // ignore edit errors
                }
            }
        };

        await safeEditMessageText(ctx, "✅ Запущено обновление…");

        let result;
        try {
            result = await applyUpdates({ updates: pending.updates, onProgress });
        } catch (error) {
            console.error("[BOT] Supabase applyUpdates failed:", error);
            pendingByNonce.delete(nonce);
            try {
                await ctx.telegram.editMessageText(
                    ctx.chat.id,
                    progressMsgId,
                    null,
                    `❌ Ошибка при обновлении Supabase: ${String(error?.message || error)}`.slice(0, 3500)
                );
            } catch (e) {
                await ctx.reply(`❌ Ошибка при обновлении Supabase: ${String(error?.message || error)}`.slice(0, 3500));
            }
            return;
        }

        try {
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                progressMsgId,
                null,
                "✅ Обновление завершено!"
            );
        } catch (e) {
            // ignore
        }

        pendingByNonce.delete(nonce);

        const stats = pending.stats || { totalDb: 0, totalMs: 0, linked: 0 };
        let remainingMissing = null;
        let totalDb = stats.totalDb;
        try {
            const supabase = getSupabaseAdminClient();
            const { count: totalCount } = await supabase
                .from("products")
                .select("id", { count: "exact", head: true });
            if (Number.isFinite(totalCount)) {
                totalDb = totalCount;
            }
            const { count: missingCount } = await supabase
                .from("products")
                .select("id", { count: "exact", head: true })
                .is("moysklad_product_id", null);
            if (Number.isFinite(missingCount)) {
                remainingMissing = missingCount;
            }
        } catch (error) {
            // ignore
        }

        const plannedCovered = Math.min(totalDb, stats.linked + pending.updates.length);
        const remainingPlanned = Math.max(0, totalDb - plannedCovered);

        const lines = ["✅ Готово."];
        lines.push(`Применено: ${result.applied}`);
        lines.push(`Пропущено (уже заполнено/не найдено): ${result.skipped}`);
        lines.push(`В Supabase: ${totalDb}`);
        lines.push(`В МойСклад: ${stats.totalMs}`);
        lines.push(`Уже связаны: ${stats.linked}`);
        lines.push(`Найдено совпадений (к обновлению): ${pending.updates.length}`);
        lines.push(`Без пары в МС: ${pending.problems?.noMatch?.length ?? 0}`);
        const missingFinal = remainingMissing === null ? remainingPlanned : remainingMissing;
        lines.push(`Без UUID после применения: ${missingFinal}`);
        lines.push(`Все товары закрыты: ${missingFinal === 0 ? "да" : "нет"}`);

        if (result.errors?.length) {
            lines.push(`Ошибки: ${result.errors.length}`);
        }

        await ctx.reply(lines.join("\n"));
    });
}

module.exports = { registerMoyskladProductLinking };
