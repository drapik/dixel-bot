const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { buildConfigFromEnv, downloadSource } = require("./import-yml");

(async () => {
    try {
        const config = buildConfigFromEnv();
        await downloadSource(config, "full");
        await downloadSource(config, "price");
        await downloadSource(config, "stock");
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
})();
