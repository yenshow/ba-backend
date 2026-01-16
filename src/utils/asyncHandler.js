/**
 * 異步處理包裝器
 * 
 * 自動捕獲異步路由處理器中的錯誤，避免在每個路由中手動 try-catch
 * 
 * 使用範例：
 * router.get("/users", asyncHandler(async (req, res, next) => {
 *   const users = await userService.getUsers();
 *   res.json(users);
 * }));
 */

/**
 * 包裝異步路由處理器，自動捕獲錯誤
 * @param {Function} fn - 異步路由處理器函數
 * @returns {Function} Express 路由處理器
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    // 如果函數返回 Promise，自動捕獲錯誤並傳遞給錯誤處理中間件
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;

