/**
 * ISAPI 訂閱測試腳本：PeopleCounting
 *
 * 直接打：
 *   POST http://192.168.2.124/ISAPI/Event/notification/subscribeEvent
 * 並把回應 multipart 串流中遇到的 JSON part「原始資料」逐筆印出。
 */

const {
  createIsapiClient,
} = require("../src/services/accessControl/isapiClient");

const SUBSCRIBE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<SubscribeEvent version="2.0" xmlns="http://www.std-cgi.com/ver20/XMLSchema">
    <heartbeat>10</heartbeat>
    <channelMode>list</channelMode>
    <eventMode>list</eventMode>
    <EventList>
        <Event>
            <type>PeopleCounting</type>
            <channels>1</channels>
        </Event>
    </EventList>
</SubscribeEvent>`;

const DEFAULTS = {
  host: "192.168.2.124",
  port: null,
  username: "admin",
  password: "Aa83124007",
  maxJsonParts: 5,
  timeoutMs: 20000,
};

function getArgValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function parseIntSafe(v) {
  if (v == null) return undefined;
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : undefined;
}

function parseOptionsFromArgs() {
  const helpRequested =
    process.argv.includes("--help") || process.argv.includes("-h");
  if (helpRequested) {
    console.log(
      [
        "用法：node scripts/testIsapiSubscribePeopleCounting.js [options]",
        "",
        "選項：",
        "  --host <ip>           預設 192.168.2.124",
        "  --port <number>      預設(留空則走 80)",
        "  --username <name>    預設 admin",
        "  --password <pass>    預設 Aa83124007",
        "  --maxJsonParts <n>   預設 5",
        "  --timeoutMs <ms>     預設 20000",
        "",
        "備註：此腳本會印出回應中的 JSON part 原始內容，請勿在公共環境使用。",
      ].join("\n"),
    );
    process.exit(0);
  }

  const host = getArgValue("--host") ?? DEFAULTS.host;
  const portArg = getArgValue("--port");
  const port = portArg == null || portArg === "" ? null : Number(portArg);

  const username = getArgValue("--username") ?? DEFAULTS.username;
  const password = getArgValue("--password") ?? DEFAULTS.password;

  const maxJsonParts =
    parseIntSafe(getArgValue("--maxJsonParts")) ?? DEFAULTS.maxJsonParts;
  const timeoutMs =
    parseIntSafe(getArgValue("--timeoutMs")) ?? DEFAULTS.timeoutMs;

  return { host, port, username, password, maxJsonParts, timeoutMs };
}

function extractBoundary(contentType) {
  if (!contentType) return null;
  const m = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/i);
  if (!m) return null;
  return (m[1] || m[2] || "").trim() || null;
}

function getHeaderValue(headerStr, headerName) {
  const m = headerStr.match(new RegExp(`${headerName}:\\s*([^\\r\\n]+)`, "i"));
  return (m && m[1] ? String(m[1]) : "").trim();
}

function looksLikeJsonBody(bodyText) {
  if (!bodyText) return false;
  const t = bodyText.trimStart();
  return t.startsWith("{") || t.startsWith("[");
}

function looksLikeXmlBody(bodyText) {
  if (!bodyText) return false;
  const t = bodyText.trimStart();
  return t.startsWith("<?xml") || t.startsWith("<");
}

async function main() {
  const { host, port, username, password, maxJsonParts, timeoutMs } =
    parseOptionsFromArgs();

  const client = createIsapiClient({
    host,
    port: port == null ? undefined : port,
    username,
    password,
  });

  console.log("=== ISAPI Subscribe Test (PeopleCounting) ===");
  console.log(
    "Target:",
    `${host}${port ? `:${port}` : ""}/ISAPI/Event/notification/subscribeEvent`,
  );
  console.log("Max JSON parts:", maxJsonParts);
  console.log("Timeout(ms):", timeoutMs);
  console.log("---- SUBSCRIBE_XML ----");
  console.log(SUBSCRIBE_XML);
  console.log("---- POSTING ----");

  const res = await client.requestSubscribeStream(SUBSCRIBE_XML);
  console.log("HTTP Status:", res.status);
  console.log("Response Headers:");
  for (const [k, v] of Object.entries(res.headers || {})) {
    if (typeof v === "string") console.log(`  ${k}: ${v}`);
  }

  const contentType =
    res.headers["content-type"] || res.headers["Content-Type"] || "";
  const boundary = extractBoundary(contentType);

  if (!boundary) {
    throw new Error(`無法從 content-type 解析 boundary：${contentType}`);
  }

  const stream = res.data;

  const CRLFCRLF = Buffer.from("\r\n\r\n");
  const sep = Buffer.from(`--${boundary}`, "utf8");
  const sepWithCRLF = Buffer.from(`\r\n--${boundary}`, "utf8");

  let buffer = Buffer.alloc(0);
  let partIndex = 0;
  let jsonParts = 0;

  let timeoutId;
  const stopPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      console.log(`\n[Timeout] ${timeoutMs}ms 到，停止接收並結束。`);
      try {
        stream.destroy();
      } catch {
        // ignore
      }
      resolve("timeout");
    }, timeoutMs);
  });

  const consumeOnePart = () => {
    // 找 part 起點：\r\n--boundary 或 開頭 --boundary
    let start = buffer.indexOf(sepWithCRLF);
    let skip = sepWithCRLF.length;
    if (start === -1) {
      if (
        buffer.length >= sep.length &&
        buffer.slice(0, sep.length).equals(sep)
      ) {
        start = 0;
        skip = sep.length;
      } else {
        return false;
      }
    } else if (start > 0) {
      buffer = buffer.slice(start);
      start = 0;
      skip = sepWithCRLF.length;
    }

    const afterBoundary = buffer.slice(skip);
    const headEnd = afterBoundary.indexOf(CRLFCRLF);
    if (headEnd === -1) return false;

    const headerStr = afterBoundary.slice(0, headEnd).toString("utf8");
    const bodyStart = skip + headEnd + CRLFCRLF.length;

    const contentLengthRaw = getHeaderValue(headerStr, "Content-Length");
    const contentLength =
      contentLengthRaw && /^\d+$/.test(contentLengthRaw)
        ? Number.parseInt(contentLengthRaw, 10)
        : null;

    let bodyEnd;
    if (contentLength != null) {
      bodyEnd = bodyStart + contentLength;
      if (bodyEnd > buffer.length) return false;
    } else {
      const next1 = buffer.indexOf(sepWithCRLF, bodyStart);
      const next2 = buffer.indexOf(sep, bodyStart);
      if (next1 === -1 && next2 === -1) return false;
      if (next1 === -1) bodyEnd = next2;
      else if (next2 === -1) bodyEnd = next1;
      else bodyEnd = Math.min(next1, next2);

      if (bodyEnd < bodyStart) return false;
      // 若 body 結尾有 \r\n，先裁掉（依設備實際輸出而定）
      if (buffer[bodyEnd - 1] === 0x0a && buffer[bodyEnd - 2] === 0x0d)
        bodyEnd -= 2;
    }

    const body = buffer.slice(bodyStart, bodyEnd);
    buffer = buffer.slice(bodyEnd);

    partIndex += 1;
    const partContentType = getHeaderValue(headerStr, "Content-Type");

    console.log(`\n=== PART ${partIndex} ===`);
    if (headerStr.trim()) console.log(headerStr.trimEnd());
    else console.log("(no part header)");

    const isJsonLikeHeader = /application\/json/i.test(partContentType);
    const bodyText = body.toString("utf8").replace(/^\uFEFF/, "");
    const isJsonLikeBody = looksLikeJsonBody(bodyText);
    const shouldPrintJson = isJsonLikeHeader || isJsonLikeBody;

    if (shouldPrintJson) {
      jsonParts += 1;
      console.log("--- JSON (原始內容) ---");
      // 直接印出原始 JSON 文字（不做格式化；僅移除前置 BOM，避免和設備資料差異）
      console.log(bodyText);
      console.log("--- END JSON ---");

      if (jsonParts >= maxJsonParts) return "done";
    } else {
      const isXmlLikeHeader = /application\/xml/i.test(partContentType) || /text\/xml/i.test(partContentType);
      const isXmlLikeBody = looksLikeXmlBody(bodyText);
      const shouldPrintText = isXmlLikeHeader || isXmlLikeBody;

      if (shouldPrintText) {
        console.log("--- TEXT/XML (原始內容) ---");
        console.log(bodyText);
        console.log("--- END TEXT/XML ---");
      } else {
        // 非 JSON / 非文字類：不印出二進位內容，只印資訊避免洪水
        console.log("--- Non-JSON Part ---");
        console.log(`Content-Type: ${partContentType || "unknown"}`);
        console.log(`Body Bytes: ${body.length}`);
      }
    }

    return true;
  };

  const recvPromise = new Promise((resolve) => {
    const done = (reason) => resolve(reason);

    stream.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      // 一次處理多個 part（如果 buffer 已經累積到足夠量）
      // 若回傳 "done" 則停止
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const r = consumeOnePart();
        if (r === false) break;
        if (r === "done") {
          done("maxJsonParts");
          return;
        }
      }
      // 防止極端情況 buffer 無上限
      const maxBuf = 2 * 1024 * 1024;
      if (buffer.length > maxBuf) buffer = buffer.slice(-maxBuf);
    });

    stream.on("end", () => {
      done("end");
    });
    stream.on("close", () => {
      done("close");
    });
    stream.on("error", (err) => {
      console.error("Stream error:", err && err.message ? err.message : err);
      done("error");
    });
  });

  const result = await Promise.race([recvPromise, stopPromise]);
  clearTimeout(timeoutId);

  console.log("\n=== Finished ===");
  console.log("Result:", result);
}

main().catch((err) => {
  console.error("Error:", err && err.message ? err.message : err);
  process.exit(1);
});
