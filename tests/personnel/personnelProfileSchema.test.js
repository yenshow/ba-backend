/**
 * 人員自訂欄位 schema 正規化／驗證
 *
 *   npm run test:personnel-profile-schema
 */
const assert = require("node:assert/strict");
const {
  MAX_ENABLED_FIELDS,
  normalizeSchema,
  validateAndNormalize,
  mergeCustomFields,
  getImportAliases,
  nextCustomKey,
} = require("../../src/services/personnel/personnelProfileSchema");

function expectValidationError(fn, messageIncludes) {
  let caught = null;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, "expected validation error");
  if (messageIncludes) {
    assert.match(String(caught.message || ""), new RegExp(messageIncludes));
  }
}

function run() {
  const empty = normalizeSchema(null);
  assert.deepEqual(empty.fields, []);
  assert.equal(empty.listColumns.avatar, true);
  assert.equal(empty.listColumns.group, true);
  assert.deepEqual(empty.listColumns.custom, []);

  const normalized = normalizeSchema({
    fields: [
      { key: "job_title", preset: "job_title", label: "職稱" },
      { key: "custom_1", preset: "custom", label: "工地證號" },
      { key: "job_title", preset: "job_title", label: "重複" },
    ],
    listColumns: { avatar: false, custom: ["job_title", "missing"] },
  });
  assert.equal(normalized.fields.length, 2);
  assert.equal(normalized.listColumns.avatar, false);
  assert.deepEqual(normalized.listColumns.custom, ["job_title"]);

  const saved = validateAndNormalize({
    fields: [
      { preset: "blood_type", label: "血型" },
      { key: "custom_2", preset: "custom", label: "廠商" },
    ],
    listColumns: { group: false },
  });
  assert.equal(saved.fields[0].key, "blood_type");
  assert.equal(saved.listColumns.group, false);
  assert.deepEqual(saved.listColumns.custom, ["blood_type", "custom_2"]);

  expectValidationError(
    () =>
      validateAndNormalize({
        fields: Array.from({ length: MAX_ENABLED_FIELDS + 1 }, (_, i) => ({
          key: `custom_${i + 1}`,
          preset: "custom",
          label: `欄${i + 1}`,
        })),
      }),
    "最多",
  );

  expectValidationError(
    () =>
      validateAndNormalize({
        fields: [
          { preset: "job_title", label: "職稱" },
          { key: "custom_1", preset: "custom", label: "職稱" },
        ],
      }),
    "標籤不可重複",
  );

  expectValidationError(
    () =>
      validateAndNormalize({
        fields: [{ key: "custom_1", preset: "custom", label: "車牌" }],
      }),
    "保留",
  );

  expectValidationError(
    () =>
      validateAndNormalize({
        fields: [{ key: "custom_1", preset: "custom", label: "群組" }],
      }),
    "保留",
  );

  const merged = mergeCustomFields(
    { job_title: "舊職稱", orphan: "保留" },
    { job_title: "工程師", blood_type: "A", ignored: "x" },
    ["job_title", "blood_type"],
  );
  assert.equal(merged.job_title, "工程師");
  assert.equal(merged.blood_type, "A");
  assert.equal(merged.orphan, "保留");
  assert.equal(merged.ignored, undefined);

  const aliases = getImportAliases({
    key: "job_title",
    preset: "job_title",
    label: "職務",
  });
  assert.ok(aliases.includes("職務"));
  assert.ok(aliases.includes("職稱"));

  assert.equal(
    nextCustomKey([{ key: "custom_1" }, { key: "job_title" }, { key: "custom_3" }]),
    "custom_4",
  );

  console.log("personnelProfileSchema tests passed");
}

run();
