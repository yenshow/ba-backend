/**
 * G.711 RTP 單向發送。localPort=0 時由系統分配，避免多台室內機並行搶埠。
 */
const dgram = require("dgram");
const crypto = require("crypto");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} opts
 * @param {string} opts.localIp
 * @param {number} [opts.localPort]
 */
const createRtpSender = (opts) => {
  const socket = dgram.createSocket("udp4");
  const ssrc = crypto.randomBytes(4).readUInt32BE(0);
  let seq = crypto.randomInt(0, 65535);
  let timestamp = crypto.randomInt(0, 0xffffffff);
  let boundPort = 0;

  const inbound = { packets: 0, bytes: 0, payloadTypes: {} };
  let onInbound = null;

  socket.on("message", (msg) => {
    if (!msg || msg.length < 12) return;
    inbound.packets += 1;
    inbound.bytes += msg.length;
    const pt = msg[1] & 0x7f;
    inbound.payloadTypes[pt] = (inbound.payloadTypes[pt] || 0) + 1;
    if (typeof onInbound === "function") {
      try {
        onInbound({ payload: msg.subarray(12), payloadType: pt });
      } catch {
        /* ignore */
      }
    }
  });

  const writeRtpHeader = (payloadType) => {
    const header = Buffer.alloc(12);
    header[0] = 0x80;
    header[1] = payloadType & 0x7f;
    header.writeUInt16BE(seq & 0xffff, 2);
    seq = (seq + 1) & 0xffff;
    header.writeUInt32BE(timestamp >>> 0, 4);
    timestamp = (timestamp + 160) >>> 0;
    header.writeUInt32BE(ssrc >>> 0, 8);
    return header;
  };

  const sendDatagram = (packet, playOpts) =>
    new Promise((resolve, reject) => {
      socket.send(packet, playOpts.remotePort, playOpts.remoteIp, (err) =>
        err ? reject(err) : resolve(),
      );
    });

  const start = () =>
    new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(Number(opts.localPort) > 0 ? Number(opts.localPort) : 0, opts.localIp, () => {
        boundPort = socket.address().port;
        resolve();
      });
    });

  const close = () => {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  };

  /**
   * @param {Buffer[]} frames
   * @param {{ remoteIp: string, remotePort: number, payloadType: 0|8, packetIntervalMs?: number }} playOpts
   */
  const sendFrames = async (frames, playOpts) => {
    const interval = Number(playOpts.packetIntervalMs) > 0 ? Number(playOpts.packetIntervalMs) : 20;
    const payloadType = playOpts.payloadType === 8 ? 8 : 0;
    const startedAt = Date.now();
    for (let i = 0; i < frames.length; i += 1) {
      const packet = Buffer.concat([writeRtpHeader(payloadType), frames[i]]);
      await sendDatagram(packet, playOpts);
      const wait = startedAt + (i + 1) * interval - Date.now();
      if (wait > 0) await sleep(wait);
    }
  };

  /**
   * 送一幀 G.711（20ms）。網頁對講用；不 await 節奏由呼叫端控制。
   */
  const sendFrame = (frame, playOpts) => {
    if (!frame || !playOpts?.remoteIp || !playOpts?.remotePort) return;
    const payloadType = playOpts.payloadType === 8 ? 8 : 0;
    const packet = Buffer.concat([writeRtpHeader(payloadType), frame]);
    socket.send(packet, playOpts.remotePort, playOpts.remoteIp);
  };

  /**
   * 送靜音 G.711，讓對端維持 RTP（探測對講時接在播音之後）。
   */
  const sendSilence = async (durationMs, playOpts) => {
    const interval = Number(playOpts.packetIntervalMs) > 0 ? Number(playOpts.packetIntervalMs) : 20;
    const payloadType = playOpts.payloadType === 8 ? 8 : 0;
    const fill = payloadType === 8 ? 0xd5 : 0xff;
    const frame = Buffer.alloc(160, fill);
    const count = Math.max(1, Math.round(Number(durationMs) / interval));
    const startedAt = Date.now();
    for (let i = 0; i < count; i += 1) {
      const packet = Buffer.concat([writeRtpHeader(payloadType), frame]);
      await sendDatagram(packet, playOpts);
      const wait = startedAt + (i + 1) * interval - Date.now();
      if (wait > 0) await sleep(wait);
    }
  };

  const snapshotInbound = () => ({
    packets: inbound.packets,
    bytes: inbound.bytes,
    payloadTypes: { ...inbound.payloadTypes },
  });

  const setOnInbound = (handler) => {
    onInbound = typeof handler === "function" ? handler : null;
  };

  return {
    start,
    close,
    sendFrames,
    sendFrame,
    sendSilence,
    snapshotInbound,
    setOnInbound,
    get localPort() {
      return boundPort;
    },
  };
};

module.exports = {
  createRtpSender,
};
