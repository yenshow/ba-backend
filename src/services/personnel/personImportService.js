const path = require("path");
const fs = require("fs").promises;
const ExcelJS = require("exceljs");
const AdmZip = require("adm-zip");
const personnelService = require("./personnelService");
const personLicensePlateService = require("./personLicensePlateService");
const {
  getProfileSchema,
  getImportAliases,
  normalizeKey,
  asCustomFieldsObject,
} = require("./personnelProfileSchema");
const {
  PERSONNEL_FACE_IMPORT_SOURCE_MAX_BYTES,
  formatPersonnelFaceImportSourceMaxSizeLabel,
  listPersonnelImportZipCandidateNames,
  resolveUniquePersonnelFacePath,
} = require("./personnelFileHelpers");
const { normalizeFaceImage } = require("./personnelFaceImageService");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");

const IMPORT_HEADERS = [
  "ID",
  "姓名",
  "有效起始日",
  "有效結束日",
  "門禁密碼",
  "卡號",
  "車牌",
];

const IMPORT_TEMPLATE_ROWS = [
  {
    ID: "A0001",
    姓名: "王小明",
    有效起始日: "2026-01-01",
    有效結束日: "2030-12-31",
    門禁密碼: "1234",
    卡號: "0000123456",
    車牌: "ABC1234,XYZ5678",
  },
  {
    ID: "A0002",
    姓名: "林小華",
    有效起始日: "",
    有效結束日: "",
    門禁密碼: "",
    卡號: "",
    車牌: "",
  },
];

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

function cellValueToString(value) {
  if (value == null || value === "") return "";
  if (value instanceof Date) {
    const pad = (n) => String(n).padStart(2, "0");
    const y = value.getFullYear();
    const m = pad(value.getMonth() + 1);
    const d = pad(value.getDate());
    const h = value.getHours();
    const min = value.getMinutes();
    if (h === 0 && min === 0) return `${y}-${m}-${d}`;
    return `${y}-${m}-${d}T${pad(h)}:${pad(min)}`;
  }
  if (typeof value === "object") {
    if (Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text || "").join("");
    }
    if (value.result !== undefined) return cellValueToString(value.result);
    if (value.text != null) return String(value.text);
  }
  return String(value).trim();
}

async function rowsFromExcelBuffer(excelBuffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(excelBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throwApiError(C.PERSONNEL_IMPORT_VALIDATION_FAILED, "Excel 無工作表");
  }

  let headers = [];
  const rows = [];
  sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    if (rowNumber === 1) {
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        headers[colNumber - 1] = cellValueToString(cell.value);
      });
      while (headers.length > 0 && !headers[headers.length - 1]) {
        headers.pop();
      }
      return;
    }

    const obj = {};
    let hasAny = false;
    headers.forEach((header, index) => {
      if (!header) return;
      const value = cellValueToString(row.getCell(index + 1).value);
      obj[header] = value;
      if (value !== "") hasAny = true;
    });
    if (hasAny) rows.push(obj);
  });
  return rows;
}

const getEmployeeNoFromRow = (row) =>
  pick(row, ["ID", "工號", "員工編號", "employeeNo"]);
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

const pickCustomFieldsFromRow = (row, fields) => {
  const result = {};
  for (const field of fields || []) {
    const raw = pick(row, getImportAliases(field));
    if (raw === undefined) continue;
    result[field.key] = String(raw);
  }
  return result;
};

function parseLicensePlatesFromCell(raw) {
  if (raw == null || String(raw).trim() === "") return [];
  return String(raw)
    .split(/[,;，、\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 批次匯入（Excel + 選填圖片 zip）
 * @returns {{
 *   created: number,
 *   updated: number,
 *   createdIds: Array<{ id: number, employeeNo: string }>,
 *   updatedIds: Array<{ id: number, employeeNo: string }>,
 *   errors?: Array<{ row: number, employeeNo?: string, message: string }>
 * }}
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

  const rows = await rowsFromExcelBuffer(excelBuffer);
  const profileSchema = await getProfileSchema();
  const enabledFields = profileSchema.fields || [];
  let zipIndex = new Map();
  if (zipBuffer && Buffer.isBuffer(zipBuffer)) {
    try {
      zipIndex = buildZipIndexFromBuffer(zipBuffer);
    } catch (_e) {
      throwApiError(C.PERSONNEL_IMPORT_VALIDATION_FAILED,"圖片 zip 解析失敗");
    }
  }

  const createdIds = [];
  const updatedIds = [];
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
      errors.push({ row: i + 2, message: "ID 不能為空" });
      continue;
    }
    if (!fullName) {
      errors.push({ row: i + 2, employeeNo, fullName: null, message: "姓名為必填" });
      continue;
    }

    try {
      const existing = await personnelService.getPersonByEmployeeNo(employeeNo);
      const isUpdate = Boolean(existing && existing.id);
      const customFields = pickCustomFieldsFromRow(row, enabledFields);
      const hasCustomFields = Object.keys(customFields).length > 0;

      const person = isUpdate
        ? await personnelService.updatePerson(existing.id, {
            fullName,
            ...(hasCustomFields ? { customFields } : {}),
          })
        : await personnelService.createPerson(
            {
              employeeNo,
              fullName,
              ...(hasCustomFields ? { customFields } : {}),
            },
            createdBy,
          );

      if (licensePlates.length > 0) {
        await personnelService.replacePersonLicensePlates(person.id, licensePlates);
      }

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
      const shouldWriteAccess =
        password || cardNo || (hasBegin && hasEnd) || shouldDefaultLongTerm;

      if (shouldWriteAccess) {
        const payload = {};
        if (hasBegin && hasEnd) {
          payload.validity = {
            longTerm: false,
            beginTime: beginStr,
            endTime: endStr,
          };
        } else if (shouldDefaultLongTerm) {
          payload.validity = { longTerm: true };
        }
        // 空欄不帶 password，避免更新時誤清既有密碼
        if (password) payload.password = password;
        if (cardNo) payload.cards = [{ cardNo, source: "manual" }];
        await personnelService.setPersonAccessControlConfig(person.id, payload);
      }

      if (zipIndex.size > 0) {
        const candidateNames = listPersonnelImportZipCandidateNames(employeeNo);
        const entry =
          candidateNames
            .map((n) => zipIndex.get(String(n).toLowerCase()))
            .find(Boolean) || null;

        if (entry) {
          const buffer = entry.getData();
          if (buffer && buffer.length > 0) {
            if (buffer.length > PERSONNEL_FACE_IMPORT_SOURCE_MAX_BYTES) {
              throwApiError(
                C.PERSONNEL_IMPORT_VALIDATION_FAILED,
                `圖片檔案過大（需 ≤ ${formatPersonnelFaceImportSourceMaxSizeLabel()}）`,
              );
            }

            const normalized = await normalizeFaceImage(buffer);
            const { finalPath, faceUrl } = resolveUniquePersonnelFacePath(
              personnelUploadsDir,
              employeeNo,
            );

            await fs.writeFile(finalPath, normalized.buffer);
            try {
              // 舊檔清理由 personnelService.updatePerson 統一處理
              await personnelService.updatePerson(person.id, { faceUrl });
            } catch (err) {
              try {
                await fs.unlink(finalPath);
              } catch (_e) {}
              throw err;
            }
          }
        }
      }

      const idRow = { id: person.id, employeeNo: person.employee_no };
      if (isUpdate) updatedIds.push(idRow);
      else createdIds.push(idRow);
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
    created: createdIds.length,
    updated: updatedIds.length,
    createdIds,
    updatedIds,
    errors: errors.length > 0 ? errors : undefined,
  };
}

function getImportSpreadsheetHeaders(fields) {
  return [...IMPORT_HEADERS, ...(fields || []).map((field) => field.label)];
}

function getExportSpreadsheetHeaders(fields) {
  return [...getImportSpreadsheetHeaders(fields), "群組", "狀態"];
}

function toExportDateOnly(value) {
  const s = String(value || "").trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

function readAccessControlExport(person) {
  const config = asCustomFieldsObject(person?.config);
  const ac = asCustomFieldsObject(config.access_control);
  const validity = asCustomFieldsObject(ac.validity);
  const cards = Array.isArray(ac.cards) ? ac.cards : [];
  const firstCard = cards.find((card) => String(card?.cardNo || "").trim());
  const longTerm = validity.longTerm !== false;
  return {
    beginDate: longTerm ? "" : toExportDateOnly(validity.beginTime),
    endDate: longTerm ? "" : toExportDateOnly(validity.endTime),
    cardNo: String(firstCard?.cardNo || ac.cardNo || "").trim(),
  };
}

function buildPersonExportRow(person, fields, plates) {
  const ac = readAccessControlExport(person);
  const custom = asCustomFieldsObject(person?.custom_fields);
  const row = {
    ID: person?.employee_no ?? "",
    姓名: person?.full_name ?? "",
    有效起始日: ac.beginDate,
    有效結束日: ac.endDate,
    門禁密碼: "",
    卡號: ac.cardNo,
    車牌: (plates || []).join(","),
    群組: String(person?.group_name || "").trim() || "未分組",
    狀態: person?.status === "inactive" ? "停用" : "啟用",
  };
  for (const field of fields || []) {
    const value = custom[field.key];
    row[field.label] = value == null ? "" : String(value);
  }
  return row;
}

async function listAllPersonsForExport(filters, sortOrder) {
  const items = [];
  let offset = 0;
  const limit = 200;
  while (true) {
    const page = await personnelService.getPersonsPaged(filters, {
      limit,
      offset,
      sortOrder,
    });
    const chunk = Array.isArray(page?.items) ? page.items : [];
    items.push(...chunk);
    const total = Number(page?.total);
    if (chunk.length < limit || (Number.isFinite(total) && items.length >= total)) {
      break;
    }
    offset += chunk.length;
  }
  return items;
}

async function getExportXlsxBuffer(filters = {}, options = {}) {
  const schema = await getProfileSchema();
  const fields = schema.fields || [];
  const headers = getExportSpreadsheetHeaders(fields);
  const persons = await listAllPersonsForExport(filters, options.sortOrder);
  const platesByPerson = await personLicensePlateService.listPlateNumbersByPersonIds(
    persons.map((p) => p.id),
  );
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("export");
  sheet.addRow(headers);
  for (const person of persons) {
    const row = buildPersonExportRow(
      person,
      fields,
      platesByPerson.get(Number(person.id)) || [],
    );
    sheet.addRow(headers.map((header) => row[header] ?? ""));
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function getImportTemplateXlsxBuffer() {
  const schema = await getProfileSchema();
  const headers = getImportSpreadsheetHeaders(schema.fields);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("template");
  sheet.addRow(headers);
  IMPORT_TEMPLATE_ROWS.forEach((row) => {
    sheet.addRow(headers.map((header) => row[header] ?? ""));
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

module.exports = {
  executeBatchImport,
  getImportTemplateXlsxBuffer,
  getExportXlsxBuffer,
  getImportSpreadsheetHeaders,
  getExportSpreadsheetHeaders,
  buildPersonExportRow,
};
