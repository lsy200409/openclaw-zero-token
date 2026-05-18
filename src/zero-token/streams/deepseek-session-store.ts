/**
 * DeepSeek Session Persistence Store
 *
 * Persists DeepSeek chat_session_id / parent_message_id mappings to disk
 * so they survive process restarts. On next startup, the stored session IDs
 * are loaded and the client attempts to reconnect. If the session is no
 * longer valid on DeepSeek's side (e.g. expired or deleted), a new session
 * is created automatically.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { writeTextAtomic } from "../../infra/json-files.js";

interface DeepSeekSessionData {
  /** Maps sessionKey → DeepSeek chat_session_id */
  sessionMap: Record<string, string>;
  /** Maps sessionKey → last parent_message_id (for multi-turn continuity) */
  parentMessageMap: Record<string, string | number>;
}

const DEFAULT_STORE: DeepSeekSessionData = {
  sessionMap: {},
  parentMessageMap: {},
};

function resolveStorePath(): string {
  if (process.env.DEEPSEEK_SESSION_STORE_PATH) {
    return process.env.DEEPSEEK_SESSION_STORE_PATH;
  }
  const home = os.homedir();
  const dir = path.join(home, ".openclaw-zero", "workspace", "zero-token");
  return path.join(dir, "deepseek-sessions.json");
}

let _storePath: string | null = null;

function getStorePath(): string {
  if (!_storePath) {
    _storePath = resolveStorePath();
  }
  return _storePath;
}

function loadFromDisk(): DeepSeekSessionData {
  const filePath = getStorePath();
  try {
    if (!fs.existsSync(filePath)) {
      return { ...DEFAULT_STORE };
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { ...DEFAULT_STORE };
    }
    return {
      sessionMap:
        parsed.sessionMap && typeof parsed.sessionMap === "object"
          ? { ...parsed.sessionMap }
          : {},
      parentMessageMap:
        parsed.parentMessageMap && typeof parsed.parentMessageMap === "object"
          ? { ...parsed.parentMessageMap }
          : {},
    };
  } catch {
    return { ...DEFAULT_STORE };
  }
}

/**
 * In-memory cache. On first access, loads from disk.
 * On each save, updates in-memory and writes to disk atomically.
 */
let _cached: DeepSeekSessionData | null = null;

function getCached(): DeepSeekSessionData {
  if (!_cached) {
    _cached = loadFromDisk();
  }
  return _cached;
}

async function persist(): Promise<void> {
  const filePath = getStorePath();
  const data = getCached();
  const json = JSON.stringify(data, null, 2);
  await writeTextAtomic(filePath, json, { mode: 0o600 });
}

/**
 * Load persisted session IDs from disk.
 * Called once at module init / stream factory creation.
 */
export function loadDeepseekSessions(): DeepSeekSessionData {
  return getCached();
}

/**
 * Save or update a session mapping entry.
 */
export async function saveDeepseekSessionEntry(
  sessionKey: string,
  dsSessionId: string,
  parentMessageId?: string | number | null,
): Promise<void> {
  const cached = getCached();
  cached.sessionMap[sessionKey] = dsSessionId;
  if (parentMessageId != null) {
    cached.parentMessageMap[sessionKey] = parentMessageId;
  }
  await persist();
}

/**
 * Save parent message ID for a session.
 */
export async function saveDeepseekParentMessageId(
  sessionKey: string,
  parentMessageId: string | number,
): Promise<void> {
  const cached = getCached();
  cached.parentMessageMap[sessionKey] = parentMessageId;
  await persist();
}

/**
 * Remove a session entry (e.g. on biz_code error / session invalid).
 */
export async function removeDeepseekSessionEntry(
  sessionKey: string,
): Promise<void> {
  const cached = getCached();
  delete cached.sessionMap[sessionKey];
  delete cached.parentMessageMap[sessionKey];
  await persist();
}

/**
 * Reload from disk (use after external modifications).
 */
export function reloadDeepseekSessions(): DeepSeekSessionData {
  _cached = loadFromDisk();
  return _cached;
}