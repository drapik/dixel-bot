const { createClient } = require("@supabase/supabase-js");

let cachedClient = null;

function getSupabaseAdminClient() {
    if (cachedClient) {
        return cachedClient;
    }

    const url = String(process.env.SUPABASE_URL || "").trim();
    const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

    if (!url) {
        throw new Error("SUPABASE_URL не задан");
    }

    if (!key) {
        throw new Error("SUPABASE_SERVICE_ROLE_KEY не задан");
    }

    cachedClient = createClient(url, key, { auth: { persistSession: false } });
    return cachedClient;
}

module.exports = {
    getSupabaseAdminClient
};

