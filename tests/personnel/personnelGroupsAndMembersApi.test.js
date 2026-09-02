/**
 * 人員群組／地點名單 API 整合測試（不觸發設備同步）
 *
 *   node tests/personnel/personnelGroupsAndMembersApi.test.js
 *
 * 前置：後端已啟動（預設 http://127.0.0.1:4000）
 */
const assert = require("node:assert/strict");

const API_BASE = (process.env.BA_API_BASE || "http://127.0.0.1:4000/api").replace(/\/$/, "");
const USERNAME = process.env.BA_USERNAME || "admin";
const PASSWORD = process.env.BA_PASSWORD || "Aa83124007";

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

const findFirstChildGroup = (groups) => {
	const mains = Array.isArray(groups)
		? groups
		: Array.isArray(groups?.mains)
			? groups.mains
			: [];
	for (const main of mains) {
		const children = Array.isArray(main?.children) ? main.children : [];
		for (const child of children) {
			if (child?.id != null) return child;
		}
	}
	return null;
};

async function run() {
	console.log(`API base: ${API_BASE}`);
	const token = await login();
	console.log("✓ login");

	// --- 群組樹 ---
	const groups = await authFetch(token, "/personnel/groups?tree=true");
	assert.ok(groups, "groups response");
	const childGroup = findFirstChildGroup(groups);
	if (childGroup) {
		const memberIdsRes = await authFetch(token, `/personnel/groups/${childGroup.id}/member-ids`);
		const ids = Array.isArray(memberIdsRes?.ids) ? memberIdsRes.ids : [];
		assert.ok(Array.isArray(ids), "group member-ids should be array");
		console.log(`✓ GET /personnel/groups/${childGroup.id}/member-ids (${ids.length} members)`);

		const membersPage = await authFetch(
			token,
			`/personnel/groups/${childGroup.id}/members?limit=5&offset=0`,
		);
		const memberRows = membersPage?.items ?? membersPage?.persons ?? [];
		assert.ok(Array.isArray(memberRows), "members page shape");
		console.log(`✓ GET /personnel/groups/${childGroup.id}/members`);

		// members-batch 不可被 PUT /groups/:id 誤匹配（回傳 id 整數驗證錯誤）
		const batchRes = await authFetch(token, "/personnel/groups/members-batch", {
			method: "PUT",
			body: JSON.stringify({ assignments: { [childGroup.id]: ids } }),
		});
		assert.ok(Array.isArray(batchRes?.updatedChildIds), "members-batch updatedChildIds");
		assert.ok(
			batchRes.updatedChildIds.includes(childGroup.id),
			"members-batch should update child group",
		);
		console.log(`✓ PUT /personnel/groups/members-batch`);
	} else {
		console.log("⊘ skip group member tests (no child group)");
	}

	// --- 候選人員 ---
	const personsPage = await authFetch(token, "/personnel/persons?limit=5&offset=0&status=active");
	const persons = Array.isArray(personsPage?.items)
		? personsPage.items
		: Array.isArray(personsPage?.persons)
			? personsPage.persons
			: [];
	assert.ok(persons.length >= 0, "persons list");
	console.log(`✓ GET /personnel/persons (${persons.length} returned, total ${personsPage?.total ?? "?"})`);

	// --- 可同步地點（僅讀） ---
	const syncableRaw = await authFetch(token, "/personnel/syncable-locations");
	const locations = Array.isArray(syncableRaw?.locations)
		? syncableRaw.locations
		: Array.isArray(syncableRaw)
			? syncableRaw
			: [];
	console.log(`✓ GET /personnel/syncable-locations (${locations.length} locations)`);

	if (locations.length > 0) {
		const locationId = locations[0].id ?? locations[0].locationId;
		assert.ok(Number.isFinite(Number(locationId)), "location id");

		const memberIdsRes = await authFetch(token, `/personnel/locations/${locationId}/member-ids`);
		const currentIds = Array.isArray(memberIdsRes?.ids) ? memberIdsRes.ids : [];
		console.log(`✓ GET /personnel/locations/${locationId}/member-ids (${currentIds.length} members)`);

		// 往返：寫入相同名單（不呼叫 sync-location）
		const replaceRes = await authFetch(token, `/personnel/locations/${locationId}/members`, {
			method: "PUT",
			body: JSON.stringify({ memberPersonIds: currentIds }),
		});
		assert.ok(replaceRes, "replace location members");
		console.log(`✓ PUT /personnel/locations/${locationId}/members (round-trip, no device sync)`);

		// sync-candidates 僅讀（設備離線時仍應回傳候選結構或合理錯誤）
		try {
			const candidates = await authFetch(
				token,
				`/personnel/locations/${locationId}/sync-candidates`,
			);
			assert.ok(candidates != null, "sync-candidates response");
			console.log(`✓ GET /personnel/locations/${locationId}/sync-candidates`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (/設備|連線|offline|timeout|ECONNREFUSED/i.test(msg)) {
				console.log(`⊘ skip sync-candidates (device offline): ${msg.slice(0, 80)}`);
			} else {
				throw err;
			}
		}
	} else {
		console.log("⊘ skip location member tests (no syncable location)");
	}

	// --- 梯控樓層（Central feature；無地點時跳過） ---
	try {
		const elevatorLocsRaw = await authFetch(token, "/elevator/locations?limit=20&offset=0");
		const elevatorLocs = Array.isArray(elevatorLocsRaw?.locations)
			? elevatorLocsRaw.locations
			: Array.isArray(elevatorLocsRaw?.items)
				? elevatorLocsRaw.items
				: Array.isArray(elevatorLocsRaw)
					? elevatorLocsRaw
					: [];
		const elevatorId = elevatorLocs[0]?.id ?? elevatorLocs[0]?.locationId ?? null;

		if (elevatorId != null) {
			const floorAccess = await authFetch(token, `/elevator/locations/${elevatorId}/floor-access`);
			assert.ok(floorAccess != null, "floor-access response");
			console.log(`✓ GET /elevator/locations/${elevatorId}/floor-access`);
		} else {
			console.log("⊘ skip elevator floor-access (no elevator location)");
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (/FEATURE_NOT_LICENSED|403|404/.test(msg)) {
			console.log(`⊘ skip elevator tests: ${msg.slice(0, 80)}`);
		} else {
			throw err;
		}
	}

	console.log("\npersonnelGroupsAndMembersApi tests passed");
}

run().catch((err) => {
	console.error(err);
	process.exit(1);
});
