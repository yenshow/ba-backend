const path = require('path');
const dotenv = require('dotenv');

dotenv.config({
  path: process.env.ENV_FILE || path.resolve(process.cwd(), '.env'),
});

const toNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

module.exports = {
  serverPort: toNumber(process.env.PORT, 4000),
  modbus: {
    host: process.env.MODBUS_HOST || '127.0.0.1',
    port: toNumber(process.env.MODBUS_PORT, 8502),
    unitId: toNumber(process.env.MODBUS_UNIT_ID, 1),
    timeout: toNumber(process.env.MODBUS_TIMEOUT, 2000),
    reconnectDelay: toNumber(process.env.MODBUS_RECONNECT_DELAY, 2000),
  },
};

