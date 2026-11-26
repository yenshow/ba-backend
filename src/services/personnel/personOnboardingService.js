/**
 * 新人建檔編排（步驟可恢復；每步成功即 commit）
 */
const C = require("../../utils/apiErrorCodes");
const { throwApiError, createApiError } = require("../../utils/apiErrors");
const personnelService = require("./personnelService");
const personEntitlementService = require("./personEntitlementService");
const personScopedSyncJobService = require("./personScopedSyncJobService");
const personLadderCardService = require("./personLadderCardService");
const locationMemberService = require("./locationMemberService");
const permissionService = require("../../access/permissionService");
const logger = require("../../utils/logger").createLogger(
  "PersonOnboardingService",
);

const STEPS = ["profile", "credentials", "entitlements", "sync"];

function normalizeStep(step) {
  const s = String(step || "profile").trim();
  return STEPS.includes(s) ? s : "profile";
}

function shouldRunStep(startStep, step) {
  return STEPS.indexOf(startStep) <= STEPS.indexOf(step);
}

async function runOnboarding(body = {}, user = {}) {
  const startStep = normalizeStep(body.step || body.startStep || "profile");
  const completedSteps = [];
  const warnings = [];
  let personId =
    body.personId != null ? Number(body.personId) : null;
  let person = null;
  let deviceSync = null;

  const fail = (step, err) => {
    const message = err?.message || String(err);
    const statusCode = err?.statusCode || err?.status || 400;
    const code = err?.code || C.PERSONNEL_VALIDATION_FAILED;
    logger.warn("onboarding 步驟失敗", { step, personId, message });
    throw createApiError(code, message, {
      statusCode,
      details: {
        step,
        personId,
        completedSteps: [...completedSteps],
        warnings,
      },
    });
  };

  try {
    if (startStep !== "profile" && (!Number.isFinite(personId) || personId <= 0)) {
      throwApiError(C.PERSONNEL_VALIDATION_FAILED, "續作需提供 personId");
    }

    if (shouldRunStep(startStep, "profile")) {
      const profile = body.profile || body.person || {};
      if (Number.isFinite(personId) && personId > 0) {
        person = await personnelService.updatePerson(personId, profile);
      } else {
        person = await personnelService.createPerson(
          profile,
          user?.id ?? null,
        );
        personId = Number(person.id);
      }
      completedSteps.push("profile");
    } else {
      person = await personnelService.getPersonById(personId);
      if (!person) {
        throwApiError(C.PERSONNEL_PERSON_NOT_FOUND, "人員不存在", {
          statusCode: 404,
        });
      }
    }

    if (shouldRunStep(startStep, "credentials")) {
      const credentials = body.credentials || {};
      if (credentials.accessControl || credentials.access_control) {
        await personnelService.setPersonAccessControlConfig(
          personId,
          credentials.accessControl || credentials.access_control,
        );
      }
      if (credentials.licensePlates || credentials.plates) {
        await personnelService.replacePersonLicensePlates(
          personId,
          credentials.licensePlates || credentials.plates,
          { syncToDevices: false },
        );
      }
      if (credentials.faceUrl != null || credentials.face_url != null) {
        await personnelService.updatePerson(personId, {
          faceUrl: credentials.faceUrl ?? credentials.face_url,
        });
      }
      completedSteps.push("credentials");
      person = await personnelService.getPersonById(personId);
    }

    if (shouldRunStep(startStep, "entitlements")) {
      const entitlements = body.entitlements || {};
      const grantLocationIds = entitlements.grantLocationIds || [];
      const revokeLocationIds = entitlements.revokeLocationIds || [];
      const touched = [
        ...new Set([...(grantLocationIds || []), ...(revokeLocationIds || [])]),
      ];
      const permissions = await permissionService.attachEffectivePermissions({
        user,
      });
      if (touched.length) {
        for (const locationId of touched) {
          await locationMemberService.assertLocationScopedAccessPermission(
            locationId,
            "members",
            { role: user?.role, permissions },
          );
        }
        await personEntitlementService.patchPersonLocationAccess(personId, {
          grantLocationIds,
          revokeLocationIds,
          sync: false,
        });
      }
      const floors = entitlements.elevatorFloors || entitlements.floors;
      if (floors && typeof floors === "object") {
        const canFloor =
          user?.role === "admin" ||
          (Array.isArray(permissions) &&
            permissions.includes("system.elevator.floor.manage"));
        if (!canFloor) {
          warnings.push({
            type: "elevator",
            message: "無權限寫入電梯樓層，已略過",
          });
        } else {
          try {
            await personLadderCardService.upsertForPerson(personId, {
              floors:
                floors.byLocation != null ? floors : { byLocation: floors },
            });
          } catch (err) {
            warnings.push({
              type: "elevator",
              message: err?.message || String(err),
            });
          }
        }
      }
      completedSteps.push("entitlements");
    }

    if (shouldRunStep(startStep, "sync")) {
      if (body.skipSync === true) {
        warnings.push({
          type: "sync_skipped",
          message: "已略過設備同步",
        });
      } else {
        const started = await personScopedSyncJobService.startPersonSyncJob(
          personId,
          {
            domains: body.domains || ["access", "plates", "elevator"],
            locationIds: body.locationIds ?? null,
          },
        );
        deviceSync = {
          triggered: true,
          jobId: started.jobId,
          reused: started.reused,
        };
      }
      completedSteps.push("sync");
    }

    person = person || (await personnelService.getPersonById(personId));
    return {
      personId,
      person,
      completedSteps: [...new Set(completedSteps)],
      warnings,
      deviceSync,
      nextStep: null,
    };
  } catch (err) {
    if (err?.details?.step) throw err;
    const stepGuess = completedSteps.length
      ? STEPS[Math.min(completedSteps.length, STEPS.length - 1)]
      : startStep;
    return fail(stepGuess, err);
  }
}

module.exports = {
  STEPS,
  runOnboarding,
};
