const path = require("path");
const fs = require("fs").promises;
const XLSX = require("xlsx");
const AdmZip = require("adm-zip");
const personnelService = require("./personnelService");
const {
  PERSONNEL_FACE_MAX_BYTES,
  buildPersonnelFilename,
  isJpegByMagicBytes,
} = require("./personnelFileHelpers");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrorMeta");

function normalizeKey(k) {
  return String(k || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined) return obj[k];
  }
  const entries = Object.entries(obj || {});
  for (const k of keys) {
    const nk = normalizeKey(k);
    const hit = entries.find(([kk]) => normalizeKey(kk) === nk);
    if (hit) return hit[1];
  }
  return undefined;
}

function buildZipIndexFromBuffer(zipBuffer) {
  const zipIndex = new Map();
  if (!zipBuffer || !Buffer.isBuffer(zipBuffer)) return zipIndex;
  const zip = new AdmZip(zipBuffer);
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const base = path.basename(entry.entryName);
    if (!base) continue;
    zipIndex.set(base.toLowerCase(), entry);
  }
  return zipIndex;
}

function rowsFromExcelBuffer(excelBuffer) {
  const workbook = XLSX.read(excelBuffer, {
    type: "buffer",
    cellDates: true,
  });
  const firstSheetName = workbook.SheetNames?.[0];
  if (!firstSheetName) throwApiError(C.PERSONNEL_IMPORT_VALIDATION_FAILED,"Excel 無工作表");
  const sheet = workbook.Sheets[firstSheetName];
  return XLSX.utils.sheet_to_json(sheet, { defval: "" });
}

const getEmployeeNoFromRow = (row) => pick(row, ["工號", "員工編號", "employeeNo"]);
const getFullNameFromRow = (row) => pick(row, ["姓名", "fullName", "名字"]);
const getValidBeginFromRow = (row) =>
  pick(row, ["有效起始日", "有效起", "有效起始", "beginTime"]);
const getValidEndFromRow = (row) =>
  pick(row, ["有效結束日", "有效迄", "有效結束", "endTime"]);
const getPasswordFromRow = (row) =>
  pick(row, ["門禁密碼", "password", "密碼"]);
const getCardNoFromRow = (row) => pick(row, ["卡號", "cardNo", "card_no"]);
const getLicensePlatesFromRow = (row) =>
  pick(row, ["車牌", "licensePlates", "license_plates", "plateNumber"]);

function parseLicensePlatesFromCell(raw) {
  if (raw == null || String(raw).trim() === "") return [];
  return String(raw)
    .split(/[,;，、\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 批次匯入（Excel + 選填圖片 zip）
 * @returns {{ created: number, createdIds: Array<{ id: number, employeeNo: string }>, errors?: Array<{ row: number, employeeNo?: string, message: string }> }}
 */
async function executeBatchImport({
  excelBuffer,
  zipBuffer,
  createdBy,
  personnelUploadsDir,
}) {
  if (!excelBuffer || !Buffer.isBuffer(excelBuffer)) {
    throwApiError(C.PERSONNEL_IMPORT_VALIDATION_FAILED,"請上傳 Excel 檔（欄位名稱：excel）");
  }

  const rows = rowsFromExcelBuffer(excelBuffer);
  let zipIndex = new Map();
  if (zipBuffer && Buffer.isBuffer(zipBuffer)) {
    try {
      zipIndex = buildZipIndexFromBuffer(zipBuffer);
    } catch (_e) {
      throwApiError(C.PERSONNEL_IMPORT_VALIDATION_FAILED,"圖片 zip 解析失敗");
    }
  }

  const created = [];
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || {};
    const employeeNoRaw = getEmployeeNoFromRow(row);
    const employeeNo =
      employeeNoRaw != null ? String(employeeNoRaw).trim() : "";
    const fullNameRaw = getFullNameFromRow(row);
    const fullName =
      fullNameRaw != null && String(fullNameRaw).trim() !== ""
        ? String(fullNameRaw).trim()
        : null;

    const validBeginRaw = getValidBeginFromRow(row);
    const validEndRaw = getValidEndFromRow(row);
    const passwordRaw = getPasswordFromRow(row);
    const cardNoRaw = getCardNoFromRow(row);
    const licensePlatesRaw = getLicensePlatesFromRow(row);
    const licensePlates = parseLicensePlatesFromCell(licensePlatesRaw);

    if (!employeeNo) {
      errors.push({ row: i + 2, message: "員工編號不能為空" });
      continue;
    }
    if (!fullName) {
      errors.push({ row: i + 2, employeeNo, fullName: null, message: "姓名為必填" });
      continue;
    }

    try {
      const existing = await personnelService.getPersonByEmployeeNo(employeeNo);
      const isUpdate = Boolean(existing && existing.id);

      const person = isUpdate
        ? await personnelService.updatePerson(existing.id, { fullName })
        : await personnelService.createPerson(
            { employeeNo, fullName },
            createdBy,
          );

      if (licensePlates.length > 0) {
        await personnelService.replacePersonLicensePlates(person.id, licensePlates);
      }

      created.push({ id: person.id, employeeNo: person.employee_no });

      {
        const beginStr =
          validBeginRaw != null ? String(validBeginRaw).trim() : "";
        const endStr = validEndRaw != null ? String(validEndRaw).trim() : "";
        const hasBegin = Boolean(beginStr);
        const hasEnd = Boolean(endStr);
        if ((hasBegin && !hasEnd) || (!hasBegin && hasEnd)) {
          throwApiError(
            C.PERSONNEL_IMPORT_VALIDATION_FAILED,
            "有效期限需同時提供「有效起始日」與「有效結束日」",
          );
        }

        const password =
          passwordRaw != null && String(passwordRaw).trim() !== ""
            ? String(passwordRaw).trim()
            : null;
        const cardNo =
          cardNoRaw != null && String(cardNoRaw).trim() !== ""
            ? String(cardNoRaw).trim()
            : null;

        const shouldDefaultLongTerm = !isUpdate && !hasBegin && !hasEnd;

        const shouldWriteAnything =
          password || cardNo || (hasBegin && hasEnd) || shouldDefaultLongTerm;
        if (shouldWriteAnything) {
          const payload = {
            validity:
              hasBegin && hasEnd
                ? { longTerm: false, beginTime: beginStr, endTime: endStr }
                : shouldDefaultLongTerm
                  ? { longTerm: true }
                  : undefined,
            password,
          };
          if (cardNo) {
            payload.cards = [{ cardNo, source: "manual" }];
          }
          await personnelService.setPersonAccessControlConfig(person.id, payload);
        }
      }

      if (zipIndex.size > 0) {
        const candidateNames = [];
        ["jpg", "jpeg"].forEach((ext) =>
          candidateNames.push(`${employeeNo}.${ext}`),
        );
        const entry =
          candidateNames
            .map((n) => zipIndex.get(String(n).toLowerCase()))
            .find(Boolean) || null;

        if (entry) {
          const buffer = entry.getData();
          if (!buffer || buffer.length <= 0) {
            continue;
          }
          if (buffer.length > PERSONNEL_FACE_MAX_BYTES) {
            throwApiError(C.PERSONNEL_IMPORT_VALIDATION_FAILED,"圖片檔案過大（需 ≤ 200KB）");
          }
          if (!isJpegByMagicBytes(buffer.slice(0, 32))) {
            throwApiError(C.PERSONNEL_IMPORT_VALIDATION_FAILED,"圖片格式不正確：僅允許 JPEG（JPG）");
          }

          const desiredName = buildPersonnelFilename(
            fullName ?? "",
            employeeNo,
            ".jpg",
          );
          const ext = ".jpg";
          let finalFilename = desiredName;
          let finalPath = path.join(personnelUploadsDir, finalFilename);
          let n = 0;
          // 避免覆蓋既有檔案（也避免多次匯入互相踩檔）
          for (;;) {
            try {
              await fs.access(finalPath);
              n += 1;
              const base = path.basename(desiredName, ext);
              finalFilename = `${base}_${n}${ext}`;
              finalPath = path.join(personnelUploadsDir, finalFilename);
            } catch {
              break;
            }
          }

          await fs.writeFile(finalPath, buffer);
          const faceUrl = `/uploads/personnel/${finalFilename}`;
          try {
            // 舊檔清理由 personnelService.updatePerson 統一處理
            await personnelService.updatePerson(person.id, { faceUrl });
          } catch (err) {
            // 若 DB 更新失敗，回收剛寫入的檔案避免孤兒檔
            try {
              await fs.unlink(finalPath);
            } catch (_e) {}
            throw err;
          }
        }
      }
    } catch (err) {
      errors.push({
        row: i + 2,
        employeeNo,
        fullName,
        message: err.message || String(err),
      });
    }
  }

  return {
    created: created.length,
    createdIds: created,
    errors: errors.length > 0 ? errors : undefined,
  };
}

function getImportTemplateXlsxBuffer() {
  const rows = [
    {
      工號: "A0001",
      姓名: "王小明",
      有效起始日: "2026-01-01",
      有效結束日: "2030-12-31",
      門禁密碼: "1234",
      卡號: "0000123456",
      車牌: "ABC1234,XYZ5678",
    },
    {
      工號: "A0002",
      姓名: "林小華",
      有效起始日: "",
      有效結束日: "",
      門禁密碼: "",
      卡號: "",
      車牌: "",
    },
  ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows, {
    header: ["工號", "姓名", "有效起始日", "有效結束日", "門禁密碼", "卡號", "車牌"],
  });
  XLSX.utils.book_append_sheet(wb, ws, "template");

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

module.exports = {
  executeBatchImport,
  rowsFromExcelBuffer,
  buildZipIndexFromBuffer,
  getImportTemplateXlsxBuffer,
};
