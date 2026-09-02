/**
 * 人員名單／群組／梯控樓層：修改資料 + 設備同步 job 整合測試
 *
 *   node tests/personnel/personnelMembersApplyAndSyncApi.test.js
 *
 * 前置：後端已啟動（預設 http://127.0.0.1:4000）
 *
 * 設備離線時：仍驗證 DB 寫入與 job 完成；連線錯誤僅記錄不 fail。
 */
const assert = require("node:assert/strict");

const API_BASE = (process.env.BA_API_BASE || "http://127.0.0.1:4000/api").replace(/\/$/, "");
const USERNAME = process.env.BA_USERNAME || "admin";
const PASSWORD = process.env.BA_PASSWORD || "Aa83124007";
const JOB_POLL_MS = Number(process.env.BA_SYNC_JOB_POLL_MS || 2000);
const JOB_TIMEOUT_MS = Number(process.env.BA_SYNC_JOB_TIMEOUT_MS || 120_000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const unwrap = async (res) => {
	const body = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(`HTTP ${res.status}: ${body.message || body.code || JSON.stringify(body)}`);
	}
	if (body && typeof body === "object" && "data" in body) return body.data;
	return body;
};

const authFetch = async (token, path, options = {}) => {
	const headers = {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
		...(options.headers || {}),
	};
	const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
	return unwrap(res);
};

const login = async () => {
	const lr = await fetch(`${API_BASE}/users/login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
	});
	const loginBody = await lr.json().catch(() => ({}));
	if (!lr.ok) {
		throw new Error(`login HTTP ${lr.status}: ${loginBody.message || JSON.stringify(loginBody)}`);
	}
	const token = loginBody.data?.token ?? loginBody.token;
	assert.ok(token, "login token missing");
	return token;
};

const isDeviceOfflineMessage = (msg) =>
	/設備|連線|offline|timeout|ECONNREFUSED|離線|網路不通/i.test(String(msg || ""));

const pollPersonnelSyncJob = async (token, jobId) => {
	const started = Date.now();
	let last = null;
	while (Date.now() - started < JOB_TIMEOUT_MS) {
		last = await authFetch(token, `/personnel/sync-location/jobs/${encodeURIComponent(jobId)}`);
		if (last?.status === "completed") return last;
		await sleep(JOB_POLL_MS);
	}
	throw new Error(`personnel sync job timeout: ${jobId} (last=${last?.status})`);
};

const pollElevatorSyncJob = async (token, jobId) => {
	const started = Date.now();
	let last = null;
	while (Date.now() - started < JOB_TIMEOUT_MS) {
		const raw = await authFetch(token, `/elevator/sync-location/jobs/${encodeURIComponent(jobId)}`);
		last = raw?.job ?? raw;
		if (last?.status === "completed") return last;
		await sleep(JOB_POLL_MS);
	}
	throw new Error(`elevator sync job timeout: ${jobId} (last=${last?.status})`);
};

const logSyncJobOutcome = (label, job) => {
	const warnings = job?.result?.warnings ?? [];
	const failed = job?.progress?.failed ?? 0;
	const err = job?.error ? String(job.error) : "";
	console.log(
		`  ↳ ${label} job=${job?.jobId || "?"} status=${job?.status} failed=${failed} warnings=${warnings.length}`,
	);
	if (err) {
		console.log(`  ↳ job error: ${err.slice(0, 120)}${isDeviceOfflineMessage(err) ? " (設備連線)" : ""}`);
	}
	for (const w of warnings.slice(0, 3)) {
		const msg = w?.message || w?.type || JSON.stringify(w);
		console.log(`  ↳ warning: ${String(msg).slice(0, 100)}`);
	}
};

const findFirstChildGroup = (groups) => {
	const mains = Array.isArray(groups) ? groups : [];
	for (const main of mains) {
		for (const child of main?.children || []) {
			if (child?.id != null) return child;
		}
	}
	return null;
};

async function testLocationMembersApplyAndSync(token) {
	const syncableRaw = await authFetch(token, "/personnel/syncable-locations");
	const locations = Array.isArray(syncableRaw) ? syncableRaw : syncableRaw?.locations || [];
	if (locations.length === 0) {
		console.log("⊘ skip location apply+sync (no syncable location)");
		return;
	}

	const locationId = Number(locations[0].id ?? locations[0].locationId);
	const locationName = locations[0].name || String(locationId);

	const memberIdsRes = await authFetch(token, `/personnel/locations/${locationId}/member-ids`);
	const originalIds = [...(memberIdsRes?.ids || [])].map((x) => Math.trunc(Number(x))).filter(Boolean);

	const personsPage = await authFetch(token, "/personnel/persons?limit=50&offset=0&status=active");
	const allPersons = personsPage?.items || [];
	assert.ok(allPersons.length > 0, "need at least one active person");

	let togglePersonId = allPersons.find((p) => !originalIds.includes(p.id))?.id;
	let nextIds;
	if (togglePersonId != null) {
		nextIds = [...originalIds, togglePersonId];
	} else {
		togglePersonId = originalIds[0];
		nextIds = originalIds.filter((id) => id !== togglePersonId);
	}
	assert.ok(togglePersonId != null, "toggle person id");

	console.log(
		`▶ 地點名單 ${locationName} (${locationId}): ${originalIds.length} → ${nextIds.length} 人`,
	);

	try {
		const putRes = await authFetch(token, `/personnel/locations/${locationId}/members`, {
			method: "PUT",
			body: JSON.stringify({ memberPersonIds: nextIds }),
		});
		assert.ok(putRes, "PUT members response");

		const afterIds = await authFetch(token, `/personnel/locations/${locationId}/member-ids`);
		const saved = (afterIds?.ids || []).map((x) => Math.trunc(Number(x))).filter(Boolean).sort((a, b) => a - b);
		const expected = [...nextIds].sort((a, b) => a - b);
		assert.deepEqual(saved, expected, "member ids persisted after apply");
		console.log(`✓ PUT /personnel/locations/${locationId}/members — DB 已更新`);

		const jobId = putRes?.deviceSync?.jobId;
		if (jobId) {
			const job = await pollPersonnelSyncJob(token, jobId);
			assert.equal(job.status, "completed");
			logSyncJobOutcome("人流門禁 sync", job);
			console.log(`✓ personnel sync job completed (${locationName})`);
		} else {
			console.log(`⊘ 此地點未觸發 deviceSync.jobId（可能非人流同步類型）`);
		}

		// 手動重同步（選配；job 可能極快完成而查詢不到）
		try {
			const manual = await authFetch(token, `/personnel/sync-location/${locationId}/job`, {
				method: "POST",
			});
			if (manual?.jobId) {
				const job2 = await pollPersonnelSyncJob(token, manual.jobId);
				logSyncJobOutcome("手動重同步", job2);
				console.log(`✓ POST /personnel/sync-location/${locationId}/job`);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.log(`⊘ skip manual resync poll: ${msg.slice(0, 100)}`);
		}
	} finally {
		await authFetch(token, `/personnel/locations/${locationId}/members`, {
			method: "PUT",
			body: JSON.stringify({ memberPersonIds: originalIds }),
		});
		const restored = await authFetch(token, `/personnel/locations/${locationId}/member-ids`);
		assert.deepEqual(
			(restored?.ids || []).map((x) => Math.trunc(Number(x))).filter(Boolean).sort((a, b) => a - b),
			[...originalIds].sort((a, b) => a - b),
			"restored member ids",
		);
		console.log(`✓ restored location ${locationId} members (${originalIds.length})`);
	}
}

async function testGroupMembersModify(token) {
	const groups = await authFetch(token, "/personnel/groups?tree=true");
	const childGroup = findFirstChildGroup(groups);
	if (!childGroup) {
		console.log("⊘ skip group members modify (no child group)");
		return;
	}

	const groupId = childGroup.id;
	const before = await authFetch(token, `/personnel/groups/${groupId}/member-ids`);
	const originalIds = [...(before?.ids || [])].map((x) => Math.trunc(Number(x))).filter(Boolean);

	const personsPage = await authFetch(token, "/personnel/persons?limit=50&offset=0&status=active");
	const candidate = (personsPage?.items || []).find((p) => !originalIds.includes(p.id));
	if (!candidate) {
		console.log("⊘ skip group members modify (no person to add)");
		return;
	}

	const nextIds = [...originalIds, candidate.id];
	console.log(`▶ 群組 ${childGroup.name || groupId}: +1 人 (${candidate.employee_no || candidate.id})`);

	try {
		await authFetch(token, `/personnel/groups/${groupId}/members`, {
			method: "PUT",
			body: JSON.stringify({ memberPersonIds: nextIds }),
		});
		const after = await authFetch(token, `/personnel/groups/${groupId}/member-ids`);
		assert.ok((after?.ids || []).includes(candidate.id), "person added to group");
		console.log(`✓ PUT /personnel/groups/${groupId}/members`);
	} finally {
		await authFetch(token, `/personnel/groups/${groupId}/members`, {
			method: "PUT",
			body: JSON.stringify({ memberPersonIds: originalIds }),
		});
		console.log(`✓ restored group ${groupId} members`);
	}
}

async function testElevatorFloorAccessApplyAndSync(token) {
	let elevatorLocationId = null;
	try {
		const sites = await authFetch(token, "/elevator/sites");
		const siteList = sites?.sites || sites?.items || [];
		elevatorLocationId = siteList[0]?.id ?? null;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.log(`⊘ skip elevator apply+sync: ${msg.slice(0, 80)}`);
		return;
	}

	if (elevatorLocationId == null) {
		console.log("⊘ skip elevator apply+sync (no elevator site)");
		return;
	}

	const floorAccess = await authFetch(token, `/elevator/locations/${elevatorLocationId}/floor-access`);
	const floors = floorAccess?.floors || [];
	if (floors.length === 0) {
		console.log("⊘ skip elevator apply+sync (no floors)");
		return;
	}

	const assignments = floors.map((f) => ({
		floorIndex: f.index,
		personIds: [...(f.personIds || [])],
	}));

	const donorFloor = assignments.find((a) => a.personIds.length > 0) || assignments[0];
	const targetFloor = assignments.find((a) => a.floorIndex !== donorFloor.floorIndex) || assignments[1];
	if (!targetFloor || !donorFloor?.personIds?.length) {
		console.log("⊘ skip elevator apply+sync (no person to move)");
		return;
	}

	const personId = donorFloor.personIds[0];
	if (!targetFloor.personIds.includes(personId)) {
		targetFloor.personIds.push(personId);
	}

	console.log(
		`▶ 梯控樓層 site ${elevatorLocationId}: person ${personId} → floor ${targetFloor.floorIndex}`,
	);

	try {
		const putRes = await authFetch(token, `/elevator/locations/${elevatorLocationId}/floor-access`, {
			method: "PUT",
			body: JSON.stringify({ assignments }),
		});
		assert.ok(putRes?.floors?.length, "floor access response");

		const jobId = putRes?.deviceSync?.jobId;
		assert.ok(jobId, "elevator deviceSync.jobId");
		const job = await pollElevatorSyncJob(token, jobId);
		assert.equal(job.status, "completed");
		logSyncJobOutcome("梯控 sync", job);
		console.log(`✓ PUT /elevator/locations/${elevatorLocationId}/floor-access + sync job`);
	} finally {
		const restoreAssignments = floors.map((f) => ({
			floorIndex: f.index,
			personIds: [...(f.personIds || [])],
		}));
		await authFetch(token, `/elevator/locations/${elevatorLocationId}/floor-access`, {
			method: "PUT",
			body: JSON.stringify({ assignments: restoreAssignments }),
		});
		console.log(`✓ restored elevator floor access (${elevatorLocationId})`);
	}
}

async function run() {
	console.log(`API base: ${API_BASE}`);
	const token = await login();
	console.log("✓ login\n");

	await testLocationMembersApplyAndSync(token);
	console.log("");
	await testGroupMembersModify(token);
	console.log("");
	await testElevatorFloorAccessApplyAndSync(token);

	console.log("\npersonnelMembersApplyAndSyncApi tests passed");
}

run().catch((err) => {
	console.error(err);
	process.exit(1);
});
