/**
 * 視訊對講設備 SDK 事件接收（層 1）
 *
 * 布防（預設，SetupAlarmChan_V50）：
 *   node scripts/listenVideoIntercomMainStation.js --host 192.168.2.27
 *
 * 監聽（StartListen_V30；設備須把警報中心指到本機）：
 *   node scripts/listenVideoIntercomMainStation.js --mode listen --listen-port 7200
 *
 * 通話事件請聽管理中心主機（勿聽室內機）。一次只開本腳本。
 * 層 2 外撥：testVideoIntercomSipInvite.js
 * 詳見：docs/40-systems/access-security.md；探測附錄 video-intercom-main-station.md
 */

/* eslint-disable no-console */

const {
  spawnArmingProcess,
} = require("../src/services/ladderSdk/sdkBridgeClient");

// ── 現場參數（管理中心主機）─────────────────────────────────────
const SCRIPT_CONFIG = {
  host: "192.168.2.27",
  port: 8000,
  username: "admin",
  password: "Aa83124007",
  /** arming = SetupAlarmChan_V50；listen = StartListen_V30 */
  mode: "arming",
  listenIp: "",
  listenPort: 7200,
  /** 輸出未知 raw 事件 */
  showRaw: true,
};
// ─────────────────────────────────────────────────────────────────

const parseCliArgs = () => {
  const args = process.argv.slice(2);
  const result = { ...SCRIPT_CONFIG };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--host" && args[i + 1]) {
      result.host = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--port" && args[i + 1]) {
      result.port = Number(args[i + 1]) || result.port;
      i += 1;
      continue;
    }
    if (arg === "--username" && args[i + 1]) {
      result.username = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--password" && args[i + 1]) {
      result.password = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--mode" && args[i + 1]) {
      result.mode = String(args[i + 1]).toLowerCase();
      i += 1;
      continue;
    }
    if (arg === "--listen-ip" && args[i + 1]) {
      result.listenIp = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--listen-port" && args[i + 1]) {
      result.listenPort = Number(args[i + 1]) || result.listenPort;
      i += 1;
      continue;
    }
    if (arg === "--no-raw") {
      result.showRaw = false;
    }
  }

  return result;
};

const printSection = (title) => {
  console.log(`\n${"=".repeat(72)}`);
  console.log(title);
  console.log("=".repeat(72));
};

const formatEventLine = (message) => {
  const time = message.timestamp || new Date().toISOString();
  const category = message.category || "-";

  if (category === "isapi_alarm") {
    const hint = message.eventHint ? ` hint=${message.eventHint}` : "";
    const summary = message.summary || message.dataType || "-";
    return `[${time}] ISAPI | ${summary}${hint} | len=${message.dataLen ?? "-"} | ip=${message.sourceIp || "-"}`;
  }

  const name = message.eventName || message.command || "-";
  const device =
    message.deviceNumber ||
    message.sourceIp ||
    message.serial ||
    "-";
  const extra = [];

  if (message.detail) extra.push(message.detail);
  if (message.cardNo) extra.push(`card=${message.cardNo}`);
  if (message.doorNo != null) extra.push(`door=${message.doorNo}`);
  if (message.deviceTime) extra.push(`devTime=${message.deviceTime}`);

  const suffix = extra.length ? ` | ${extra.join(", ")}` : "";
  return `[${time}] ${category} | ${name} | device=${device}${suffix}`;
};

const run = () => {
  const config = parseCliArgs();
  const isListen = config.mode === "listen";

  if (!isListen && !config.password) {
    console.error(
      "請在 SCRIPT_CONFIG.password 填入密碼，或使用 --password 參數",
    );
    process.exit(1);
  }

  printSection(
    isListen
      ? "視訊對講設備 — SDK 監聽模式（StartListen_V30）"
      : "視訊對講設備 — SDK 佈防監聽（SetupAlarmChan_V50）",
  );
  if (isListen) {
    console.log(
      `本機：${config.listenIp || "(any)"}:${config.listenPort}`,
    );
    console.log("流程：Init → StartListen_V30 → MSGCallBack");
    console.log("請確認設備警報主機／中心已指向本機 IP:Port");
  } else {
    console.log(`目標：${config.host}:${config.port}`);
    console.log("流程：Init → Login → Callback → SetupAlarmChan_V50");
  }
  console.log("過濾：無（所有 command 皆輸出；未知則 raw）");
  console.log("重要：測試期間請保持此視窗開啟，勿提前 Ctrl+C");
  console.log("結束：Ctrl+C\n");

  let eventCount = 0;
  let rawCount = 0;
  let ready = false;

  const heartbeat = setInterval(() => {
    if (!ready) return;
    console.log(
      `[heartbeat] 監聽中 ${isListen ? `:${config.listenPort}` : config.host} | events=${eventCount} raw=${rawCount} | ${new Date().toISOString()}`,
    );
  }, 15000);

  const child = spawnArmingProcess(
    {
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
    },
    {
      onReady: (message) => {
        ready = true;
        console.log(isListen ? "監聽就緒（不過濾事件）" : "佈防就緒（不過濾事件）");
        console.log(
          JSON.stringify(
            {
              host: message.host,
              port: message.port,
              alarmHandle: message.alarmHandle,
              listenHandle: message.listenHandle,
              localIp: message.localIp,
              listenPort: message.listenPort,
              filter: message.filter || "none",
              listen: message.listen,
              mode: message.mode,
            },
            null,
            2,
          ),
        );
        console.log("\n等待事件（每 15 秒 heartbeat）...\n");
      },
      onEvent: (message) => {
        eventCount += 1;
        console.log(formatEventLine(message));
        console.log(JSON.stringify(message, null, 2));
        console.log("");
      },
      onRaw: (message) => {
        if (!config.showRaw) return;
        rawCount += 1;
        console.log(
          `[${message.timestamp}] RAW | ${message.command} | bufLen=${message.bufLen} | ip=${message.sourceIp || "-"}`,
        );
        console.log(JSON.stringify(message, null, 2));
        console.log("");
      },
      onError: (message) => {
        console.error("佈防錯誤：", message.message || message);
        if (message.errorCode != null) {
          console.error(`errorCode=${message.errorCode}`);
        }
        process.exitCode = 1;
      },
      onStopped: () => {
        clearInterval(heartbeat);
        console.log(
          `\n已停止（事件 ${eventCount} 筆，raw ${rawCount} 筆）`,
        );
      },
      onClose: (code) => {
        clearInterval(heartbeat);
        if (code && code !== 0 && process.exitCode !== 1) {
          console.error(`bridge 結束碼：${code}`);
          process.exitCode = 1;
        }
        process.exit(process.exitCode || 0);
      },
    },
    {
      args: [isListen ? "--listen-intercom" : "--arming-intercom"],
      env: isListen
        ? {
            ...(config.listenIp ? { SDK_LISTEN_IP: config.listenIp } : {}),
            SDK_LISTEN_PORT: String(config.listenPort),
          }
        : undefined,
    },
  );

  const handleSignal = () => {
    console.log("\n正在關閉...");
    if (!child.killed) {
      child.kill();
    }
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
};

run();
