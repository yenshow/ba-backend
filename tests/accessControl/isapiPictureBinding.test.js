/**
 * 門禁附圖綁定：人臉才佔單槽；非人臉不清槽
 *
 *   node tests/accessControl/isapiPictureBinding.test.js
 */
const assert = require("node:assert/strict");
const {
  shouldQueueAccessEventPicture,
  shouldDisplayAccessEventPicture,
} = require("../../src/services/peopleCounting/accessControlLogLabels");

const PROCESSABLE_SUBS = new Set([1, 9, 38, 39, 75, 76, 2077, 2078, 2079]);

/** 對齊 subscribe：heartbeat／非 major5 不入庫；單槽；attach 僅人臉；顯示再濾一次 */
const ingest = (parts) => {
  let nextId = 1;
  let pendingId = null;
  const rows = [];
  const warns = [];

  const occupyFaceSlot = (id) => {
    if (pendingId != null) warns.push(`unpaired:${pendingId}`);
    pendingId = id;
  };

  for (const part of parts) {
    if (part.kind === "json") {
      if (part.heartbeat) continue;
      const major = part.major ?? 5;
      const sub = Number(part.sub);
      if (major !== 5 || !PROCESSABLE_SUBS.has(sub)) continue;
      const id = part.id ?? nextId;
      nextId = Math.max(nextId, id + 1);
      const payload = {
        subEventType: sub,
        employeeNoString: part.employee ?? "",
        personName: part.name ?? "",
      };
      rows.push({ id, payload, picturePath: null });
      if (shouldQueueAccessEventPicture(payload)) occupyFaceSlot(id);
      continue;
    }

    if (pendingId == null) {
      warns.push("orphan");
      continue;
    }
    const row = rows.find((r) => r.id === pendingId);
    pendingId = null;
    if (!row || !shouldQueueAccessEventPicture(row.payload) || row.picturePath) {
      warns.push(`reject:${row?.id ?? "?"}`);
      continue;
    }
    row.picturePath = `/uploads/access-events/${row.id}.jpg`;
  }

  const view = rows.map((r) => ({
    id: r.id,
    sub: r.payload.subEventType,
    employee: r.payload.employeeNoString || "—",
    storedPath: r.picturePath,
    shownUrl: shouldDisplayAccessEventPicture(r.payload, r.picturePath)
      ? r.picturePath
      : "",
  }));
  return { view, warns, pendingId };
};

const byId = (view, id) => view.find((r) => r.id === id);

const run = () => {
  // 現場：指紋失敗空值 → 人臉毅丸 → 圖  → 圖綁人臉，指紋列無圖
  {
    const { view } = ingest([
      { kind: "json", id: 762, sub: 39 },
      { kind: "json", id: 763, sub: 75, employee: "B0120", name: "毅丸" },
      { kind: "image" },
    ]);
    assert.equal(byId(view, 762).shownUrl, "");
    assert.equal(byId(view, 763).shownUrl, "/uploads/access-events/763.jpg");
    assert.equal(byId(view, 762).employee, "—");
    assert.equal(byId(view, 763).employee, "B0120");
  }

  // 人臉 → 指紋 → 圖：指紋插中間不清槽
  {
    const { view } = ingest([
      { kind: "json", id: 1, sub: 75, employee: "A" },
      { kind: "json", id: 2, sub: 39 },
      { kind: "image" },
    ]);
    assert.equal(byId(view, 1).shownUrl, "/uploads/access-events/1.jpg");
    assert.equal(byId(view, 2).shownUrl, "");
  }

  // 人臉漏圖 → 下一筆人臉 → 圖：綁後者（不把後者的圖塞給前者）
  {
    const { view, warns } = ingest([
      { kind: "json", id: 10, sub: 75, employee: "A" },
      { kind: "json", id: 11, sub: 75, employee: "B" },
      { kind: "image" },
    ]);
    assert.equal(byId(view, 10).shownUrl, "");
    assert.equal(byId(view, 11).shownUrl, "/uploads/access-events/11.jpg");
    assert.ok(warns.includes("unpaired:10"));
  }

  // 正常交替：JSON 圖 JSON 圖
  {
    const { view, warns } = ingest([
      { kind: "json", id: 1, sub: 75, employee: "A" },
      { kind: "image" },
      { kind: "json", id: 2, sub: 75, employee: "B" },
      { kind: "image" },
    ]);
    assert.equal(byId(view, 1).shownUrl, "/uploads/access-events/1.jpg");
    assert.equal(byId(view, 2).shownUrl, "/uploads/access-events/2.jpg");
    assert.equal(warns.length, 0);
  }

  // 門鎖 major=3 不入庫，不佔槽
  {
    const { view } = ingest([
      { kind: "json", major: 3, sub: 21 },
      { kind: "json", id: 5, sub: 75, employee: "A" },
      { kind: "image" },
    ]);
    assert.equal(view.length, 1);
    assert.equal(view[0].shownUrl, "/uploads/access-events/5.jpg");
  }

  // 人臉一張圖後多一張 JPEG → orphan，不覆蓋
  {
    const { view, warns } = ingest([
      { kind: "json", id: 1, sub: 75, employee: "A" },
      { kind: "image" },
      { kind: "image" },
    ]);
    assert.equal(view[0].shownUrl, "/uploads/access-events/1.jpg");
    assert.ok(warns.includes("orphan"));
  }

  // heartbeat 略過
  {
    const { view } = ingest([
      { kind: "json", heartbeat: true, sub: 75 },
      { kind: "json", id: 1, sub: 75, employee: "A" },
      { kind: "image" },
    ]);
    assert.equal(view.length, 1);
    assert.equal(view[0].id, 1);
  }

  // 卡片失敗 → 人臉 → 圖
  {
    const { view } = ingest([
      { kind: "json", id: 1, sub: 9 },
      { kind: "json", id: 2, sub: 75, employee: "A" },
      { kind: "image" },
    ]);
    assert.equal(byId(view, 1).shownUrl, "");
    assert.equal(byId(view, 2).shownUrl, "/uploads/access-events/2.jpg");
  }

  // 歷史錯綁：指紋列 DB 有 path → UI 仍不顯示
  assert.equal(
    shouldDisplayAccessEventPicture({ subEventType: 39 }, "/uploads/stolen.jpg"),
    false,
  );

  // 已知限制：兩則人臉 JSON 先到、兩張圖後到 → 只綁第二筆（設備通常是 JSON+圖成對）
  {
    const { view, warns } = ingest([
      { kind: "json", id: 1, sub: 75, employee: "A" },
      { kind: "json", id: 2, sub: 75, employee: "B" },
      { kind: "image" },
      { kind: "image" },
    ]);
    assert.equal(byId(view, 1).shownUrl, "");
    assert.equal(byId(view, 2).shownUrl, "/uploads/access-events/2.jpg");
    assert.ok(warns.includes("unpaired:1"));
    assert.ok(warns.includes("orphan"));
  }

  // 腳本重排（歷史特殊情形，非正式路徑）
  {
    const { planReassignByOrder } = require("../../scripts/repairAccessEventPictures");
    const mk = (id, sub, pic, t) => ({
      id,
      device_ip: "10.0.0.1",
      event_time: new Date(t),
      payload: { subEventType: sub },
      picture_path: pic,
    });
    const byIdMap = Object.fromEntries(
      planReassignByOrder([
        mk(1, 39, "/uploads/a.jpg", "2026-09-03T00:00:01Z"),
        mk(2, 75, "/uploads/b.jpg", "2026-09-03T00:00:02Z"),
        mk(3, 75, null, "2026-09-03T00:00:03Z"),
      ]).map((c) => [c.id, c]),
    );
    assert.equal(byIdMap[1].new_path, "");
    assert.equal(byIdMap[2].new_path, "/uploads/a.jpg");
    assert.equal(byIdMap[3].new_path, "/uploads/b.jpg");
    assert.equal(
      planReassignByOrder([
        mk(1, 75, "/uploads/keep.jpg", "2026-09-03T00:00:01Z"),
        mk(2, 75, null, "2026-09-03T00:00:02Z"),
      ]).length,
      0,
    );
  }

  console.log("isapiPictureBinding.test.js: OK");
};

run();
