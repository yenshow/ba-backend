/**
 * NVR ISAPI 探測：通道狀態（InputProxy）＋錄影搜尋（CMSearch）＋即時 RTSP URL 組裝
 *
 * 用法：
 *   node scripts/probe/probeNvrIsapi.js
 *   npm run probe:nvr
 *
 * 環境變數覆寫 SCRIPT_CONFIG（與 probe:isapi 相同前綴）：
 *   ISAPI_HOST / ISAPI_PORT / ISAPI_USERNAME / ISAPI_PASSWORD
 *   NVR_RTSP_PORT / NVR_TRACK_ID / NVR_SEARCH_HOURS_AGO / NVR_SEARCH_HOURS_END
 *   NVR_MAX_RESULTS / NVR_PROBE_RTSP=1
 */

/* eslint-disable no-console */

const net = require("net");
const {
  createIsapiClient,
} = require("../../src/services/accessControl/isapiClient");
const {
  pickTag,
  responseBodyToString,
} = require("../../src/services/isapi/isapiEventBackfillCommon");
const nvrIsapiService = require("../../src/services/devices/nvrIsapiService");

// ── 現場參數 ─────────────────────────────────────────────────────
const SCRIPT_CONFIG = {
  host: "192.168.2.9",
  port: 80,
  username: "admin",
  password: "Aa83124007",
  rtspPort: 554,
  trackId: null,
  searchHoursAgo: 24,
  searchHoursEnd: 0,
  maxResults: 40,
  probeRtsp: false,
};
// ─────────────────────────────────────────────────────────────────

const ensureInt = (v) => {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

const envText = (name) => {
  const raw = process.env[name];
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  return trimmed === "" ? null : trimmed;
};

const applyEnvOverrides = (defaults) => {
  const next = { ...defaults };
  const host = envText("ISAPI_HOST");
  const username = envText("ISAPI_USERNAME");
  const password = envText("ISAPI_PASSWORD");
  const port = ensureInt(process.env.ISAPI_PORT);
  const rtspPort = ensureInt(process.env.NVR_RTSP_PORT);
  const trackId = ensureInt(process.env.NVR_TRACK_ID);
  const hoursAgo = ensureInt(process.env.NVR_SEARCH_HOURS_AGO);
  const hoursEnd = ensureInt(process.env.NVR_SEARCH_HOURS_END);
  const maxResults = ensureInt(process.env.NVR_MAX_RESULTS);

  if (host) next.host = host;
  if (port != null) next.port = port;
  if (username) next.username = username;
  if (password) next.password = password;
  if (rtspPort != null) next.rtspPort = rtspPort;
  if (trackId != null) next.trackId = trackId;
  if (hoursAgo != null) next.searchHoursAgo = hoursAgo;
  if (hoursEnd != null) next.searchHoursEnd = hoursEnd;
  if (maxResults != null) next.maxResults = maxResults;
  if (envText("NVR_PROBE_RTSP") === "1") next.probeRtsp = true;
  return next;
};

const CONFIG = applyEnvOverrides(SCRIPT_CONFIG);

const tcpProbe = (host, port, timeoutMs = 5000) =>
  new Promise((resolve) => {
    const socket = net.connect({ host, port }, () => {
      socket.end();
      resolve({ ok: true, error: null });
    });
    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => {
      socket.destroy();
      resolve({ ok: false, error: "timeout" });
    });
    socket.on("error", (err) => {
      resolve({ ok: false, error: err.message || String(err) });
    });
  });

const resolveSearchRange = () => {
  const now = Date.now();
  const agoMs = Math.max(0, Number(CONFIG.searchHoursAgo) || 0) * 3600_000;
  const endMs = Math.max(0, Number(CONFIG.searchHoursEnd) || 0) * 3600_000;
  const start = new Date(now - agoMs);
  const end = new Date(now - endMs);
  if (end.getTime() <= start.getTime()) {
    return {
      start: new Date(now - 3600_000),
      end: new Date(now),
      note: "時間窗無效，已改為最近 1 小時",
    };
  }
  return { start, end, note: null };
};

const pickDefaultTrackId = (channels) => {
  const online = channels.find(
    (c) => c.online && c.streamingProxyChannelIds.length > 0,
  );
  if (online) return online.liveTrackId ?? online.streamingProxyChannelIds[0];
  const any = channels.find((c) => c.streamingProxyChannelIds.length > 0);
  return any ? any.liveTrackId ?? any.streamingProxyChannelIds[0] : null;
};

async function main() {
  const {
    host,
    port,
    username,
    password,
    rtspPort,
    trackId: cfgTrackId,
    maxResults,
    probeRtsp,
  } = CONFIG;

  console.log("=== NVR ISAPI Probe ===");
  console.log(
    JSON.stringify(
      {
        host,
        port,
        username,
        password: password ? "***" : "",
        rtspPort,
        trackId: cfgTrackId,
        searchHoursAgo: CONFIG.searchHoursAgo,
        searchHoursEnd: CONFIG.searchHoursEnd,
        maxResults,
        probeRtsp,
      },
      null,
      2,
    ),
  );

  if (!host || !username) {
    console.error("缺少 host / username，請改 SCRIPT_CONFIG 或設環境變數。");
    process.exit(1);
  }

  const nvrConfig = {
    is_nvr: true,
    host,
    port,
    username,
    password,
    rtsp_port: rtspPort,
  };

  console.log("\n--- GET /ISAPI/System/deviceInfo ---");
  try {
    const client = createIsapiClient(
      { host, port, username, password },
      { typeCode: "camera" },
    );
    const infoRes = await client.request({
      method: "GET",
      path: "/ISAPI/System/deviceInfo",
    });
    const infoXml = responseBodyToString(infoRes.data);
    console.log(
      JSON.stringify(
        {
          httpStatus: infoRes.status,
          deviceName: pickTag(infoXml, "deviceName"),
          model: pickTag(infoXml, "model"),
          serialNumber: pickTag(infoXml, "serialNumber"),
          firmwareVersion: pickTag(infoXml, "firmwareVersion"),
        },
        null,
        2,
      ),
    );
  } catch (err) {
    console.error("deviceInfo 失敗:", err.message || err);
    process.exit(1);
  }

  console.log("\n--- GET /ISAPI/ContentMgmt/InputProxy/channels/status ---");
  let channels = [];
  try {
    const listed = await nvrIsapiService.listChannels(nvrConfig);
    channels = listed.channels || [];
    console.log(`channels=${channels.length}`);
    for (const ch of channels) {
      const liveIds = ch.streamingProxyChannelIds || [];
      const liveUrls = liveIds
        .map((id) =>
          nvrIsapiService.buildLiveRtspUrl({
            host,
            rtspPort,
            username,
            password,
            channelId: id,
          }),
        )
        .filter(Boolean);
      console.log(
        JSON.stringify(
          {
            id: ch.id,
            name: ch.name || undefined,
            ipAddress: ch.ipAddress,
            online: ch.online,
            chanDetectResult: ch.chanDetectResult || undefined,
            streamingProxyChannelIds: liveIds,
            liveTrackId: ch.liveTrackId,
            liveRtsp: liveUrls.map(nvrIsapiService.maskRtspUrl),
          },
          null,
          2,
        ),
      );
    }
  } catch (err) {
    console.error("channels/status 失敗:", err.message || err);
    process.exit(1);
  }

  const trackId = cfgTrackId ?? pickDefaultTrackId(channels);
  if (trackId == null) {
    console.error(
      "\n無法決定 trackID：請設 NVR_TRACK_ID 或確認通道有 streamingProxyChannelId。",
    );
    process.exit(1);
  }

  const range = resolveSearchRange();
  console.log("\n--- POST /ISAPI/ContentMgmt/search ---");
  console.log(
    JSON.stringify(
      {
        trackId,
        start: range.start.toISOString(),
        end: range.end.toISOString(),
        maxResults,
        note: range.note,
      },
      null,
      2,
    ),
  );

  try {
    const searched = await nvrIsapiService.searchRecordings(nvrConfig, {
      trackId,
      start: range.start,
      end: range.end,
      maxResults,
    });
    console.log(
      JSON.stringify(
        {
          responseStatusStrg: searched.responseStatusStrg,
          numOfMatches: searched.numOfMatches,
          totalMatches: searched.totalMatches,
          matchCount: (searched.matches || []).length,
        },
        null,
        2,
      ),
    );
    for (const m of searched.matches || []) {
      console.log(
        JSON.stringify(
          {
            index: m.index,
            trackId: m.trackId,
            startTime: m.startTime,
            endTime: m.endTime,
            contentType: m.contentType || undefined,
            codecType: m.codecType || undefined,
            playbackURI: nvrIsapiService.maskRtspUrl(m.playbackURI),
            playbackURI_raw_has_auth: /@/.test(m.playbackURI || ""),
          },
          null,
          2,
        ),
      );
    }
    if ((searched.matches || []).length === 0) {
      console.log("(無 searchMatchItem)");
    } else {
      console.log(
        "\n提示：平台播放時可把 playbackURI 交給 MediaMTX 臨時 path；帳密以設備設定覆寫即可。",
      );
    }
  } catch (err) {
    console.error("CMSearch 失敗:", err.message || err);
    process.exit(1);
  }

  if (probeRtsp) {
    console.log(`\n--- RTSP TCP probe ${host}:${rtspPort} ---`);
    const portProbe = await tcpProbe(host, rtspPort);
    console.log(JSON.stringify({ host, rtspPort, ...portProbe }, null, 2));
  }

  console.log("\n=== done ===");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
