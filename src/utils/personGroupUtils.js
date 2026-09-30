/**
 * 人員群組分組（人流／車輛／時段簽到共用）
 * 未分組 id＝0，與前端 UNGROUPED_PERSON_GROUP_ID 對齊。
 */

const UNGROUPED_GROUP_ID = 0;
const UNGROUPED_GROUP_NAME = "未分組";

function groupPersonsByPersonGroup(persons) {
  const byGroupId = new Map();
  for (const p of persons || []) {
    const groupId =
      p.person_group_id != null && Number.isFinite(Number(p.person_group_id))
        ? Number(p.person_group_id)
        : UNGROUPED_GROUP_ID;
    const groupName =
      groupId === UNGROUPED_GROUP_ID
        ? UNGROUPED_GROUP_NAME
        : p.group_name || UNGROUPED_GROUP_NAME;
    if (!byGroupId.has(groupId)) {
      byGroupId.set(groupId, { id: groupId, name: groupName, list: [] });
    }
    byGroupId.get(groupId).list.push(p);
  }
  return [...byGroupId.values()].sort((a, b) => {
    if (a.id === UNGROUPED_GROUP_ID) return 1;
    if (b.id === UNGROUPED_GROUP_ID) return -1;
    return String(a.name).localeCompare(String(b.name), "zh-Hant");
  });
}

module.exports = {
  UNGROUPED_GROUP_ID,
  UNGROUPED_GROUP_NAME,
  groupPersonsByPersonGroup,
};
