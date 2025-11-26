const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const config = require("./config");
const modbusRoutes = require("./routes/modbusRoutes");

const app = express();

app.use(cors());
app.use(express.json());
// 過濾掉 /ws 請求的日誌，避免日誌被刷屏
app.use(
	morgan("dev", {
		skip: (req) => req.url === "/ws"
	})
);

app.use("/api/modbus", modbusRoutes);

// 處理 WebSocket 升級請求（來自 Nuxt Content 熱重載等）
// 靜默返回 404，不記錄日誌
app.get("/ws", (_req, res) => {
	res.status(404).end();
});

app.use((err, _req, res, _next) => {
	// eslint-disable-next-line no-console
	console.error(err);
	res.status(500).json({
		message: "Modbus request failed",
		details: err.message
	});
});

app.listen(config.serverPort, () => {
	// eslint-disable-next-line no-console
	console.log(`Modbus test backend listening on port ${config.serverPort}`);
});
