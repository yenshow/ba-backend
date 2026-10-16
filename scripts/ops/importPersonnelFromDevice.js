/**
 * 以 IP 直連門禁機，讀取人員完整憑證（人臉／多卡／指紋／效期／密碼）。
 * 互動選擇人員後，寫入平台主檔或匯出 Excel（＋ faces.zip）。
 * 設備不必已登錄平台 devices。寫平台時不寫地點名單、不觸發 sync job。
 *
 *   cd ba-backend
 *   node scripts/ops/importPersonnelFromDevice.js --host 192.168.2.50 --password <pwd>
 *   （port 預設 80、username 預設 admin；可用 --port／--username 覆寫）
 */
/* eslint-disable no-console */

const fsp = require("fs").promises;
const path = require("path");
const readline = require("readline");
const ExcelJS = require("exceljs");
const AdmZip = require("adm-zip");
const db = require("../../src/database/db");
const { createIsapiClient } = require("../../src/services/accessControl/isapiClient");
const accessControlService = require("../../src/services/accessControl/accessControlService");
const personnelService = require("../../src/services/personnel/personnelService");
const {
  normalizeFaceImage,
} = require("../../src/services/personnel/personnelFaceImageService");
const {
  PERSONNEL_FACE_IMPORT_SOURCE_MAX_BYTES,
  formatPersonnelFaceImportSourceMaxSizeLabel,
  resolveUniquePersonnelFacePath,
} = require("../../src/services/personnel/personnelFileHelpers");
const { getUploadsDir } = require("../../src/utils/baDataPaths");

const PAGE_SIZE = 50;
const DEVICE_DELAY_MS = 500;
const MAX_CARDS = 5;
const MAX_FINGERPRINTS = 5;

const args = process.argv.slice(2);

const argValue = (name) => {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (value == null || value.startsWith("--")) return "";
  return value;
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ask = (rl, question) =>
  new Promise((resolve) => {
    rl.question(question, (answer) => resolve(String(answer ?? "").trim()));
  });

const parseSelection = (text, max) => {
  const raw = String(text || "").trim().toLowerCase();
  if (!raw) return [];
  if (raw === "all") {
    return Array.from({ length: max }, (_, index) => index + 1);
  }
  const picked = new Set();
  for (const part of raw.split(/[,，\s]+/)) {
    if (!part) continue;
    const bounds = part.split("-").map((piece) => Number(piece));
    if (bounds.length === 2 && bounds.every((n) => Number.isFinite(n))) {
      const lo = Math.min(bounds[0], bounds[1]);
      const hi = Math.max(bounds[0], bounds[1]);
      for (let n = lo; n <= hi; n += 1) {
        if (n >= 1 && n <= max) picked.add(n);
      }
      continue;
    }
    const n = Number(part);
    if (Number.isFinite(n) && n >= 1 && n <= max) picked.add(n);
  }
  return [...picked].sort((a, b) => a - b);
};

const hostSlug = (host) =>
  String(host || "host")
    .replace(/[^\w.-]+/g, "_")
    .slice(0, 64);

const safeFaceFileName = (employeeNo) => {
  const base = String(employeeNo || "unknown")
    .replace(/[^\w.-]+/g, "_")
    .slice(0, 80);
  return `${base || "unknown"}.jpg`;
};

const parseValidityFromDevice = (valid) => {
  if (!valid || typeof valid !== "object") {
    return { kind: "missing", beginTime: null, endTime: null };
  }
  const beginTime =
    valid.beginTime != null ? String(valid.beginTime).trim() : "";
  const endTime = valid.endTime != null ? String(valid.endTime).trim() : "";
  if (beginTime && endTime) {
    return { kind: "range", beginTime, endTime };
  }
  return {
    kind: "incomplete",
    beginTime: beginTime || null,
    endTime: endTime || null,
  };
};

const fetchAllUserInfo = async (client) => {
  const result = [];
  let position = 0;
  for (;;) {
    const res = await accessControlService.searchUserInfoWithClient(client, {
      searchResultPosition: position,
      maxResults: PAGE_SIZE,
    });
    const list = res.list || [];
    result.push(...list);
    const total = res.totalMatches ?? 0;
    position += list.length;
    if (list.length === 0 || position >= total) break;
    await delay(DEVICE_DELAY_MS);
  }
  return result;
};

const buildCandidate = async (client, user, outDir) => {
  const employeeNo =
    user.employeeNo != null ? String(user.employeeNo).trim() : "";
  const fullName = user.name != null ? String(user.name).trim() : "";
  const warnings = [];
  const errors = [];

  if (!employeeNo) {
    return { skip: true, skipReason: "無工號", employeeNo: "", fullName };
  }
  if (!fullName) {
    return { skip: true, skipReason: "無姓名", employeeNo, fullName: "" };
  }

  const validity = parseValidityFromDevice(user.Valid);
  if (validity.kind === "incomplete") {
    warnings.push("效期起迄不齊，新建將用 longTerm");
  }

  const password =
    user.password != null && String(user.password).trim() !== ""
      ? String(user.password).trim()
      : null;

  let allCards = [];
  try {
    allCards = await accessControlService.searchCardInfoByEmployeeWithClient(
      client,
      employeeNo,
    );
  } catch (err) {
    errors.push(`卡號查詢失敗：${err?.message || err}`);
  }
  await delay(DEVICE_DELAY_MS);

  const cards = allCards.slice(0, MAX_CARDS).map((cardNo) => ({
    cardNo: String(cardNo).trim(),
    source: "captured",
  }));
  if (allCards.length > MAX_CARDS) {
    warnings.push(`卡號超過 ${MAX_CARDS} 張，僅匯入前 ${MAX_CARDS} 張`);
  }

  let fingerprints = [];
  let fingerprintSearchFailed = false;
  try {
    const fps =
      await accessControlService.searchFingerPrintByEmployeeWithClient(
        client,
        employeeNo,
      );
    fingerprints = (fps || [])
      .filter((fp) => fp && String(fp.fingerData || "").trim())
      .slice(0, MAX_FINGERPRINTS)
      .map((fp) => ({
        fingerData: String(fp.fingerData).trim(),
        source: "captured",
      }));
    if ((fps || []).length > MAX_FINGERPRINTS) {
      warnings.push(
        `指紋超過 ${MAX_FINGERPRINTS} 筆，僅匯入前 ${MAX_FINGERPRINTS} 筆`,
      );
    }
  } catch (err) {
    fingerprintSearchFailed = true;
    const msg = err?.message || String(err);
    // FingerPrint/Search 在部分型號回 notSupport；正式路徑為 FingerPrintUpload
    errors.push(
      /notSupport/i.test(msg)
        ? `指紋查詢失敗（設備回 notSupport；已走 FingerPrintUpload 仍失敗）：${msg}`
        : `指紋查詢失敗（FingerPrintUpload）：${msg}`,
    );
  }
  await delay(DEVICE_DELAY_MS);

  const faceURL =
    user.faceURL != null && String(user.faceURL).trim() !== ""
      ? String(user.faceURL).trim()
      : null;
  let faceBuffer = null;
  let faceFileRel = null;
  let faceDownloadFailed = false;
  if (faceURL) {
    try {
      faceBuffer = await accessControlService.downloadUserFaceImageWithClient(
        client,
        faceURL,
      );
      if (
        !faceBuffer ||
        !Buffer.isBuffer(faceBuffer) ||
        faceBuffer.length === 0
      ) {
        faceDownloadFailed = true;
        errors.push("設備有 faceURL 但下載失敗或非圖片");
      } else if (faceBuffer.length > PERSONNEL_FACE_IMPORT_SOURCE_MAX_BYTES) {
        faceDownloadFailed = true;
        errors.push(
          `人臉圖過大（需 ≤ ${formatPersonnelFaceImportSourceMaxSizeLabel()}）`,
        );
        faceBuffer = null;
      } else {
        const facesDir = path.join(outDir, "faces");
        await fsp.mkdir(facesDir, { recursive: true });
        const fileName = safeFaceFileName(employeeNo);
        await fsp.writeFile(path.join(facesDir, fileName), faceBuffer);
        faceFileRel = `faces/${fileName}`;
      }
    } catch (err) {
      faceDownloadFailed = true;
      errors.push(`人臉下載失敗：${err?.message || err}`);
      faceBuffer = null;
    }
    await delay(DEVICE_DELAY_MS);
  }

  const existing = await personnelService.getPersonByEmployeeNo(employeeNo);
  const incomplete = faceDownloadFailed || fingerprintSearchFailed;

  return {
    skip: false,
    employeeNo,
    fullName,
    action: existing ? "update" : "create",
    existingPersonId: existing?.id ?? null,
    validity,
    password,
    cards,
    fingerprints,
    faceURL,
    faceBuffer,
    faceFileRel,
    hasFace: Boolean(faceBuffer),
    cardCount: cards.length,
    fpCount: fingerprints.length,
    hasPassword: Boolean(password),
    hasValidity: validity.kind === "range",
    incomplete,
    warnings,
    errors,
  };
};

/** 對齊 personImportService 匯入範本欄位，並附多卡／人臉／指紋筆數供備份 */
const EXCEL_HEADERS = [
  "ID",
  "姓名",
  "有效起始日",
  "有效結束日",
  "門禁密碼",
  "卡號",
  "卡號2",
  "卡號3",
  "卡號4",
  "卡號5",
  "車牌",
  "人臉檔",
  "指紋筆數",
  "平台動作",
  "狀態",
  "備註",
];

const writePersonnelExcel = async (outDir, rows) => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("人員");
  sheet.addRow(EXCEL_HEADERS);

  for (const row of rows) {
    const cards = (row.cards || []).map((c) => String(c.cardNo || "").trim());
    const validity = formatValidityPreview(row.validity, row.action);
    const begin = validity.mode === "range" ? validity.beginTime || "" : "";
    const end = validity.mode === "range" ? validity.endTime || "" : "";
    const issues = [...(row.errors || []), ...(row.warnings || [])].join("; ");
    const status = row.incomplete ? "partial" : "OK";
    sheet.addRow([
      row.employeeNo,
      row.fullName,
      begin,
      end,
      row.password || "",
      cards[0] || "",
      cards[1] || "",
      cards[2] || "",
      cards[3] || "",
      cards[4] || "",
      "",
      row.faceFileRel ? path.basename(row.faceFileRel) : "",
      row.fpCount ?? 0,
      row.action,
      status,
      issues,
    ]);
  }

  const filePath = path.join(outDir, "personnel.xlsx");
  await workbook.xlsx.writeFile(filePath);
  return filePath;
};

const writeFacesZip = async (outDir, rows) => {
  const zip = new AdmZip();
  let count = 0;
  for (const row of rows) {
    if (!row.faceBuffer || !Buffer.isBuffer(row.faceBuffer)) continue;
    const name = safeFaceFileName(row.employeeNo);
    zip.addFile(name, row.faceBuffer);
    count += 1;
  }
  if (count === 0) return null;
  const filePath = path.join(outDir, "faces.zip");
  zip.writeZip(filePath);
  return { filePath, count };
};

const formatValidityPreview = (validity, action) => {
  if (validity?.kind === "range") {
    return {
      mode: "range",
      beginTime: validity.beginTime,
      endTime: validity.endTime,
    };
  }
  // 新建無起迄 → longTerm（Excel 留空）；更新則不改平台效期
  if (action === "create") return { mode: "longTerm" };
  return { mode: "keepPlatform" };
};

const printTable = (rows) => {
  console.log("");
  console.log(
    ["#", "動作", "工號", "姓名", "臉", "卡", "指紋", "密碼", "效期", "狀態"].join(
      "\t",
    ),
  );
  for (const row of rows) {
    const validityLabel =
      row.validity?.kind === "range"
        ? "range"
        : row.action === "create"
          ? "longTerm"
          : "keep";
    const status = [];
    if (row.skip) status.push(`略過:${row.skipReason}`);
    else if (row.incomplete) status.push("blocked");
    if ((row.errors || []).length || (row.warnings || []).length) {
      status.push(
        `issues:${(row.errors || []).length + (row.warnings || []).length}`,
      );
    }
    console.log(
      [
        row.index,
        row.skip ? "skip" : row.action,
        row.employeeNo || "—",
        row.fullName || "—",
        row.skip ? "—" : row.hasFace ? "Y" : row.faceURL ? "失敗" : "無",
        row.skip ? "—" : String(row.cardCount ?? 0),
        row.skip ? "—" : String(row.fpCount ?? 0),
        row.skip ? "—" : row.password || "無",
        row.skip ? "—" : validityLabel,
        status.join(",") || "OK",
      ].join("\t"),
    );
  }
  console.log("");
};

const writePreviewJson = async (outDir, candidates) => {
  const preview = candidates.map((c) => {
    if (c.skip) {
      return {
        index: c.index,
        action: "skip",
        employeeNo: c.employeeNo || null,
        fullName: c.fullName || null,
        reason: c.skipReason || null,
      };
    }
    const issues = [...(c.errors || []), ...(c.warnings || [])];
    return {
      index: c.index,
      action: c.action,
      employeeNo: c.employeeNo,
      fullName: c.fullName,
      personId: c.existingPersonId ?? null,
      validity: formatValidityPreview(c.validity, c.action),
      password: c.password || null,
      cards: (c.cards || []).map((x) => x.cardNo),
      fingerprints: (c.fingerprints || []).map((fp) => fp.fingerData),
      face: c.faceFileRel || null,
      blocked: Boolean(c.incomplete),
      issues,
    };
  });
  await fsp.writeFile(
    path.join(outDir, "preview.json"),
    `${JSON.stringify(preview, null, 2)}\n`,
    "utf8",
  );
};

const applyOne = async (row, personnelUploadsDir) => {
  const person =
    row.action === "update" && row.existingPersonId
      ? await personnelService.updatePerson(row.existingPersonId, {
          fullName: row.fullName,
        })
      : await personnelService.createPerson(
          { employeeNo: row.employeeNo, fullName: row.fullName },
          null,
        );

  const payload = {};
  if (row.validity?.kind === "range") {
    payload.validity = {
      longTerm: false,
      beginTime: row.validity.beginTime,
      endTime: row.validity.endTime,
    };
  } else if (row.action === "create") {
    payload.validity = { longTerm: true };
  }
  if (row.password) payload.password = row.password;
  if (row.cards?.length) payload.cards = row.cards;
  if (row.fingerprints?.length) {
    payload.fingerprints = row.fingerprints.map((fp) => ({
      fingerData: fp.fingerData,
      source: "captured",
    }));
  }

  if (
    payload.validity ||
    payload.password ||
    payload.cards ||
    payload.fingerprints
  ) {
    await personnelService.setPersonAccessControlConfig(person.id, payload);
  }

  if (row.faceBuffer && Buffer.isBuffer(row.faceBuffer)) {
    const normalized = await normalizeFaceImage(row.faceBuffer);
    const { finalPath, faceUrl } = resolveUniquePersonnelFacePath(
      personnelUploadsDir,
      row.employeeNo,
    );
    await fsp.mkdir(personnelUploadsDir, { recursive: true });
    await fsp.writeFile(finalPath, normalized.buffer);
    try {
      await personnelService.updatePerson(person.id, { faceUrl });
    } catch (err) {
      try {
        await fsp.unlink(finalPath);
      } catch (_e) {
        /* ignore */
      }
      throw err;
    }
  }
};

const resolveConn = async (rl) => {
  let host = argValue("--host") || argValue("--ip") || "";
  if (!host) host = await ask(rl, "設備 IP／host：");
  host = String(host).trim();
  if (!host) throw new Error("請提供 --host 或 --ip");

  // port／username 預設 80／admin，不互動詢問（可用 --port／--username 覆寫）
  const portRaw = argValue("--port");
  const port = portRaw == null || portRaw === "" ? 80 : Number(portRaw);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error("port 無效");
  }
  const username = (argValue("--username") || "admin").trim() || "admin";

  let password = argValue("--password");
  if (password == null || password === "") {
    password = await ask(rl, "password：");
  }
  if (!password) throw new Error("請提供 --password");

  return { host, port, username, password };
};

const resolveOutputMode = async (rl) => {
  const confirm = (
    await ask(rl, "寫入平台 (y) / 匯出 Excel (e) / 取消：")
  ).toLowerCase();
  if (confirm === "y" || confirm === "yes" || confirm === "p") return "platform";
  if (confirm === "e" || confirm === "excel") return "excel";
  return null;
};

const main = async () => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const conn = await resolveConn(rl);
    const client = createIsapiClient({
      host: conn.host,
      port: conn.port,
      username: conn.username,
      password: conn.password,
    });

    console.log(
      `直連 ${conn.host}:${conn.port}（user=${conn.username}）讀取人員與憑證…`,
    );

    const ts = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", "_")
      .slice(0, 19);
    const outDir = path.join(
      __dirname,
      "..",
      "tmp",
      `personnel-from-device-${hostSlug(conn.host)}-${ts}`,
    );
    await fsp.mkdir(outDir, { recursive: true });

    const users = await fetchAllUserInfo(client);
    console.log(`設備 UserInfo ${users.length} 筆，開始拉卡號／指紋／人臉…`);

    const candidates = [];
    for (const user of users) {
      const built = await buildCandidate(client, user, outDir);
      candidates.push({ ...built, index: candidates.length + 1 });
      process.stdout.write(`\r  已處理 ${candidates.length}/${users.length}`);
    }
    console.log("");

    await writePreviewJson(outDir, candidates);
    printTable(candidates);

    const skipCount = candidates.filter((c) => c.skip).length;
    const incompleteCount = candidates.filter(
      (c) => !c.skip && c.incomplete,
    ).length;
    console.log(
      `預覽：${outDir}` +
        `\n可選 ${candidates.length - skipCount} 筆` +
        (skipCount ? `（略過 ${skipCount}）` : "") +
        (incompleteCount ? `，其中不完整 ${incompleteCount}` : ""),
    );

    const selectionText = await ask(
      rl,
      "要處理的編號（例 1,3,5-8 或 all，空白取消）：",
    );
    const chosen = parseSelection(selectionText, candidates.length)
      .map((index) => candidates[index - 1])
      .filter(Boolean);

    if (chosen.length === 0) {
      console.log("未選擇人員，結束。");
      return;
    }

    const incompleteChosen = chosen.filter((r) => !r.skip && r.incomplete);
    let allowPartial = false;
    if (incompleteChosen.length > 0) {
      const ans = (
        await ask(
          rl,
          `選取中有 ${incompleteChosen.length} 筆憑證不完整，仍處理？(y/N)：`,
        )
      ).toLowerCase();
      allowPartial = ans === "y" || ans === "yes";
    }

    const writable = [];
    for (const row of chosen) {
      if (row.skip) {
        console.log(`略過 #${row.index} ${row.employeeNo}：${row.skipReason}`);
        continue;
      }
      if (row.incomplete && !allowPartial) {
        console.log(`略過 #${row.index} ${row.employeeNo}：憑證不完整`);
        continue;
      }
      writable.push(row);
    }

    if (writable.length === 0) {
      console.log("沒有可處理的人員。");
      return;
    }

    const outputMode = await resolveOutputMode(rl);
    if (!outputMode) {
      console.log("已取消。預覽檔已保留。");
      return;
    }

    if (outputMode === "excel") {
      const xlsxPath = await writePersonnelExcel(outDir, writable);
      const zipResult = await writeFacesZip(outDir, writable);
      console.log(`已匯出：${xlsxPath}`);
      if (zipResult) console.log(`人臉 zip：${zipResult.filePath}（${zipResult.count}）`);
      console.log(`指紋模板見 preview.json（共 ${writable.length} 筆）。`);
      return;
    }

    const personnelUploadsDir = getUploadsDir("personnel");
    let created = 0;
    let updated = 0;
    const applyErrors = [];
    for (const row of writable) {
      try {
        await applyOne(row, personnelUploadsDir);
        if (row.action === "create") created += 1;
        else updated += 1;
        console.log(
          `已寫入 ${row.employeeNo} ${row.fullName}` +
            ` 臉=${row.hasFace ? "Y" : "N"} 卡=${row.cardCount} 指紋=${row.fpCount}`,
        );
      } catch (err) {
        applyErrors.push({
          employeeNo: row.employeeNo,
          message: err?.message || String(err),
        });
        console.log(`失敗 ${row.employeeNo}：${err?.message || err}`);
      }
    }

    console.log(
      `完成：create ${created}，update ${updated}` +
        `${applyErrors.length ? `，失敗 ${applyErrors.length}` : ""}。` +
        `\n請至人流「門禁管理」勾選名單再同步。`,
    );
    if (applyErrors.length) {
      await fsp.writeFile(
        path.join(outDir, "apply-errors.json"),
        `${JSON.stringify(applyErrors, null, 2)}\n`,
        "utf8",
      );
    }
  } finally {
    rl.close();
  }
};

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error?.message || String(error));
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await db.close();
      } catch (_error) {
        /* 連線池可能尚未建立 */
      }
    });
}

module.exports = {
  parseSelection,
  parseValidityFromDevice,
};
