/**
 * 視訊對講設備 SDK 佈防監聽
 *
 * 通話事件請聽管理中心主機 192.168.2.27（勿聽室內機）。
 * 驗證時只開本腳本，勿同時跑診斷腳本或 sdk:build。
 * 用設備本機 UI 發起通話（Web 無撥號鈕）。
 *
 *   node scripts/listenVideoIntercomMainStation.js --host 192.168.2.27
 *
 * 外撥請用：testVideoIntercomSipInvite.js（直打室內 SIP）
 * 詳見：docs/40-systems/video-intercom-main-station.md（層 1 listen）
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
    const summary = message.summary || message.dataType || "-";
    return `[${time}] ISAPI | ${summary} | len=${message.dataLen ?? "-"} | ip=${message.sourceIp || "-"}`;
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

  if (!config.password) {
    console.error(
      "請在 SCRIPT_CONFIG.password 填入密碼，或使用 --password 參數",
    );
    process.exit(1);
  }

  printSection("視訊對講設備 — SDK 佈防監聽");
  console.log(`目標：${config.host}:${config.port}`);
  console.log("流程：Init → Login → Callback → SetupAlarmChan_V50");
  console.log("過濾：無（所有 command 皆輸出；未知則 raw）");
  console.log("重要：測試期間請保持此視窗開啟，勿提前 Ctrl+C");
  console.log("結束：Ctrl+C\n");

  let eventCount = 0;
  let rawCount = 0;
  let ready = false;

  const heartbeat = setInterval(() => {
    if (!ready) return;
    console.log(
      `[heartbeat] 監聽中 ${config.host} | events=${eventCount} raw=${rawCount} | ${new Date().toISOString()}`,
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
        console.log("佈防就緒（不過濾事件）");
        console.log(
          JSON.stringify(
            {
              host: message.host,
              port: message.port,
              alarmHandle: message.alarmHandle,
              filter: message.filter || "none",
              listen: message.listen,
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
          `\n已停止佈防（事件 ${eventCount} 筆，raw ${rawCount} 筆）`,
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
    { args: ["--arming-intercom"] },
  );

  const handleSignal = () => {
    console.log("\n正在關閉佈防...");
    if (!child.killed) {
      child.kill();
    }
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
};

run();
