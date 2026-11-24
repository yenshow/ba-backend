const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { setImmediate: flush } = require("node:timers/promises");
const { test } = require("node:test");
const {
  consumeMultipartEventStream,
} = require("../../src/services/isapi/isapiSubscribeLoop");

const contentType = "multipart/mixed; boundary=test-isapi";
const closingBoundary = Buffer.from("--test-isapi--\r\n");
const part = (body, withLength = true) => Buffer.concat([
  Buffer.from(
    `--test-isapi\r\nContent-Type: image/jpeg\r\n${withLength ? `Content-Length: ${body.length}\r\n` : ""}\r\n`,
  ),
  body,
  Buffer.from("\r\n"),
]);

for (const preferContentLength of [true, false]) {
  test(`preserves fragmented ISAPI images (preferContentLength=${preferContentLength})`, async () => {
    const image = Buffer.alloc(1280 * 1024, 0x78);
    image.write("\r\n", image.length - 2);
    const packet = part(image, preferContentLength);
    async function* fragments() {
      yield packet.subarray(0, 1120 * 1024);
      await flush();
      yield packet.subarray(1120 * 1024);
      yield part(Buffer.from("next"), preferContentLength);
      yield closingBoundary;
    }

    const actual = [];
    await consumeMultipartEventStream({
      stream: Readable.from(fragments(), { objectMode: false, highWaterMark: 1 }),
      contentType,
      preferContentLength,
      onPart: (_, body) => actual.push(body),
    });
    assert.deepEqual(actual, [image, Buffer.from("next")]);
  });
}

test("reads in order and limits upstream reads while persistence is blocked", async () => {
  let produced = 0;
  async function* packets() {
    while (produced < 120) {
      yield part(Buffer.from(String(++produced)));
    }
    yield closingBoundary;
  }
  let release;
  const writing = new Promise((resolve) => { release = resolve; });
  const actual = [];
  const done = consumeMultipartEventStream({
    stream: Readable.from(packets(), { objectMode: false, highWaterMark: 1 }),
    contentType,
    onPart: async (_, body) => {
      actual.push(Number(body.toString()));
      if (actual.length === 1) await writing;
    },
  });

  try {
    await flush();
    assert.deepEqual(actual, [1]);
    assert.ok(produced < 10, `pulled ${produced} parts while a write was blocked`);
  } finally {
    release();
    await done;
  }
  assert.deepEqual(actual, Array.from({ length: 120 }, (_, index) => index + 1));
});

test("handles multiple parts in one chunk before calling stream completion", async () => {
  const actual = [];
  await consumeMultipartEventStream({
    stream: Readable.from([Buffer.concat([
      part(Buffer.from("first")),
      part(Buffer.from("second")),
      closingBoundary,
    ])]),
    contentType,
    onPart: (_, body) => actual.push(body.toString()),
    onBeforeResolve: () => actual.push("done"),
  });
  assert.deepEqual(actual, ["first", "second", "done"]);
});

test("reports an oversized ISAPI part before rejecting the stream", async () => {
  const errors = [];
  await assert.rejects(consumeMultipartEventStream({
    stream: Readable.from([
      Buffer.from("--test-isapi\r\nContent-Length: 16777217\r\n\r\n"),
    ]),
    contentType,
    onPart: () => assert.fail("oversized part should not be processed"),
    onPartError: (error) => errors.push(error.message),
  }), /multipart body exceeds/);
  assert.equal(errors.length, 1);
});

test("abort waits for the current part and skips the rest of the buffered parts", async () => {
  const controller = new AbortController();
  let resolve;
  const writing = new Promise((done) => { resolve = done; });
  const seen = [];
  const done = consumeMultipartEventStream({
    stream: Readable.from([Buffer.concat([
      part(Buffer.from("first")),
      part(Buffer.from("next")),
      closingBoundary,
    ])]),
    contentType,
    abortSignal: controller.signal,
    onPart: async (_, body) => {
      seen.push(body.toString());
      await writing;
    },
  });
  const rejected = assert.rejects(done, /ABORTED/);
  try {
    await flush();
    assert.deepEqual(seen, ["first"]);
    controller.abort();
  } finally {
    resolve();
  }
  await rejected;
  assert.deepEqual(seen, ["first"]);
});
