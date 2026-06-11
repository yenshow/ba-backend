/**
 * 人員顯示標籤（工號 + 姓名）共用工具
 */
const db = require("../database/db");

const formatPersonLabel = (row) => {
  const no = String(
    row?.employee_no ?? row?.employeeNo ?? row?.id ?? "",
  ).trim();
  const nameRaw = row?.full_name ?? row?.fullName;
  const name = nameRaw != null ? String(nameRaw).trim() : "";
  return name ? `${no} ${name}` : no;
};

const resolvePersonFullName = (person) => {
  const no = String(person?.employee_no ?? person?.employeeNo ?? "").trim();
  for (const raw of [person?.full_name, person?.fullName, person?.name]) {
    if (raw == null) continue;
    const name = String(raw).trim();
    if (!name || (no && name === no)) continue;
    return name;
  }
  return null;
};

const formatPersonWarningFields = (person) => ({
  employeeNo: person?.employee_no ?? person?.employeeNo ?? null,
  fullName: resolvePersonFullName(person),
});

const pushPersonSyncWarning = (warnings, person, payload) => {
  warnings.push({ ...formatPersonWarningFields(person), ...payload });
};

async function formatMissingPersonIdLabels(personIds) {
  const ids = [
    ...new Set(
      (personIds || [])
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  ];
  if (ids.length === 0) return [];

  const rows = await db.query(
    "SELECT id, employee_no, full_name, status FROM persons WHERE id = ANY(?::int[])",
    [ids.map((x) => Math.trunc(x))],
  );
  const byId = new Map((rows || []).map((r) => [Number(r.id), r]));

  return ids.map((id) => {
    const row = byId.get(id);
    if (!row) return `#${id}（不存在）`;
    const label = formatPersonLabel(row);
    if (String(row.status || "").trim() !== "active") {
      return `${label}（已停用）`;
    }
    return label;
  });
}

module.exports = {
  formatPersonLabel,
  formatPersonWarningFields,
  pushPersonSyncWarning,
  formatMissingPersonIdLabels,
};
