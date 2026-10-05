/**
 * A21-06-ADP-33（Modbus Register List V1.11）完整 Metering／EMS 探測
 *
 * 量測值一律以 IEEE-754 浮點解碼：
 *   FLOAT32（2 暫存器）／FLOAT64（4 暫存器），預設字序 Big-Endian（手冊 0x000F bit0=0）。
 *
 * BA 能源 ★：
 *   active_power  ← 0x1032 FLOAT32(W)  /1000 → kW
 *   active_energy ← 0x1400 FLOAT64(kWh)
 *   demand        ← 0x3006 FLOAT32(W)  /1000 → kW
 *
 * 用法：
 *   node scripts/probeA21EnergyRegisters.js <host> [port=502] [unitId=1]
 *   npm run probe:a21-energy -- 192.168.2.211 502 1
 *
 * 環境變數：
 *   A21_WORD_ORDER=be|le|both   浮點字序（預設 be）
 *   A21_MD=0                    設為 0 關閉寫入 Markdown 報告（預設寫入）
 *   A21_MD_PATH=<path>          自訂報告路徑
 *   A21_JSON=1                  額外輸出 JSON
 */

const fs = require("fs");
const path = require("path");
const net = require("net");
const ModbusRTU = require("modbus-serial");

const [host, portArg = "502", unitArg = "1"] = process.argv.slice(2);
const port = Number(portArg) || 502;
const unitId = Number(unitArg) || 1;
const wordOrderMode = String(process.env.A21_WORD_ORDER || "be").toLowerCase();
const emitJson = process.env.A21_JSON === "1";
const writeMd = process.env.A21_MD !== "0";

if (!host) {
	console.log(`
用法: node scripts/probeA21EnergyRegisters.js <host> [port=502] [unitId=1]

範例:
  npm run probe:a21-energy -- 192.168.2.211 502 1
  A21_WORD_ORDER=be npm run probe:a21-energy -- 192.168.2.211

說明:
  以 FLOAT32／FLOAT64（預設 BE）讀取 Metering／EMS 欄位，並寫入 Markdown 報告。
`);
	process.exit(1);
}

/** @typedef {'float32'|'float64'|'uint16'} DecodeKind */

/**
 * @typedef {{
 *   key: string,
 *   label: string,
 *   hex: number,
 *   length: number,
 *   kind: DecodeKind,
 *   unit: string,
 *   group: string,
 *   ba?: string|null,
 *   required?: boolean,
 *   toBa?: (v: number) => { value: number, unit: string, transform: string },
 *   note?: string,
 * }} FieldDef
 */

/** @type {FieldDef[]} */
const FIELDS = [
	{ key: "v1", label: "V1", hex: 0x1000, length: 2, kind: "float32", unit: "V", group: "Voltage" },
	{ key: "v2", label: "V2", hex: 0x1002, length: 2, kind: "float32", unit: "V", group: "Voltage" },
	{ key: "v3", label: "V3", hex: 0x1004, length: 2, kind: "float32", unit: "V", group: "Voltage" },
	{ key: "vln", label: "VLN", hex: 0x1006, length: 2, kind: "float32", unit: "V", group: "Voltage" },
	{ key: "v12", label: "V12", hex: 0x1008, length: 2, kind: "float32", unit: "V", group: "Voltage" },
	{ key: "v23", label: "V23", hex: 0x100a, length: 2, kind: "float32", unit: "V", group: "Voltage" },
	{ key: "v31", label: "V31", hex: 0x100c, length: 2, kind: "float32", unit: "V", group: "Voltage" },
	{ key: "vll", label: "VLL", hex: 0x100e, length: 2, kind: "float32", unit: "V", group: "Voltage" },

	{ key: "i1", label: "I1", hex: 0x1010, length: 2, kind: "float32", unit: "A", group: "Current" },
	{ key: "i2", label: "I2", hex: 0x1012, length: 2, kind: "float32", unit: "A", group: "Current" },
	{ key: "i3", label: "I3", hex: 0x1014, length: 2, kind: "float32", unit: "A", group: "Current" },
	{ key: "iavg", label: "Iavg", hex: 0x1016, length: 2, kind: "float32", unit: "A", group: "Current" },
	{ key: "in", label: "In", hex: 0x1018, length: 2, kind: "float32", unit: "A", group: "Current" },

	{ key: "freq", label: "Freq", hex: 0x101a, length: 2, kind: "float32", unit: "Hz", group: "Item" },
	{ key: "pf1", label: "PF1", hex: 0x101c, length: 2, kind: "float32", unit: "--", group: "Power_Factor" },
	{ key: "pf2", label: "PF2", hex: 0x101e, length: 2, kind: "float32", unit: "--", group: "Power_Factor" },
	{ key: "pf3", label: "PF3", hex: 0x1020, length: 2, kind: "float32", unit: "--", group: "Power_Factor" },
	{ key: "pfavg", label: "PFavg", hex: 0x1022, length: 2, kind: "float32", unit: "--", group: "Power_Factor" },

	{ key: "p1", label: "P1", hex: 0x102c, length: 2, kind: "float32", unit: "W", group: "Active_Power" },
	{ key: "p2", label: "P2", hex: 0x102e, length: 2, kind: "float32", unit: "W", group: "Active_Power" },
	{ key: "p3", label: "P3", hex: 0x1030, length: 2, kind: "float32", unit: "W", group: "Active_Power" },
	{
		key: "psum",
		label: "Psum ★",
		hex: 0x1032,
		length: 2,
		kind: "float32",
		unit: "W",
		group: "Active_Power",
		ba: "active_power",
		required: true,
		toBa: (v) => ({ value: v / 1000, unit: "kW", transform: "value / 1000" }),
	},
	{ key: "q1", label: "Q1", hex: 0x1034, length: 2, kind: "float32", unit: "VAR", group: "Reactive_Power" },
	{ key: "q2", label: "Q2", hex: 0x1036, length: 2, kind: "float32", unit: "VAR", group: "Reactive_Power" },
	{ key: "q3", label: "Q3", hex: 0x1038, length: 2, kind: "float32", unit: "VAR", group: "Reactive_Power" },
	{ key: "qsum", label: "Qsum", hex: 0x103a, length: 2, kind: "float32", unit: "VAR", group: "Reactive_Power" },
	{ key: "s1", label: "S1", hex: 0x103c, length: 2, kind: "float32", unit: "VA", group: "Apparent_Power" },
	{ key: "s2", label: "S2", hex: 0x103e, length: 2, kind: "float32", unit: "VA", group: "Apparent_Power" },
	{ key: "s3", label: "S3", hex: 0x1040, length: 2, kind: "float32", unit: "VA", group: "Apparent_Power" },
	{ key: "ssum", label: "Ssum", hex: 0x1042, length: 2, kind: "float32", unit: "VA", group: "Apparent_Power" },

	{ key: "ang_v2_v1", label: "V2:V1", hex: 0x1080, length: 2, kind: "float32", unit: "°", group: "Phase" },
	{ key: "ang_v3_v1", label: "V3:V1", hex: 0x1082, length: 2, kind: "float32", unit: "°", group: "Phase" },
	{ key: "ang_i1_v1", label: "I1:V1", hex: 0x1084, length: 2, kind: "float32", unit: "°", group: "Phase" },
	{ key: "ang_i2_v1", label: "I2:V1", hex: 0x1086, length: 2, kind: "float32", unit: "°", group: "Phase" },
	{ key: "ang_i3_v1", label: "I3:V1", hex: 0x1088, length: 2, kind: "float32", unit: "°", group: "Phase" },

	{
		key: "load_type",
		label: "Load Type",
		hex: 0x10a0,
		length: 2,
		kind: "float32",
		unit: "--",
		group: "Item",
		note: "R≈82 L≈76 C≈67（手冊）",
	},
	{ key: "run_hour", label: "Run Hour", hex: 0x0f00, length: 2, kind: "float32", unit: "min", group: "Item", note: "操作時間(min)" },
	{ key: "rr_time", label: "RR Time", hex: 0x0f02, length: 2, kind: "float32", unit: "min", group: "Item", note: "運轉時間(min)" },
	{ key: "co2", label: "CO2", hex: 0x0f06, length: 2, kind: "float32", unit: "Kg", group: "Item" },
	{ key: "cost", label: "Cost", hex: 0x0f08, length: 2, kind: "float32", unit: "--", group: "Item" },

	{
		key: "kwh_imp",
		label: "kWh_IMP ★",
		hex: 0x1400,
		length: 4,
		kind: "float64",
		unit: "kWh",
		group: "Energy",
		ba: "active_energy",
		required: true,
		toBa: (v) => ({ value: v, unit: "kWh", transform: "value" }),
	},
	{ key: "kwh_exp", label: "kWh_Exp", hex: 0x1404, length: 4, kind: "float64", unit: "kWh", group: "Energy" },
	{ key: "kwh_total", label: "kWh_Total", hex: 0x1408, length: 4, kind: "float64", unit: "kWh", group: "Energy" },
	{ key: "kwh_net", label: "kWh_Net", hex: 0x140c, length: 4, kind: "float64", unit: "kWh", group: "Energy" },
	{ key: "kvarh_imp", label: "kVARh_IMP", hex: 0x1410, length: 4, kind: "float64", unit: "kVARh", group: "Energy" },
	{ key: "kvarh_exp", label: "kVARh_Exp", hex: 0x1414, length: 4, kind: "float64", unit: "kVARh", group: "Energy" },
	{ key: "kvarh_total", label: "kVARh_Total", hex: 0x1418, length: 4, kind: "float64", unit: "kVARh", group: "Energy" },
	{ key: "kvarh_net", label: "kVARh_Net", hex: 0x141c, length: 4, kind: "float64", unit: "kVARh", group: "Energy" },
	{ key: "kvah_imp", label: "kVAh_IMP", hex: 0x1420, length: 4, kind: "float64", unit: "kVAh", group: "Energy" },
	{ key: "kvah_exp", label: "kVAh_Exp", hex: 0x1424, length: 4, kind: "float64", unit: "kVAh", group: "Energy" },
	{ key: "kvah_total", label: "kVAh_Total", hex: 0x1428, length: 4, kind: "float64", unit: "kVAh", group: "Energy" },
	{ key: "kvah_net", label: "kVAh_Net", hex: 0x142c, length: 4, kind: "float64", unit: "kVAh", group: "Energy" },

	{
		key: "demand_psum",
		label: "Psum.DM ★",
		hex: 0x3006,
		length: 2,
		kind: "float32",
		unit: "W",
		group: "Demand",
		ba: "demand",
		required: true,
		toBa: (v) => ({ value: v / 1000, unit: "kW", transform: "value / 1000" }),
	},
	{ key: "demand_qsum", label: "Qsum.DM", hex: 0x300e, length: 2, kind: "float32", unit: "VAR", group: "Demand" },
	{ key: "demand_ssum", label: "Ssum.DM", hex: 0x3016, length: 2, kind: "float32", unit: "VA", group: "Demand" },
	{ key: "demand_iavg", label: "Iavg.DM", hex: 0x301e, length: 2, kind: "float32", unit: "A", group: "Demand" },

	{
		key: "byte_order",
		label: "ByteOrder 0x000F",
		hex: 0x000f,
		length: 1,
		kind: "uint16",
		unit: "--",
		group: "Config",
		note: "bit0 浮點 0:BE 1:LE",
	},
	{
		key: "wrong_addr5",
		label: "PDU5 CT二次側(誤)",
		hex: 0x0005,
		length: 1,
		kind: "uint16",
		unit: "--",
		group: "Config",
		note: "舊型號位址 5，非電能",
	},
	{
		key: "wrong_addr6",
		label: "PDU6 密碼(誤)",
		hex: 0x0006,
		length: 1,
		kind: "uint16",
		unit: "--",
		group: "Config",
		note: "舊型號位址 6，非功率",
	},
];

const GROUP_ORDER = [
	"Voltage",
	"Current",
	"Power_Factor",
	"Active_Power",
	"Reactive_Power",
	"Apparent_Power",
	"Phase",
	"Item",
	"Energy",
	"Demand",
	"Config",
];

const BATCHES = [
	{ name: "instant_0x1000", start: 0x1000, length: 0x44 },
	{ name: "phase_0x1080", start: 0x1080, length: 10 },
	{ name: "load_0x10A0", start: 0x10a0, length: 2 },
	{ name: "item_0x0F00", start: 0x0f00, length: 10 },
	{ name: "energy_0x1400", start: 0x1400, length: 0x30 },
	{ name: "demand_0x3006", start: 0x3006, length: 0x1a },
	{ name: "config_0x0005", start: 0x0005, length: 11 },
];

const testTCPConnection = () =>
	new Promise((resolve) => {
		const socket = new net.Socket();
		socket.setTimeout(3000);
		socket.on("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.on("timeout", () => {
			socket.destroy();
			resolve(false);
		});
		socket.on("error", () => resolve(false));
		socket.connect(port, host);
	});

/** IEEE-754 float32：2×uint16，wordOrder be＝高字在前 */
const decodeFloat32 = (regs, wordOrder) => {
	if (!Array.isArray(regs) || regs.length < 2) return null;
	const w = wordOrder === "be" ? [regs[0], regs[1]] : [regs[1], regs[0]];
	const buf = Buffer.alloc(4);
	buf.writeUInt16BE(w[0] & 0xffff, 0);
	buf.writeUInt16BE(w[1] & 0xffff, 2);
	return buf.readFloatBE(0);
};

/** IEEE-754 float64：4×uint16 */
const decodeFloat64 = (regs, wordOrder) => {
	if (!Array.isArray(regs) || regs.length < 4) return null;
	const w =
		wordOrder === "be"
			? regs.slice(0, 4)
			: [regs[3], regs[2], regs[1], regs[0]];
	const buf = Buffer.alloc(8);
	for (let i = 0; i < 4; i++) buf.writeUInt16BE(w[i] & 0xffff, i * 2);
	return buf.readDoubleBE(0);
};

const decodeValue = (raw, kind, wordOrder) => {
	if (kind === "uint16") return Array.isArray(raw) ? Number(raw[0]) : Number(raw);
	const regs = Array.isArray(raw) ? raw : [raw];
	if (kind === "float32") return decodeFloat32(regs, wordOrder);
	if (kind === "float64") return decodeFloat64(regs, wordOrder);
	return null;
};

const fmt = (n, digits = 3) => {
	if (n == null || Number.isNaN(n)) return "—";
	if (!Number.isFinite(n)) return String(n);
	const abs = Math.abs(n);
	if (abs !== 0 && (abs < 1e-4 || abs >= 1e7)) return n.toExponential(4);
	return Number(n.toFixed(digits)).toString();
};

const loadTypeLabel = (v) => {
	if (v == null || !Number.isFinite(v)) return "";
	const n = Math.round(v);
	if (n === 82) return "R";
	if (n === 76) return "L";
	if (n === 67) return "C";
	return `raw=${fmt(v, 1)}`;
};

const isSaneFloat = (n) =>
	typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 1e12;

async function readHolding(client, address, length) {
	const res = await client.readHoldingRegisters(address, length);
	return res?.data || [];
}

const sliceRegs = (regMap, field) => {
	const out = [];
	for (let i = 0; i < field.length; i++) {
		const addr = field.hex + i;
		if (!regMap.has(addr)) return null;
		out.push(regMap.get(addr));
	}
	return out;
};

const displayValue = (row, v) => {
	if (row.key === "load_type") return loadTypeLabel(v) || fmt(v, 2);
	if (row.key === "run_hour" || row.key === "rr_time") {
		if (typeof v === "number" && Number.isFinite(v)) {
			return `${fmt(v, 0)} min (${fmt(v / 60, 1)} h)`;
		}
	}
	const digits = row.unit === "Hz" || row.unit === "A" ? 3 : 2;
	return fmt(v, digits);
};

const defaultMdPath = () => {
	const stamp = new Date()
		.toISOString()
		.replace(/[:.]/g, "-")
		.replace("T", "_")
		.slice(0, 19);
	const dir = path.join(__dirname, "reports");
	return path.join(dir, `a21-energy-probe-${stamp}.md`);
};

/**
 * @param {object} ctx
 */
const buildMarkdown = (ctx) => {
	const { rows, bestOrder, batchErrors, probedAt } = ctx;
	const lines = [];
	lines.push(`# A21-06-ADP-33 能源／Metering 探測報告`);
	lines.push("");
	lines.push(`- **時間**：${probedAt}`);
	lines.push(`- **設備**：\`${host}:${port}\`　Unit ID=\`${unitId}\``);
	lines.push(`- **解碼**：IEEE-754 **FLOAT32／FLOAT64**，字序 **${bestOrder.toUpperCase()}**`);
	lines.push(`- **手冊**：A21-06-ADP-33 Modbus Register List TC V1.11`);
	lines.push(`- **腳本**：\`ba-backend/scripts/probeA21EnergyRegisters.js\``);
	lines.push("");
	lines.push(`## 結論`);
	lines.push("");
	lines.push(`| 項目 | 結果 |`);
	lines.push(`|------|------|`);
	lines.push(`| Modbus 連線 | ${batchErrors.length === BATCHES.length ? "失敗" : "成功"} |`);
	lines.push(`| 浮點解碼 | FLOAT32／FLOAT64（${bestOrder.toUpperCase()}） |`);
	lines.push(`| Batch 錯誤 | ${batchErrors.length ? batchErrors.join("；") : "無"} |`);
	const v1 = rows.find((r) => r.key === "v1")?.decoded?.[bestOrder];
	const freq = rows.find((r) => r.key === "freq")?.decoded?.[bestOrder];
	const psum = rows.find((r) => r.key === "psum")?.decoded?.[bestOrder];
	lines.push(`| 交叉驗證提示 | V1=${fmt(v1, 2)} V、Freq=${fmt(freq, 3)} Hz、Psum=${fmt(psum, 2)} W |`);
	lines.push("");
	lines.push(`## BA 能源 ★ 必要項`);
	lines.push("");
	lines.push(`| BA 參數 | 手冊項目 | HEX | 型別 | 原始值 | BA 換算 | 轉換 |`);
	lines.push(`|---------|----------|-----|------|--------|---------|------|`);
	for (const row of rows.filter((r) => r.required && r.ba)) {
		const v = row.decoded[bestOrder];
		const ba =
			row.toBa && typeof v === "number" && Number.isFinite(v) ? row.toBa(v) : null;
		lines.push(
			`| \`${row.ba}\` | ${row.label} | \`0x${row.hex.toString(16).toUpperCase()}\` | ${row.kind} | ${fmt(v, 4)} ${row.unit} | ${ba ? `${fmt(ba.value, 4)} ${ba.unit}` : "—"} | \`${ba?.transform || "—"}\` |`,
		);
	}
	lines.push("");
	lines.push(`## 建議型號設定（須平台支援 float）`);
	lines.push("");
	lines.push("```text");
	lines.push("active_power   address=0x1032  dataType=float32_be  length=2  transform=value / 1000  # kW");
	lines.push("active_energy  address=0x1400  dataType=float64_be  length=4  transform=value         # kWh");
	lines.push("demand         address=0x3006  dataType=float32_be  length=2  transform=value / 1000  # kW");
	lines.push("```");
	lines.push("");
	lines.push(`> 目前 BA catalog 僅 uint16／uint32；正式輪詢前需擴充 float 解碼。`);
	lines.push("");

	for (const group of GROUP_ORDER) {
		const groupRows = rows.filter((r) => r.group === group);
		if (groupRows.length === 0) continue;
		lines.push(`## ${group}`);
		lines.push("");
		lines.push(`| 欄位 | 數值 | 單位 | HEX | 型別 | 備註 |`);
		lines.push(`|------|------|------|-----|------|------|`);
		for (const row of groupRows) {
			if (row.errMsg) {
				lines.push(
					`| ${row.label} | ERR | ${row.unit} | \`0x${row.hex.toString(16).toUpperCase()}\` | ${row.kind} | ${row.errMsg} |`,
				);
				continue;
			}
			const v = row.decoded[bestOrder];
			const extra =
				row.toBa && typeof v === "number" && Number.isFinite(v)
					? `BA ${fmt(row.toBa(v).value, 3)} ${row.toBa(v).unit}`
					: row.note || "";
			const warn = row.kind !== "uint16" && !isSaneFloat(v) ? " ⚠" : "";
			lines.push(
				`| ${row.label} | ${displayValue(row, v)}${warn} | ${row.unit} | \`0x${row.hex.toString(16).toUpperCase()}\` | ${row.kind} | ${extra} |`,
			);
		}
		lines.push("");
	}

	lines.push(`## 錯誤對照（舊設定）`);
	lines.push("");
	lines.push(`先前型號位址 5／6 對應設定區，非量測 float：`);
	lines.push("");
	lines.push(`| PDU | 手冊意義 | 本次讀值 |`);
	lines.push(`|-----|----------|----------|`);
	const a5 = rows.find((r) => r.key === "wrong_addr5");
	const a6 = rows.find((r) => r.key === "wrong_addr6");
	lines.push(`| 5 | CT 二次側 | ${fmt(a5?.decoded?.[bestOrder], 0)} |`);
	lines.push(`| 6 | 修改密碼 | ${fmt(a6?.decoded?.[bestOrder], 0)} |`);
	lines.push("");
	lines.push(`---`);
	lines.push(`*由 \`probeA21EnergyRegisters.js\` 自動產生*`);
	lines.push("");
	return lines.join("\n");
};

async function main() {
	const probedAt = new Date().toISOString();
	console.log("\nA21-06-ADP-33 Metering／EMS 探測（FLOAT）");
	console.log("═".repeat(72));
	console.log(`設備：${host}:${port}  Unit ID=${unitId}  字序=${wordOrderMode}`);
	console.log("解碼：IEEE-754 FLOAT32／FLOAT64\n");

	const tcpOk = await testTCPConnection();
	if (!tcpOk) {
		console.error("✗ TCP 連線失敗");
		process.exit(1);
	}
	console.log("✓ TCP 連線成功");

	const client = new ModbusRTU();
	try {
		await client.connectTCP(host, { port });
		client.setID(unitId);
		client.setTimeout(4000);
		console.log("✓ Modbus TCP 已連線\n");
	} catch (err) {
		console.error("✗ Modbus 連線失敗：", err.message);
		process.exit(1);
	}

	/** @type {Map<number, number>} */
	const regMap = new Map();
	const batchErrors = [];

	for (const batch of BATCHES) {
		try {
			const data = await readHolding(client, batch.start, batch.length);
			for (let i = 0; i < data.length; i++) {
				regMap.set(batch.start + i, data[i]);
			}
			console.log(
				`✓ batch ${batch.name}  0x${batch.start.toString(16).toUpperCase()}×${batch.length}`,
			);
		} catch (err) {
			batchErrors.push(`${batch.name}: ${err.message}`);
			console.log(`✗ batch ${batch.name}  ${err.message}`);
		}
		await new Promise((r) => setTimeout(r, 60));
	}

	if (client.isOpen) await client.close();

	const orders =
		wordOrderMode === "be"
			? ["be"]
			: wordOrderMode === "le"
				? ["le"]
				: ["be", "le"];

	const rows = [];
	for (const field of FIELDS) {
		const raw = sliceRegs(regMap, field);
		const errMsg = raw ? null : "暫存器未讀到（batch 失敗或位址超出）";
		const decoded = {};
		for (const order of orders) {
			decoded[order] = errMsg ? null : decodeValue(raw, field.kind, order);
		}
		rows.push({ ...field, raw, errMsg, decoded });
	}

	const pickOrder = () => {
		const cfgRow = rows.find((r) => r.key === "byte_order");
		const cfg = cfgRow?.decoded?.be ?? cfgRow?.decoded?.le ?? cfgRow?.decoded?.[orders[0]];
		if (typeof cfg === "number" && Number.isFinite(cfg)) {
			return (cfg & 0x1) === 1 ? "le" : "be";
		}
		const freq = rows.find((r) => r.key === "freq");
		for (const order of orders) {
			const f = freq?.decoded?.[order];
			if (typeof f === "number" && f > 45 && f < 65) return order;
		}
		const v1 = rows.find((r) => r.key === "v1");
		for (const order of orders) {
			const v = v1?.decoded?.[order];
			if (typeof v === "number" && v > 50 && v < 600) return order;
		}
		return orders[0];
	};

	const bestOrder = /** @type {'be'|'le'} */ (
		wordOrderMode === "both" ? pickOrder() : wordOrderMode === "le" ? "le" : "be"
	);
	// 若強制 be 但設備設為 LE，用設定暫存器提示
	const cfgVal = rows.find((r) => r.key === "byte_order")?.decoded?.[bestOrder];
	console.log(`\n浮點字序：${bestOrder.toUpperCase()}（FLOAT32／FLOAT64）`);
	if (typeof cfgVal === "number") {
		const deviceFloatLe = (cfgVal & 0x1) === 1;
		if (deviceFloatLe && bestOrder === "be") {
			console.log("⚠ 設備 0x000F bit0=1（浮點 LE），與目前 BE 解碼不一致");
		}
	}
	console.log("");

	const pad = (s, n) => String(s).padEnd(n);
	const padL = (s, n) => String(s).padStart(n);

	for (const group of GROUP_ORDER) {
		const groupRows = rows.filter((r) => r.group === group);
		if (groupRows.length === 0) continue;
		console.log(`── ${group} ${"─".repeat(Math.max(0, 60 - group.length))}`);
		console.log(
			`  ${pad("欄位", 14)} ${padL("數值", 14)} ${pad("單位", 6)}  HEX     型別`,
		);
		for (const row of groupRows) {
			if (row.errMsg) {
				console.log(
					`  ${pad(row.label, 14)} ${padL("ERR", 14)} ${pad(row.unit, 6)}  0x${row.hex.toString(16).toUpperCase().padStart(4, "0")}  ${row.errMsg}`,
				);
				continue;
			}
			const v = row.decoded[bestOrder];
			const extra =
				row.toBa && typeof v === "number" && Number.isFinite(v)
					? ` → BA ${fmt(row.toBa(v).value, 3)} ${row.toBa(v).unit}`
					: "";
			const warn = row.kind !== "uint16" && !isSaneFloat(v) ? " ⚠" : "";
			console.log(
				`  ${pad(row.label, 14)} ${padL(displayValue(row, v) + warn, 14)} ${pad(row.unit, 6)}  0x${row.hex.toString(16).toUpperCase().padStart(4, "0")}  ${row.kind}${extra}`,
			);
		}
		console.log("");
	}

	console.log("═".repeat(72));
	console.log("BA 能源 ★（float 解碼）");
	console.log("═".repeat(72));
	for (const row of rows.filter((r) => r.required && r.ba)) {
		const v = row.decoded[bestOrder];
		const ba =
			row.toBa && typeof v === "number" && Number.isFinite(v)
				? row.toBa(v)
				: null;
		console.log(
			`  ${pad(row.ba, 14)} ← ${row.label} @ 0x${row.hex.toString(16).toUpperCase()} (${row.kind})` +
				(ba ? `  ≈ ${fmt(ba.value, 3)} ${ba.unit}` : row.errMsg ? `  ✗ ${row.errMsg}` : ""),
		);
	}
	console.log(`\nbatch 錯誤：${batchErrors.length ? batchErrors.join("；") : "無"}`);

	if (writeMd) {
		const mdPath = process.env.A21_MD_PATH
			? path.resolve(process.env.A21_MD_PATH)
			: defaultMdPath();
		fs.mkdirSync(path.dirname(mdPath), { recursive: true });
		const md = buildMarkdown({ rows, bestOrder, batchErrors, probedAt });
		fs.writeFileSync(mdPath, md, "utf8");
		console.log(`\n✓ Markdown 報告：${mdPath}`);
	}

	if (emitJson) {
		const payload = {
			host,
			port,
			unitId,
			wordOrder: bestOrder,
			decode: "float32/float64",
			values: Object.fromEntries(
				rows.map((r) => [
					r.key,
					{
						label: r.label,
						hex: `0x${r.hex.toString(16)}`,
						unit: r.unit,
						group: r.group,
						kind: r.kind,
						ba: r.ba || null,
						value: r.decoded[bestOrder],
						error: r.errMsg,
					},
				]),
			),
		};
		console.log("\n--- JSON ---");
		console.log(JSON.stringify(payload, null, 2));
	}

	const failedRequired = rows.filter((r) => r.required && r.errMsg);
	process.exit(failedRequired.length > 0 || batchErrors.length === BATCHES.length ? 2 : 0);
}

main().catch((err) => {
	console.error("未預期錯誤：", err);
	process.exit(1);
});
