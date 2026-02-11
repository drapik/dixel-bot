const fs = require("fs");
const path = require("path");
const { XMLParser } = require("fast-xml-parser");

function detectXmlEncoding(buffer) {
    if (!buffer || buffer.length === 0) {
        return "utf-8";
    }
    const header = buffer.slice(0, 200).toString("ascii");
    const match = header.match(/encoding=["']([^"']+)["']/i);
    if (!match) {
        return "utf-8";
    }
    const encoding = match[1].trim().toLowerCase();
    if (encoding === "windows-1251" || encoding === "win-1251" || encoding === "cp1251") {
        return "windows-1251";
    }
    return "utf-8";
}

function decodeXmlBuffer(buffer) {
    const encoding = detectXmlEncoding(buffer);
    try {
        return new TextDecoder(encoding).decode(buffer);
    } catch (error) {
        console.warn(`Не удалось декодировать ${encoding}, используем UTF-8`);
        return new TextDecoder("utf-8").decode(buffer);
    }
}

function ensureDirForFile(filePath) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
}

function saveBuffer(buffer, filePath) {
    ensureDirForFile(filePath);
    fs.writeFileSync(filePath, buffer);
}

function createXmlParser() {
    return new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "",
        textNodeName: "text",
        trimValues: true,
        parseTagValue: false,
        parseAttributeValue: false
    });
}

async function fetchBufferWithRetry(url, { withRetry, label = "download" } = {}) {
    if (!withRetry) {
        throw new Error("withRetry is required for fetchBufferWithRetry");
    }

    return withRetry(async () => {
        const response = await fetch(url);
        if (!response.ok) {
            const body = await response.text();
            const error = new Error(`${label}: ${response.status} ${body}`);
            error.status = response.status;
            throw error;
        }
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    }, label);
}

async function loadXmlString({
    url,
    filePath,
    savePath,
    shouldSave,
    withRetry,
    label
}) {
    let buffer = null;

    if (url) {
        console.log(`Скачиваем XML: ${url}`);
        buffer = await fetchBufferWithRetry(url, { withRetry, label: label || "xml download" });
        if (shouldSave && savePath) {
            saveBuffer(buffer, savePath);
            console.log(`XML сохранен в ${savePath}`);
        }
    } else {
        if (!filePath) {
            throw new Error("Не указан ни URL, ни путь к файлу");
        }
        if (!fs.existsSync(filePath)) {
            throw new Error(`XML файл не найден: ${filePath}`);
        }
        buffer = fs.readFileSync(filePath);
    }

    return decodeXmlBuffer(buffer);
}

module.exports = {
    createXmlParser,
    fetchBufferWithRetry,
    loadXmlString,
    decodeXmlBuffer,
    saveBuffer
};

