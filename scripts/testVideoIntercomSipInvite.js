/**
 * 直打室內機 SIP INVITE（不經管理中心主機）
 *
 * 現場結論（2026-07-15）：
 *   - 經主機 .27 INVITE → 主機自己響（錯誤路由）
 *   - 直打 .78:5060 To=VoIP號碼 → 室內 180 Ringing（成功）
 *   - softphone 不必 REGISTER；室內機須已開標準／相容 SIP，並設定 VoIP 號碼
 *
 * 用法：
 *   node scripts/testVideoIntercomSipInvite.js
 *   node scripts/testVideoIntercomSipInvite.js --host 192.168.2.78 --to 1001
 *
 * 詳見：docs/40-systems/video-intercom-main-station.md §10
 */

/* eslint-disable no-console */

const dgram = require("dgram");
const crypto = require("crypto");
const os = require("os");

const SCRIPT_CONFIG = {
  /** 室內機 IP（直打，不要填主機 .27） */
  sipHost: "192.168.2.78",
  sipPort: 5060,
  /** From：任意軟體端識別即可 */
  sipUser: "2001",
  password: "Aa83124007",
  /** To：室內機 VoIP「號碼」 */
  targetUser: "1001",
  displayName: "BA-Softphone",
  holdMs: 20000,
};

const md5 = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex");
const branchId = () => `z9hG4bK${crypto.randomBytes(6).toString("hex")}`;
const tagId = () => crypto.randomBytes(4).toString("hex");
const callIdNew = (host) => `${crypto.randomBytes(8).toString("hex")}@${host}`;

const parseCliArgs = () => {
  const args = process.argv.slice(2);
  const config = { ...SCRIPT_CONFIG };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--host" && next) {
      config.sipHost = next;
      i += 1;
    } else if (arg === "--port" && next) {
      config.sipPort = Number(next) || config.sipPort;
      i += 1;
    } else if ((arg === "--sip-user" || arg === "--user") && next) {
      config.sipUser = next;
      i += 1;
    } else if ((arg === "--password" || arg === "--sip-password") && next) {
      config.password = next;
      i += 1;
    } else if ((arg === "--target" || arg === "--to") && next) {
      config.targetUser = next;
      i += 1;
    } else if ((arg === "--hold" || arg === "--wait") && next) {
      config.holdMs = Number(next) || config.holdMs;
      i += 1;
    }
  }
  return config;
};

const printSection = (title) => {
  console.log(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`);
};

const pickLocalIpv4 = () => {
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const item of list || []) {
      if (item.family === "IPv4" && !item.internal) return item.address;
    }
  }
  return "127.0.0.1";
};

const parseSipMessage = (buf) => {
  const raw = buf.toString("utf8");
  const [head] = raw.split("\r\n\r\n");
  const lines = head.split("\r\n");
  const start = lines[0] || "";
  const headers = {};
  for (let i = 1; i < lines.length; i += 1) {
    const idx = lines[i].indexOf(":");
    if (idx < 0) continue;
    headers[lines[i].slice(0, idx).trim().toLowerCase()] = lines[i]
      .slice(idx + 1)
      .trim();
  }
  const statusCode = start.startsWith("SIP/2.0 ")
    ? Number(start.split(/\s+/)[1]) || null
    : null;
  return { raw, start, headers, statusCode };
};

const parseWwwAuthenticate = (header) => {
  if (!header) return null;
  const out = { scheme: "Digest" };
  const m = header.match(/Digest\s+(.*)/i);
  const body = m ? m[1] : header;
  for (const part of body.split(",")) {
    const kv = part.trim().match(/^(\w+)=(?:"([^"]*)"|([^,\s]*))$/);
    if (!kv) continue;
    out[kv[1].toLowerCase()] = kv[2] != null ? kv[2] : kv[3];
  }
  return out;
};

const buildDigestAuth = ({ username, password, method, uri, auth }) => {
  const realm = auth.realm || "";
  const nonce = auth.nonce || "";
  const qop = (auth.qop || "").split(",")[0].trim();
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  let response;
  let cnonce;
  let nc;
  if (qop === "auth" || qop === "auth-int") {
    cnonce = crypto.randomBytes(8).toString("hex");
    nc = "00000001";
    response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
  } else {
    response = md5(`${ha1}:${nonce}:${ha2}`);
  }
  let header = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}", algorithm=MD5`;
  if (auth.opaque) header += `, opaque="${auth.opaque}"`;
  if (qop) header += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  return header;
};

const classify = (code) => {
  if (code === 200) return "ok";
  if (code === 401 || code === 407) return "need-auth";
  if (code === 403) return "forbidden";
  if (code === 404) return "not-found";
  if (code === 100) return "trying";
  if (code === 180 || code === 183) return "ringing";
  if (code === 486) return "busy";
  return code ? `code-${code}` : "none";
};

class SipProbe {
  constructor(config) {
    this.config = config;
    this.socket = dgram.createSocket("udp4");
    this.localIp = pickLocalIpv4();
    this.localPort = 0;
    this.cseq = 1;
    this.fromTag = tagId();
    this.callId = null;
    this.waiters = [];
  }

  start() {
    return new Promise((resolve, reject) => {
      this.socket.once("error", reject);
      this.socket.on("message", (msg, rinfo) => {
        const parsed = parseSipMessage(msg);
        console.log(
          `\n<< ${rinfo.address}:${rinfo.port}\n${parsed.raw.slice(0, 1200)}\n`,
        );
        const pending = [...this.waiters];
        this.waiters = [];
        for (const w of pending) w.resolve(parsed);
      });
      this.socket.bind(0, () => {
        this.localPort = this.socket.address().port;
        console.log(
          `本機 UDP ${this.localIp}:${this.localPort} → ${this.config.sipHost}:${this.config.sipPort}`,
        );
        resolve();
      });
    });
  }

  close() {
    try {
      this.socket.close();
    } catch {
      /* ignore */
    }
  }

  send(raw) {
    console.log(
      `\n>> ${this.config.sipHost}:${this.config.sipPort}\n${raw.slice(0, 1200)}\n`,
    );
    return new Promise((resolve, reject) => {
      this.socket.send(
        Buffer.from(raw, "utf8"),
        this.config.sipPort,
        this.config.sipHost,
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }

  waitOne(timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== resolve);
        reject(new Error(`等待 SIP 回應逾時（${timeoutMs}ms）`));
      }, timeoutMs);
      this.waiters.push({
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
      });
    });
  }

  buildMessage(method, { requestUri, toUser, authHeader, body }) {
    const host = this.config.sipHost;
    const cseq = this.cseq;
    this.cseq += 1;
    if (!this.callId) this.callId = callIdNew(this.localIp);
    const contact = `sip:${this.config.sipUser}@${this.localIp}:${this.localPort}`;
    const lines = [
      `${method} ${requestUri} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this.localIp}:${this.localPort};rport;branch=${branchId()}`,
      "Max-Forwards: 70",
      `From: "${this.config.displayName}" <sip:${this.config.sipUser}@${host}>;tag=${this.fromTag}`,
      `To: <sip:${toUser}@${host}>`,
      `Call-ID: ${this.callId}`,
      `CSeq: ${cseq} ${method}`,
      `Contact: <${contact}>`,
      "User-Agent: BA-System-SIP-Probe/1.0",
      "Allow: INVITE, ACK, CANCEL, BYE, OPTIONS",
    ];
    if (authHeader) lines.push(`Authorization: ${authHeader}`);
    const payload = body || "";
    if (payload) lines.push("Content-Type: application/sdp");
    lines.push(`Content-Length: ${Buffer.byteLength(payload, "utf8")}`);
    lines.push("");
    lines.push(payload);
    return lines.join("\r\n");
  }

  async invite() {
    printSection("INVITE 室內機");
    this.callId = callIdNew(this.localIp);
    this.fromTag = tagId();
    const requestUri = `sip:${this.config.targetUser}@${this.config.sipHost}:${this.config.sipPort}`;
    const sdp = [
      "v=0",
      `o=${this.config.sipUser} ${Date.now()} ${Date.now()} IN IP4 ${this.localIp}`,
      "s=BA Softphone",
      `c=IN IP4 ${this.localIp}`,
      "t=0 0",
      "m=audio 10000 RTP/AVP 0 8 101",
      "a=rtpmap:0 PCMU/8000",
      "a=rtpmap:8 PCMA/8000",
      "a=rtpmap:101 telephone-event/8000",
      "a=sendrecv",
      "",
    ].join("\r\n");

    const opts = {
      requestUri,
      toUser: this.config.targetUser,
      body: sdp,
    };
    await this.send(this.buildMessage("INVITE", opts));
    let resp = await this.waitOne(Math.max(5000, this.config.holdMs));

    if (resp.statusCode === 401 || resp.statusCode === 407) {
      const hdr =
        resp.headers["www-authenticate"] || resp.headers["proxy-authenticate"];
      const auth = parseWwwAuthenticate(hdr);
      if (!auth) throw new Error("收到 401/407 但無法解析 Digest");
      console.log("→ Digest 挑戰，重送 Authorization");
      await this.send(
        this.buildMessage("INVITE", {
          ...opts,
          authHeader: buildDigestAuth({
            username: this.config.sipUser,
            password: this.config.password,
            method: "INVITE",
            uri: requestUri,
            auth,
          }),
        }),
      );
      resp = await this.waitOne(Math.max(5000, this.config.holdMs));
    }

    if (resp.statusCode >= 100 && resp.statusCode < 180) {
      console.log(
        `→ ${resp.statusCode}：繼續等 ${this.config.holdMs}ms（請看室內機）…`,
      );
      const deadline = Date.now() + this.config.holdMs;
      while (Date.now() < deadline) {
        try {
          const next = await this.waitOne(
            Math.min(3000, deadline - Date.now()),
          );
          resp = next;
          if (next.statusCode >= 180) break;
        } catch {
          break;
        }
      }
    }
    return resp;
  }
}

const run = async () => {
  const config = parseCliArgs();
  printSection("直打室內機 SIP（不經主機）");
  console.log(`目標：${config.sipHost}:${config.sipPort}`);
  console.log(`From：${config.sipUser} → To：${config.targetUser}`);
  console.log("前提：室內已開標準／相容 SIP，VoIP 號碼已填（見文件 §10）\n");

  const probe = new SipProbe(config);
  let inviteResult = "none";

  try {
    await probe.start();
    const inv = await probe.invite();
    inviteResult = classify(inv.statusCode);
    console.log(`[INVITE] ${inv.start}`);
  } catch (error) {
    inviteResult = `error:${error.message}`;
    console.log(`INVITE：${error.message}`);
  } finally {
    probe.close();
  }

  printSection("彙總");
  console.log(JSON.stringify({ invite: inviteResult }, null, 2));

  if (inviteResult === "ringing" || inviteResult === "ok") {
    console.log("\n成功跡象：室內機應響鈴／來電畫面（Contact 應含室內 IP）。");
  } else {
    console.log(`
未振鈴。常見原因：
  1) 室內未開標準 SIP／VoIP 號碼未設（--to 須對齊 VoIP「號碼」）
  2) 打到錯誤 IP（應為室內 .78，不是主機 .27）
  3) 埠不對（標準 SIP 多用 5060）
`);
    process.exitCode = 1;
  }
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
