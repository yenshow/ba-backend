/* eslint-disable no-console */
const fs = require("fs/promises");
const path = require("path");
const axios = require("axios");

const DEFAULT_API_BASE = "http://127.0.0.1:4000/api";

const parseArgs = (argv) => {
  const args = {};
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith("--")) continue;
    const s = raw.slice(2);
    const idx = s.indexOf("=");
    if (idx === -1) {
      args[s] = true;
      continue;
    }
    const k = s.slice(0, idx);
    const v = s.slice(idx + 1);
    args[k] = v;
  }
  return args;
};

const toInt = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

const envFlag = (name, defaultValue = false) => {
  const v = process.env[name];
  if (v == null) return defaultValue;
  const s = String(v).trim().toLowerCase();
  if (s === "1" || s === "true" || s === "yes" || s === "y") return true;
  if (s === "0" || s === "false" || s === "no" || s === "n") return false;
  return defaultValue;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ensureDir = async (dir) => {
  await fs.mkdir(dir, { recursive: true });
};

const nowKey = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};

const createLimiter = (concurrency) => {
  const limit = Math.max(1, toInt(concurrency, 10));
  let active = 0;
  const queue = [];

  const runNext = () => {
    if (active >= limit) return;
    const next = queue.shift();
    if (!next) return;
    active += 1;
    const { fn, resolve, reject } = next;
    Promise.resolve()
      .then(fn)
      .then((v) => resolve(v))
      .catch((e) => reject(e))
      .finally(() => {
        active -= 1;
        runNext();
      });
  };

  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      runNext();
    });
};

const unwrapData = (res) => {
  // sendSuccess -> { success, data, timestamp }
  if (res && typeof res === "object" && "data" in res) return res.data;
  return res;
};

const createClient = ({ apiBase, token }) => {
  const instance = axios.create({
    baseURL: String(apiBase || DEFAULT_API_BASE).replace(/\/+$/, ""),
    timeout: 30000,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    validateStatus: () => true,
  });

  const request = async (method, url, body) => {
    const resp = await instance.request({ method, url, data: body });
    if (resp.status >= 200 && resp.status < 300) return unwrapData(resp.data);
    const msg =
      resp?.data?.message ||
      resp?.data?.error?.message ||
      (typeof resp?.data === "string" ? resp.data : "") ||
      `HTTP ${resp.status}`;
    const err = new Error(`${method} ${url} failed: ${msg}`);
    err.status = resp.status;
    err.body = resp.data;
    throw err;
  };

  return {
    get: (url) => request("GET", url),
    post: (url, body) => request("POST", url, body),
    put: (url, body) => request("PUT", url, body),
    delete: (url) => request("DELETE", url),
  };
};

const login = async ({ apiBase, username, password }) => {
  const client = createClient({ apiBase, token: null });
  const result = await client.post("/users/login", { username, password });
  if (!result || !result.token) throw new Error("登入成功但缺少 token（/users/login 回傳異常）");
  return { token: String(result.token), user: result.user || null };
};

const defaultStateDir = () => path.join(process.cwd(), ".loadtest-state");

const writeJson = async (filePath, data) => {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
};

const readJson = async (filePath) => {
  const raw = await fs.readFile(filePath, "utf8");
  const obj = JSON.parse(raw);
  return obj && typeof obj === "object" ? obj : null;
};

module.exports = {
  DEFAULT_API_BASE,
  parseArgs,
  toInt,
  envFlag,
  sleep,
  ensureDir,
  nowKey,
  createLimiter,
  createClient,
  login,
  defaultStateDir,
  writeJson,
  readJson,
};

