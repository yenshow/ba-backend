/**
 * 人員匯出列／表頭（對齊匯入欄，不回傳密碼）
 *
 *   npm run test:personnel-export-rows
 */
const assert = require("node:assert/strict");
const {
  getImportSpreadsheetHeaders,
  getExportSpreadsheetHeaders,
  buildPersonExportRow,
} = require("../../src/services/personnel/personImportService");

function run() {
  const fields = [
    { key: "job_title", label: "職稱" },
    { key: "blood_type", label: "血型" },
  ];

  assert.deepEqual(getImportSpreadsheetHeaders(fields), [
    "ID",
    "姓名",
    "有效起始日",
    "有效結束日",
    "門禁密碼",
    "卡號",
    "車牌",
    "職稱",
    "血型",
  ]);
  assert.deepEqual(getExportSpreadsheetHeaders(fields), [
    ...getImportSpreadsheetHeaders(fields),
    "群組",
    "狀態",
  ]);

  const row = buildPersonExportRow(
    {
      employee_no: "A01",
      full_name: "王小明",
      group_name: "白班",
      status: "active",
      custom_fields: { job_title: "工程師", blood_type: "O" },
      config: {
        access_control: {
          password: "secret",
          validity: {
            longTerm: false,
            beginTime: "2026-01-01 00:00:00",
            endTime: "2026-12-31 23:59:59",
          },
          cards: [{ cardNo: "123" }],
        },
      },
    },
    fields,
    ["ABC-1234", "XYZ-5678"],
  );
  assert.equal(row.ID, "A01");
  assert.equal(row.姓名, "王小明");
  assert.equal(row.有效起始日, "2026-01-01");
  assert.equal(row.有效結束日, "2026-12-31");
  assert.equal(row.門禁密碼, "");
  assert.equal(row.卡號, "123");
  assert.equal(row.車牌, "ABC-1234,XYZ-5678");
  assert.equal(row.職稱, "工程師");
  assert.equal(row.血型, "O");
  assert.equal(row.群組, "白班");
  assert.equal(row.狀態, "啟用");

  const longTerm = buildPersonExportRow(
    {
      employee_no: "B02",
      full_name: "李四",
      status: "inactive",
      config: {
        access_control: {
          password: "9999",
          validity: {
            longTerm: true,
            beginTime: "2020-01-01",
            endTime: "2099-12-31",
          },
        },
      },
    },
    [],
    [],
  );
  assert.equal(longTerm.有效起始日, "");
  assert.equal(longTerm.有效結束日, "");
  assert.equal(longTerm.群組, "未分組");
  assert.equal(longTerm.狀態, "停用");
  assert.equal(longTerm.門禁密碼, "");

  console.log("personExportRows tests passed");
}

run();
