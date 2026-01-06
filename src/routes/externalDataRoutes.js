const express = require("express");
const router = express.Router();
const externalDataService = require("../services/externalDataService");
const { authenticate } = require("../middleware/authMiddleware");

/**
 * GET /api/external-data/tables
 * 取得所有資料表清單
 */
router.get("/tables", authenticate, async (req, res) => {
	try {
		const tables = await externalDataService.getTables();
		res.json({ success: true, data: tables });
	} catch (error) {
		console.error("取得資料表清單失敗:", error);
		res.status(500).json({ 
			success: false, 
			message: "取得資料表清單失敗", 
			error: error.message 
		});
	}
});

/**
 * GET /api/external-data/tables/:tableName/schema
 * 取得指定資料表的結構
 */
router.get("/tables/:tableName/schema", authenticate, async (req, res) => {
	try {
		const { tableName } = req.params;
		const schema = await externalDataService.getTableSchema(tableName);
		res.json({ success: true, data: schema });
	} catch (error) {
		console.error("取得資料表結構失敗:", error);
		res.status(500).json({ 
			success: false, 
			message: "取得資料表結構失敗", 
			error: error.message 
		});
	}
});

/**
 * GET /api/external-data/tables/:tableName/data
 * 取得指定資料表的資料
 */
router.get("/tables/:tableName/data", authenticate, async (req, res) => {
	try {
		const { tableName } = req.params;
		const { 
			limit = 100, 
			offset = 0, 
			orderBy, 
			orderDirection = "ASC" 
		} = req.query;
		
		const [data, count] = await Promise.all([
			externalDataService.getTableData(tableName, {
				limit: parseInt(limit),
				offset: parseInt(offset),
				orderBy,
				orderDirection
			}),
			externalDataService.getTableCount(tableName)
		]);
		
		res.json({ 
			success: true, 
			data,
			pagination: {
				total: parseInt(count),
				limit: parseInt(limit),
				offset: parseInt(offset)
			}
		});
	} catch (error) {
		console.error("取得資料表資料失敗:", error);
		res.status(500).json({ 
			success: false, 
			message: "取得資料表資料失敗", 
			error: error.message 
		});
	}
});

/**
 * POST /api/external-data/query
 * 執行自訂 SQL 查詢
 */
router.post("/query", authenticate, async (req, res) => {
	try {
		const { sql, params = [] } = req.body;
		
		if (!sql) {
			return res.status(400).json({ 
				success: false, 
				message: "請提供 SQL 查詢語句" 
			});
		}
		
		const result = await externalDataService.executeQuery(sql, params);
		res.json({ success: true, data: result });
	} catch (error) {
		console.error("執行查詢失敗:", error);
		res.status(500).json({ 
			success: false, 
			message: "執行查詢失敗", 
			error: error.message 
		});
	}
});

module.exports = router;

