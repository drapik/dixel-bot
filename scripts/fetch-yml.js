const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { downloadYml } = require("./import-yml");

(async () => {
    try {
        await downloadYml();
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
})();
