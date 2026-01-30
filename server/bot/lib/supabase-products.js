const DEFAULT_PAGE_SIZE = 1000;

async function fetchAllSupabaseProducts({ supabase, fields, pageSize = DEFAULT_PAGE_SIZE } = {}) {
    if (!supabase) {
        throw new Error("Supabase клиент не задан");
    }

    const safePageSize = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : DEFAULT_PAGE_SIZE;
    let from = 0;
    let all = [];

    while (true) {
        const { data, error } = await supabase
            .from("products")
            .select(fields)
            .range(from, from + safePageSize - 1);

        if (error) {
            throw error;
        }

        if (!data || data.length === 0) {
            break;
        }

        all = all.concat(data);

        if (data.length < safePageSize) {
            break;
        }

        from += data.length;
    }

    return all;
}

module.exports = { fetchAllSupabaseProducts };
