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
      const header = Buffer.alloc(12);
      header[0] = 0x80;
      header[1] = payloadType & 0x7f;
      header.writeUInt16BE(seq & 0xffff, 2);
      seq = (seq + 1) & 0xffff;
      header.writeUInt32BE(timestamp >>> 0, 4);
      timestamp = (timestamp + 160) >>> 0;
      header.writeUInt32BE(ssrc >>> 0, 8);

      const packet = Buffer.concat([header, frames[i]]);
      await new Promise((resolve, reject) => {
        socket.send(packet, playOpts.remotePort, playOpts.remoteIp, (err) =>
          err ? reject(err) : resolve(),
        );
      });
      const wait = startedAt + (i + 1) * interval - Date.now();
      if (wait > 0) await sleep(wait);
    }
  };

  return {
    start,
    close,
    sendFrames,
    get localPort() {
      return boundPort;
    },
  };
};

module.exports = {
  createRtpSender,
};
