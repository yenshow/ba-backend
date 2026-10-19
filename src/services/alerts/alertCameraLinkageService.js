const {
  createRuleLinkageCrud,
} = require("./alertLinkageHelpers");

const crud = createRuleLinkageCrud({
  tableName: "alert_camera_linkages",
  idsColumn: "camera_device_ids",
  payloadIdsKey: "camera_device_ids",
  maxIds: 4,
  mapRow: (row, parseIds) => {
    const out = {
      ...row,
      camera_device_ids: parseIds(row.camera_device_ids),
    };
    delete out.camera_device_id;
    return out;
  },
});

module.exports = {
  getByRuleId: crud.getByRuleId,
  getByRuleIds: crud.getByRuleIds,
  upsertForRule: crud.upsertForRule,
  deleteForRule: crud.deleteForRule,
};
