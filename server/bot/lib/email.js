function normalizeEmail(value) {
    if (value === undefined || value === null) {
        return null;
    }

    const normalized = String(value).trim().toLowerCase();
    return normalized ? normalized : null;
}

function extractEmails(value) {
    if (!value) {
        return [];
    }

    const raw = String(value);
    const matches = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
    if (!matches) {
        return [];
    }

    const seen = new Set();
    matches.forEach((match) => {
        const email = normalizeEmail(match);
        if (email) {
            seen.add(email);
        }
    });
    return Array.from(seen);
}

module.exports = {
    extractEmails,
    normalizeEmail
};

