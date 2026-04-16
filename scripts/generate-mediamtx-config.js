/**
 * 由 DB devices(camera) 產生完整的 MediaMTX 設定檔（mediamtx.generated.yml）
 *
 * 使用情境：
 * - 本專案統一以 DB devices(camera) 產生 `mediamtx.generated.yml` 作為啟動設定
 * - 必須在啟動前把所有攝影機 paths 預先寫入 config，WHEP 才能成功
 */
async function main() {
  // eslint-disable-next-line global-require
  const sync = require("../src/services/communication/mediaMTXConfigSyncService");
  const { pathsCount } = await sync.generateConfigFile();
  console.log(`已產生 mediamtx\\mediamtx.generated.yml（paths=${pathsCount}）`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("產生 MediaMTX 設定失敗:", err?.message || err);
    process.exit(1);
  });

