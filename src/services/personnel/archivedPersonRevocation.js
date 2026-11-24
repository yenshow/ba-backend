const db = require("../../database/db");
const logger = require("../../utils/logger").createLogger("archivedPersonRevocation");

async function revokeDeviceCredentials(person) {
  const access = require("../accessControl/accessControlService");
  const camera = require("../peopleCounting/isapiCameraFdLibService");
  const ladder = require("../ladderSdk/sdkCardService");
  const plates = require("../vehicleAccess/vehiclePlateSyncService");
  const targets = await db.query(
    `SELECT d.id, lower(d.type_code) AS type_code,
            (d.config->>'protocol' = 'hcnet_sdk' OR EXISTS (
              SELECT 1 FROM location_systems ls
              WHERE ls.system_type = 'elevator'
                AND ls.system_config #>> '{ladder_device,device_id}' = d.id::text
            )) AS uses_ladder,
            s.user_info_hash IS NOT NULL AS has_access_user
     FROM person_device_sync_states s
     JOIN devices d ON d.id = s.device_id
     WHERE s.employee_no = ?`,
    [person.employee_no],
  );
  const cardRows = await db.query("SELECT card_no FROM person_ladder_cards WHERE person_id = ?", [person.id]);
  let failures = 0;

  for (const target of targets) {
    try {
      if (target.type_code === "camera") {
        await camera.deleteByCustomHumanId(target.id, person.employee_no);
      } else {
        if (target.uses_ladder && cardRows.some((row) => row.card_no)) {
          const { cards } = await ladder.listCards(target.id);
          const configured = new Set(cards.map((card) => String(card.cardNo ?? card.card_no)));
          for (const { card_no: cardNo } of cardRows) {
            if (configured.has(cardNo)) await ladder.deleteCard(target.id, cardNo);
          }
        }
        if (!target.uses_ladder || target.has_access_user) {
          await access.deleteUserInfo(target.id, { employeeNoList: [person.employee_no] });
        }
      }
      await require("./personDeviceSyncStateService").deleteSyncStates(target.id, [person.employee_no]);
    } catch (error) {
      failures++;
      logger.warn("設備人員撤權待重試", { personId: person.id, deviceId: target.id, code: error.code });
    }
  }
  const result = await plates.purgePersonPlatesFromDevices(person.id);
  return failures + result.failures.length;
}

async function runNextRevocation() {
  const result = await db.transaction(async (query) => {
    const [person] = await query(
      `SELECT p.id, p.employee_no, j.attempts
       FROM archived_person_revocations j JOIN persons p ON p.id = j.person_id
       WHERE p.archived_at IS NOT NULL AND j.completed_at IS NULL
         AND j.next_attempt_at <= CURRENT_TIMESTAMP
       ORDER BY j.next_attempt_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED`,
    );
    if (!person) return;
    let failures;
    try {
      failures = await revokeDeviceCredentials(person);
    } catch (error) {
      failures = 1;
      logger.warn("封存人員撤權待重試", { personId: person.id, code: error.code });
    }
    const retrySeconds = Math.min(3600, 15 * 2 ** Math.min(person.attempts, 8));
    await query(
      `UPDATE archived_person_revocations
       SET attempts = attempts + 1,
           completed_at = CASE WHEN ? = 0 THEN clock_timestamp() END,
           next_attempt_at = clock_timestamp() + (? * interval '1 second')
       WHERE person_id = ?`,
      [failures, retrySeconds, person.id],
    );
    return { personId: person.id, failedOperations: failures };
  }, null);
  if (result?.failedOperations) logger.warn("封存人員撤權待重試", result);
  else if (result) logger.info("封存人員撤權完成", result);
}

function startArchivedPersonRevocations() {
  let active = false;
  const timer = setInterval(async () => {
    if (active) return;
    active = true;
    try {
      await runNextRevocation();
    } catch (error) {
      logger.error("封存人員撤權排程失敗", { code: error.code });
    } finally {
      active = false;
    }
  }, 15000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

module.exports = { startArchivedPersonRevocations };
