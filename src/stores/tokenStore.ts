import { useLocalStorage } from "@vueuse/core";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
// 🔥 新增：引入 SocketIO
import { io, Socket } from "socket.io-client";

import { g_utils, ProtoMsg } from "@/utils/bonProtocol";
import { gameLogger, tokenLogger, wsLogger } from "@/utils/logger";
// 🔥 注释掉旧的自定义WebSocket（不再使用）
// import { XyzwWebSocketClient } from "@/utils/xyzwWebSocket";

import useIndexedDB from "@/hooks/useIndexedDB";
import { generateRandomSeed } from "@/utils/randomSeed";
import {
  transformToken,
  setAuthUserRateLimiterCallback,
  scheduleAuthUserRequest,
} from "@/utils/token";
import { emitPlus, $emit } from "./events/index.js";
import router from "@/router";

const { getArrayBuffer, storeArrayBuffer, deleteArrayBuffer, clearAll } =
  useIndexedDB();

declare interface TokenData {
  id: string;
  name: string;
  token: string;
  wsUrl: string | null;
  server: string;
  remark?: string;
  importMethod?: "manual" | "bin" | "url" | "wxQrcode";
  sourceUrl?: string;
  avatar?: string;
  upgradedToPermanent?: boolean;
  upgradedAt?: string;
  updatedAt?: string;
}

declare interface WebSocketConnection {
  status: "connecting" | "connected" | "disconnected" | "error";
  // 🔥 替换类型：XyzwWebSocketClient → Socket
  client: Socket | null;
  lastError: { timestamp: string; error: string } | null;
  tokenId: string;
  sessionId: string;
  createdAt: string;
  lastMessageAt: string | null;
  randomSeedSynced?: boolean;
  lastRandomSeedSource?: number | null;
  lastRandomSeed?: number | null;
  wsUrl?: string;
  actualToken?: string;
  connectedAt?: string | null;
  reconnectAttempts?: number;
  lastMessage?: any;
}

declare type WebCtx = Record<string, Partial<WebSocketConnection>>;

declare interface ConnectLock {
  tokenId: string;
  operation: "connect" | "disconnect";
  timestamp: number;
  sessionId: string;
}
declare type LockCtx = Record<string, Partial<ConnectLock>>;

declare interface TokenGroup {
  id: string;
  name: string;
  color: string;
  tokenIds: string[];
  createdAt?: string;
  updatedAt?: string;
}

export const gameTokens = useLocalStorage<TokenData[]>("gameTokens", []);
export const hasTokens = computed(() => gameTokens.value.length > 0);
export const selectedTokenId = useLocalStorage("selectedTokenId", "");
export const selectedToken = computed(() => {
  return gameTokens.value?.find((token) => token.id === selectedTokenId.value);
});
export const selectedRoleInfo = useLocalStorage<any>("selectedRoleInfo", null);

const activeConnections = useLocalStorage("activeConnections", {});
export const tokenGroups = useLocalStorage<TokenGroup[]>("tokenGroups", []);

export const useTokenStore = defineStore("tokens", () => {
  const wsConnections = ref<WebCtx>({});
  const connectionLocks = ref<LockCtx>({});

  const gameData = ref({
    roleInfo: null,
    legionInfo: null,
    commonActivityInfo: null,
    bossTowerInfo: null,
    evoTowerInfo: null,
    presetTeam: null,
    battleVersion: null as number | null,
    studyStatus: {
      isAnswering: false,
      questionCount: 0,
      answeredCount: 0,
      status: "",
      timestamp: null,
    },
    lastUpdated: null as string | null,
  });

  const selectedTokenRoleInfo = computed(() => {
    return gameData.value.roleInfo;
  });

  const readStatisticsValue = (stats: any, key: string) => {
    if (!stats) return undefined;
    try {
      if (typeof stats.get === "function") {
        return stats.get(key);
      }
      if (Object.prototype.hasOwnProperty.call(stats, key)) {
        return stats[key];
      }
    } catch (error) {
      gameLogger.warn("读取统计数据失败:", error);
    }
    return undefined;
  };

  const extractLastLoginTimestamp = (payload: any) => {
    if (!payload) return null;
    const candidateSources = [
      payload?.role?.statistics,
      payload?.statistics,
      payload?.role?.statisticsTime,
      payload?.statisticsTime,
    ];
    const candidateKeys = [
      "last:login:time",
      "lastLoginTime",
      "last_login_time",
    ];
    for (const stats of candidateSources) {
      if (!stats) continue;
      for (const key of candidateKeys) {
        const value = readStatisticsValue(stats, key);
        if (value !== undefined && value !== null) {
          const numeric = Number(value);
          if (!Number.isNaN(numeric) && numeric > 0) {
            return numeric;
          }
        }
      }
    }
    return null;
  };

  const syncRandomSeedFromStatistics = (
    tokenId: string,
    rolePayload: any,
    client: Socket | null,
  ) => {
    if (!client) return;
    const connection = wsConnections.value[tokenId];
    if (!connection || connection.status !== "connected") {
      return;
    }
    const lastLoginTime = extractLastLoginTimestamp(rolePayload);
    if (!lastLoginTime) {
      return;
    }
    if (
      connection.randomSeedSynced &&
      connection.lastRandomSeedSource === lastLoginTime
    ) {
      return;
    }
    const randomSeed = generateRandomSeed(lastLoginTime);
    try {
      client.emit("system_custom", {
        key: "randomSeed",
        value: randomSeed,
      });
      connection.randomSeedSynced = true;
      connection.lastRandomSeedSource = lastLoginTime;
      connection.lastRandomSeed = randomSeed;
      wsLogger.info(`同步 randomSeed [${tokenId}]`, {
        lastLoginTime,
        randomSeed,
      });
    } catch (error) {
      wsLogger.error(`发送 randomSeed 失败 [${tokenId}]`, error);
    }
  };

  const addToken = (tokenData: TokenData) => {
    let id =
      tokenData.id ||
      `token_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const newToken = {
      id: id,
      name: tokenData.name,
      token: tokenData.token,
      wsUrl: tokenData.wsUrl || null,
      server: tokenData.server || "",
      remark: tokenData.remark || "",
      level: tokenData.level || 1,
      profession: tokenData.profession || "",
      createdAt: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
      isActive: true,
      sourceUrl: tokenData.sourceUrl || null,
      importMethod: tokenData.importMethod || "manual",
      avatar: tokenData.avatar || "",
    };
    gameTokens.value.push(newToken);
    return newToken;
  };

  const updateToken = (tokenId: string, updates: Partial<TokenData>) => {
    const index = gameTokens.value.findIndex((token) => token.id === tokenId);
    if (index !== -1) {
      gameTokens.value[index] = {
        ...gameTokens.value[index],
        ...updates,
        updatedAt: new Date().toISOString(),
      };
      return true;
    }
    return false;
  };

  const removeToken = async (tokenId: string) => {
    gameTokens.value = gameTokens.value.filter((token) => token.id !== tokenId);
    if (wsConnections.value[tokenId]) {
      closeWebSocketConnection(tokenId);
    }
    if (selectedTokenId.value === tokenId) {
      selectedTokenId.value = null;
    }
    await deleteArrayBuffer(tokenId);
    return true;
  };

  const selectToken = (tokenId: string, forceReconnect = false) => {
    const token = gameTokens.value.find((t) => t.id === tokenId);
    if (!token) {
      return null;
    }
    const isAlreadySelected = selectedTokenId.value === tokenId;
    const existingConnection = wsConnections.value[tokenId];
    const isConnected = existingConnection?.status === "connected";
    const isConnecting = existingConnection?.status === "connecting";
    tokenLogger.debug(`选择Token: ${tokenId}`, {
      isAlreadySelected,
      isConnected,
      isConnecting,
      forceReconnect,
    });
    selectedTokenId.value = tokenId;
    updateToken(tokenId, { lastUsed: new Date().toISOString() });
    if (isConnected) {
      return token;
    }
    const shouldCreateConnection =
      forceReconnect ||
      !isAlreadySelected ||
      !existingConnection ||
      existingConnection.status === "disconnected" ||
      existingConnection.status === "error";
    if (shouldCreateConnection) {
      createWebSocketConnection(tokenId, token.token, token.wsUrl);
    }
    return token;
  };

  const tokenRefreshAttempts = ref<Record<string, number>>({});
  const attemptTokenRefresh = async (
    tokenId: string,
    forceReconnect = false,
  ) => {
    const lastAttempt = tokenRefreshAttempts.value[tokenId] || 0;
    const now = Date.now();
    if (now - lastAttempt < 10000) {
      wsLogger.warn(`Token刷新过于频繁，跳过 [${tokenId}]`);
      return false;
    }
    tokenRefreshAttempts.value[tokenId] = now;
    const gameToken = gameTokens.value.find((t) => t.id === tokenId);
    if (!gameToken) return false;
    wsLogger.info(`尝试自动刷新Token [${tokenId}]`);
    let refreshSuccess = false;
    try {
      if (gameToken.importMethod === "url" && gameToken.sourceUrl) {
        const token = await scheduleAuthUserRequest(async () => {
          const response = await fetch(gameToken.sourceUrl!);
          if (response.ok) {
            const data = await response.json();
            if (data.token) {
              return data.token;
            }
          }
          return null;
        });
        if (token) {
          updateToken(tokenId, { ...gameToken, token });
          wsLogger.info(`从URL获取token成功: ${gameToken.name}`);
          refreshSuccess = true;
        }
      } else if (
        gameToken.importMethod === "bin" ||
        gameToken.importMethod === "wxQrcode"
      ) {
        let userToken: ArrayBuffer | null = await getArrayBuffer(tokenId);
        let usedOldKey = false;
        if (!userToken) {
          const tokenByName = await getArrayBuffer(gameToken.name);
          if (tokenByName) {
            userToken = tokenByName;
            usedOldKey = true;
          }
        }
        if (userToken) {
          const token = await transformToken(userToken);
          updateToken(tokenId, { ...gameToken, token });
          if (usedOldKey) {
            const saved = await storeArrayBuffer(tokenId, userToken);
            if (saved) {
              await deleteArrayBuffer(gameToken.name);
            }
          }
          refreshSuccess = true;
        } else {
          wsLogger.error(`Token刷新失败: 未找到BIN数据 [${tokenId}]`);
        }
      }
    } catch (error) {
      wsLogger.error(`Token刷新过程出错 [${tokenId}]:`, error);
    }
    if (refreshSuccess) {
      wsLogger.info(`Token刷新成功 [${tokenId}]`);
      const currentPath = router.currentRoute.value.path;
      const shouldReconnect =
        forceReconnect ||
        currentPath === "/tokens" ||
        currentPath === "/admin/game-features";
      if (shouldReconnect) {
        wsLogger.info(`触发自动重连 [${tokenId}]`);
        if (wsConnections.value[tokenId]) {
          wsConnections.value[tokenId].reconnectAttempts = 0;
        }
        selectToken(tokenId, true);
      }
      return true;
    } else {
      wsLogger.error(`Token刷新失败，请手动重新导入 [${tokenId}]`);
      return false;
    }
  };

  const handleGameMessage = async (
    tokenId: string,
    message: ProtoMsg,
    client: any,
  ) => {
    try {
      if (!message) {
        gameLogger.warn(`消息处理跳过 [${tokenId}]: 无效消息`);
        return;
      }
      if (message.error) {
        const errText = String(message.error).toLowerCase();
        gameLogger.warn(`消息处理跳过 [${tokenId}]:`, message.error);
        if (errText.includes("token") && errText.includes("expired")) {
          const conn = wsConnections.value[tokenId];
          if (conn) {
            conn.status = "error";
            conn.lastError = {
              timestamp: new Date().toISOString(),
              error: "token expired",
            };
          }
          const gameToken = gameTokens.value.find((t) => t.id === tokenId);
          if (gameToken) {
            const refreshed = await attemptTokenRefresh(tokenId);
            if (!refreshed) {
              wsLogger.error(
                `Token 已过期且无法自动刷新，请重新导入 [${tokenId}]`,
              );
            }
          }
        }
        return;
      }
      const cmd = message.cmd?.toLowerCase();
      const body = message.getData();
      if (cmd === "role_getroleinforesp") {
        syncRandomSeedFromStatistics(tokenId, body, client);
        if (body?.role?.headImg) {
          const token = gameTokens.value.find((t) => t.id === tokenId);
          if (token && token.avatar !== body.role.headImg) {
            updateToken(tokenId, { avatar: body.role.headImg });
            wsLogger.debug(`更新头像 [${tokenId}]: ${body.role.headImg}`);
          }
        }
      }
      emitPlus(cmd, {
        tokenId,
        body,
        message,
        client,
        gameData,
      });
      gameLogger.gameMessage(tokenId, cmd, !!body);
    } catch (error) {
      gameLogger.error(`处理消息失败 [${tokenId}]:`, error);
    }
  };

  const validateToken = (token: any) => {
    if (!token) return false;
    if (typeof token !== "string") return false;
    if (token.trim().length === 0) return false;
    if (token.trim().length < 10) return false;
    return true;
  };

  const parseBase64Token = (base64String: string) => {
    try {
      if (!base64String || typeof base64String !== "string") {
        throw new Error("Token字符串无效");
      }
      const cleanBase64 = base64String.replace(/^data:.*base64,/, "").trim();
      if (cleanBase64.length === 0) {
        throw new Error("Token字符串为空");
      }
      let decoded;
      try {
        decoded = atob(cleanBase64);
      } catch (decodeError) {
        decoded = base64String.trim();
      }
      let tokenData;
      try {
        tokenData = JSON.parse(decoded);
      } catch {
        tokenData = { token: decoded };
      }
      const actualToken = tokenData.token || tokenData.gameToken || decoded;
      if (!validateToken(actualToken)) {
        throw new Error(`提取的token无效: "${actualToken}"`);
      }
      return {
        success: true,
        data: {
          ...tokenData,
          actualToken,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: "解析失败：" + error.message,
      };
    }
  };

  const importBase64Token = (
    name: string,
    base64String: string,
    additionalInfo = {},
  ) => {
    const parseResult = parseBase64Token(base64String);
    if (!parseResult.success) {
      return {
        success: false,
        error: parseResult.error,
        message: `Token "${name}" 导入失败: ${parseResult.error}`,
      };
    }
    const tokenData = {
      name,
      token: parseResult.data.actualToken,
      ...additionalInfo,
      ...parseResult.data,
    };
    try {
      const newToken = addToken(tokenData);
      const tokenInfo = parseResult.data.actualToken;
      const displayToken =
        tokenInfo.length > 20
          ? `${tokenInfo.substring(0, 10)}...${tokenInfo.substring(tokenInfo.length - 6)}`
          : tokenInfo;
      return {
        success: true,
        token: newToken,
        tokenName: name,
        message: `Token "${name}" 导入成功`,
        details: `实际Token: ${displayToken}`,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        message: `Token "${name}" 添加失败: ${error.message}`,
      };
    }
  };

  const generateSessionId = () =>
    "session_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9);
  const currentSessionId = generateSessionId();

  const acquireConnectionLock = async (
    tokenId: string,
    operation = "connect",
  ) => {
    const lockKey = `${tokenId}_${operation}`;
    const connect = connectionLocks.value;
    if (connect[lockKey]) {
      wsLogger.debug(`等待连接锁释放: ${tokenId} (${operation})`);
      let attempts = 0;
      while (connect[lockKey] && attempts < 100) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        attempts++;
      }
      if (connect[lockKey]) {
        wsLogger.warn(`连接锁等待超时: ${tokenId} (${operation})`);
        return false;
      }
    }
    connect[lockKey] = {
      tokenId,
      operation,
      timestamp: Date.now(),
      sessionId: currentSessionId,
    };
    wsLogger.connectionLock(tokenId, operation, true);
    return true;
  };

  const releaseConnectionLock = (tokenId: string, operation = "connect") => {
    const lockKey = `${tokenId}_${operation}`;
    if (connectionLocks.value[lockKey]) {
      delete connectionLocks.value[lockKey];
      wsLogger.connectionLock(tokenId, operation, false);
    }
  };

  const updateCrossTabConnectionState = (
    tokenId: string,
    action: string,
    sessionId: string = currentSessionId,
  ) => {
    let state = useLocalStorage(`ws_connection_${tokenId}`, {
      action,
      sessionId,
      timestamp: Date.now(),
      url: window.location.href,
    });
    if (activeConnections.value) {
      activeConnections.value[tokenId] = state.value;
    }
  };

  const checkCrossTabConnection = (tokenId: string) => {
    const storageKey = `ws_connection_${tokenId}`;
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const state = JSON.parse(stored);
        const isRecent = Date.now() - state.timestamp < 30000;
        const isDifferentSession = state.sessionId !== currentSessionId;
        if (
          isRecent &&
          isDifferentSession &&
          (state.action === "connecting" || state.action === "connected")
        ) {
          wsLogger.debug(`检测到其他标签页的活跃连接: ${tokenId}`);
          return state;
        }
      }
    } catch (error) {
      wsLogger.warn("检查跨标签页连接状态失败:", error);
    }
    return null;
  };

  // 🔥 核心修改：重写 WebSocket 连接为 SocketIO（对接你的PythonAnywhere）
  const createWebSocketConnection = async (
    tokenId: string,
    base64Token: string,
    customWsUrl = null,
  ) => {
    wsLogger.info(`开始创建连接: ${tokenId}`);
    const lockAcquired = await acquireConnectionLock(tokenId, "connect");
    if (!lockAcquired) {
      wsLogger.error(`无法获取连接锁: ${tokenId}`);
      return null;
    }

    try {
      const crossTabState = checkCrossTabConnection(tokenId);
      if (crossTabState) {
        wsLogger.debug(`跳过创建，其他标签页已有连接: ${tokenId}`);
        releaseConnectionLock(tokenId, "connect");
        return null;
      }
      updateCrossTabConnectionState(tokenId, "connecting");

      if (wsConnections.value[tokenId]) {
        wsLogger.debug(`优雅关闭现有连接: ${tokenId}`);
        await closeWebSocketConnectionAsync(tokenId);
      }

      const parseResult = parseBase64Token(base64Token);
      let actualToken;
      if (parseResult.success) {
        actualToken = parseResult.data.actualToken;
      } else {
        if (validateToken(base64Token)) {
          actualToken = base64Token;
        } else {
          throw new Error(`Token无效: ${parseResult.error}`);
        }
      }

      // 🔥 关键：替换为你的 PythonAnywhere 后端地址
      const SERVER_URL = "https://15309607131.pythonanywhere.com";
      const wsClient = io(SERVER_URL, {
        transports: ["websocket"],
        autoConnect: false,
        reconnection: true,
      });

      wsConnections.value[tokenId] = {
        client: wsClient,
        status: "connecting",
        tokenId,
        wsUrl: SERVER_URL,
        actualToken,
        sessionId: currentSessionId,
        connectedAt: null,
        lastMessage: null,
        lastError: null,
        reconnectAttempts: 0,
        randomSeedSynced: false,
        lastRandomSeedSource: null,
        lastRandomSeed: null,
      };

      // 🔥 兼容原有 onConnect 事件
      wsClient.on("connect", () => {
        wsLogger.wsConnect(tokenId);
        if (wsConnections.value[tokenId]) {
          wsConnections.value[tokenId].status = "connected";
          wsConnections.value[tokenId].connectedAt = new Date().toISOString();
          wsConnections.value[tokenId].reconnectAttempts = 0;
        }
        updateCrossTabConnectionState(tokenId, "connected");
        releaseConnectionLock(tokenId, "connect");
        localStorage.removeItem("xyzw_chat_msg_list");
        wsClient.emit("role_getroleinfo");
      });

      // 🔥 兼容原有 onDisconnect 事件
      wsClient.on("disconnect", async (event) => {
        wsLogger.wsDisconnect(tokenId, "断开连接");
        if (wsConnections.value[tokenId]) {
          const conn = wsConnections.value[tokenId];
          conn.status = "disconnected";
          conn.randomSeedSynced = false;
        }
        updateCrossTabConnectionState(tokenId, "disconnected");
      });

      // 🔥 兼容原有 onError 事件
      wsClient.on("connect_error", (error) => {
        wsLogger.wsError(tokenId, error);
        if (wsConnections.value[tokenId]) {
          wsConnections.value[tokenId].status = "error";
          wsConnections.value[tokenId].lastError = {
            timestamp: new Date().toISOString(),
            error: error.toString(),
            url: SERVER_URL,
          };
        }
        releaseConnectionLock(tokenId, "connect");
      });

      // 🔥 兼容原有消息监听
      wsClient.onAny((cmd, data) => {
        wsLogger.wsMessage(tokenId, cmd, true);
        if (wsConnections.value[tokenId]) {
          wsConnections.value[tokenId].lastMessage = {
            timestamp: new Date().toISOString(),
            data: data,
            cmd: cmd,
          };
          handleGameMessage(tokenId, { cmd, getData: () => data }, wsClient);
        }
      });

      wsClient.connect();
      wsLogger.verbose(`SocketIO客户端创建成功: ${tokenId}`);
      return wsClient;
    } catch (error) {
      wsLogger.error(`创建连接失败 [${tokenId}]:`, error);
      updateCrossTabConnectionState(tokenId, "disconnected");
      releaseConnectionLock(tokenId, "connect");
      return null;
    }
  };

  const closeWebSocketConnectionAsync = async (tokenId: string) => {
    const lockAcquired = await acquireConnectionLock(tokenId, "disconnect");
    if (!lockAcquired) {
      wsLogger.warn(`无法获取断开连接锁: ${tokenId}`);
      return;
    }
    try {
      const connection = wsConnections.value[tokenId];
      if (connection && connection.client) {
        wsLogger.debug(`开始优雅关闭连接: ${tokenId}`);
        connection.status = "disconnecting";
        updateCrossTabConnectionState(tokenId, "disconnecting");
        connection.client.disconnect();
        await new Promise((resolve) => {
          const checkDisconnected = () => {
            if (!connection.client.connected) {
              resolve();
            } else {
              setTimeout(checkDisconnected, 100);
            }
          };
          setTimeout(resolve, 5000);
          checkDisconnected();
        });
        delete wsConnections.value[tokenId];
        updateCrossTabConnectionState(tokenId, "disconnected");
        wsLogger.info(`连接已优雅关闭: ${tokenId}`);
      }
    } catch (error) {
      wsLogger.error(`关闭连接失败 [${tokenId}]:`, error);
    } finally {
      releaseConnectionLock(tokenId, "disconnect");
    }
  };

  const closeWebSocketConnection = (tokenId: string) => {
    closeWebSocketConnectionAsync(tokenId).catch((error) => {
      wsLogger.error(`关闭连接异步操作失败 [${tokenId}]:`, error);
    });
  };

  const getWebSocketStatus = (tokenId: string) => {
    return wsConnections.value[tokenId]?.status || "disconnected";
  };

  const getWebSocketClient = (tokenId: string) => {
    return wsConnections.value[tokenId]?.client || null;
  };

  const setMessageListener = (listener: any) => {
    if (selectedToken.value) {
      const connection = wsConnections.value[selectedToken.value.id];
      if (connection && connection.client) {
        connection.client.onAny(listener);
      }
    }
  };

  const setShowMsg = (show: any) => {};

  // 🔥 兼容原有 sendMessage 方法
  const sendMessage = (
    tokenId: string,
    cmd: string,
    params = {},
    options = {},
  ) => {
    const connection = wsConnections.value[tokenId];
    if (!connection || connection.status !== "connected") {
      wsLogger.error(`WebSocket未连接，无法发送消息 [${tokenId}]`);
      return false;
    }
    try {
      const client = connection.client;
      client!.emit(cmd, params);
      wsLogger.wsMessage(tokenId, cmd, false);
      return true;
    } catch (error) {
      wsLogger.error(`发送失败 [${tokenId}] ${cmd}:`, error.message);
      return false;
    }
  };

  const sendMessageWithPromise = async (
    tokenId: string,
    cmd: string,
    params = {},
    timeout = 5000,
  ) => {
    const connection = wsConnections.value[tokenId];
    if (!connection || connection.status !== "connected") {
      return Promise.reject(new Error(`WebSocket未连接 [${tokenId}]`));
    }
    const client = connection.client;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("超时")), timeout);
      client!.once(cmd, (data) => {
        clearTimeout(timer);
        resolve(data);
      });
      client!.emit(cmd, params);
    });
  };

  const sendHeartbeat = (tokenId: string) => {
    return sendMessage(tokenId, "heart_beat");
  };

  const sendGetRoleInfo = async (
    tokenId: string,
    params = {},
    retryCount = 0,
  ) => {
    try {
      const timeout = 15000;
      const roleInfo = await sendMessageWithPromise(
        tokenId,
        "role_getroleinfo",
        params,
        timeout,
      );
      if (roleInfo) {
        gameData.value.roleInfo = roleInfo;
        gameData.value.lastUpdated = new Date().toISOString();
        gameLogger.verbose("角色信息已通过 Promise 更新");
      }
      return roleInfo;
    } catch (error) {
      gameLogger.error(`获取角色信息失败 [${tokenId}]:`, error.message);
      if (retryCount < 2) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return sendGetRoleInfo(tokenId, params, retryCount + 1);
      }
      throw error;
    }
  };

  const sendGetDataBundleVersion = (tokenId: string, params = {}) => {
    return sendMessageWithPromise(tokenId, "system_getdatabundlever", params);
  };

  const sendSignIn = (tokenId: string) => {
    return sendMessageWithPromise(tokenId, "system_signinreward");
  };

  const sendClaimDailyReward = (tokenId: string, rewardId = 0) => {
    return sendMessageWithPromise(tokenId, "task_claimdailyreward", {
      rewardId,
    });
  };

  const sendGetTeamInfo = (tokenId: string, params = {}) => {
    return sendMessageWithPromise(tokenId, "presetteam_getinfo", params);
  };

  const sendMessageToWorld = (tokenId: string, message: string) => {
    return sendMessageWithPromise(tokenId, "system_sendchatmessage", {
      channel: 1,
      emojiId: 0,
      extra: null,
      msg: message,
      msgType: 1,
    });
  };

  const sendMessageToLegion = (tokenId: string, message: string) => {
    return sendMessageWithPromise(tokenId, "system_sendchatmessage", {
      channel: 2,
      emojiId: 0,
      extra: null,
      msg: message,
      msgType: 1,
    });
  };

  const sendGameMessage = (
    tokenId: string,
    cmd: string,
    params = {},
    options = {},
  ) => {
    if (options.usePromise) {
      return sendMessageWithPromise(tokenId, cmd, params, options.timeout);
    } else {
      return sendMessage(tokenId, cmd, params, options);
    }
  };

  const getCurrentTowerLevel = () => {
    try {
      const roleInfo = gameData.value.roleInfo;
      if (!roleInfo || !roleInfo.role) {
        gameLogger.warn("角色信息不存在");
        return null;
      }
      const tower = roleInfo.role.tower;
      if (!tower) {
        gameLogger.warn("塔信息不存在");
        return null;
      }
      const level =
        tower.level || tower.currentLevel || tower.floor || tower.stage;
      return level;
    } catch (error) {
      gameLogger.error("获取塔层数失败:", error);
      return null;
    }
  };

  const getTowerInfo = () => {
    try {
      const roleInfo = gameData.value.roleInfo;
      if (!roleInfo || !roleInfo.role) {
        return null;
      }
      return roleInfo.role.tower || null;
    } catch (error) {
      gameLogger.error("获取塔信息失败:", error);
      return null;
    }
  };

  const exportTokens = () => {
    return {
      tokens: gameTokens.value,
      exportedAt: new Date().toISOString(),
      version: "2.0",
    };
  };

  const importTokens = (data: any) => {
    try {
      if (data.tokens && Array.isArray(data.tokens)) {
        gameTokens.value = data.tokens;
        return {
          success: true,
          message: `成功导入 ${data.tokens.length} 个Token`,
        };
      } else {
        return { success: false, message: "导入数据格式错误" };
      }
    } catch (error) {
      return { success: false, message: "导入失败：" + error.message };
    }
  };

  const clearAllTokens = async () => {
    Object.keys(wsConnections.value).forEach((tokenId) => {
      closeWebSocketConnection(tokenId);
    });
    gameTokens.value = [];
    selectedTokenId.value = null;
    await clearAll();
  };

  const cleanExpiredTokens = async () => {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const tokensToRemove = gameTokens.value.filter((token) => {
      if (
        token.importMethod === "url" ||
        token.importMethod === "bin" ||
        token.importMethod === "wxQrcode" ||
        token.upgradedToPermanent
      ) {
        return false;
      }
      const lastUsed = new Date(token.lastUsed || token.createdAt);
      return lastUsed <= oneDayAgo;
    });
    const cleanedCount = tokensToRemove.length;
    for (const token of tokensToRemove) {
      await removeToken(token.id);
    }
    return cleanedCount;
  };

  const upgradeTokenToPermanent = (tokenId: string) => {
    const token = gameTokens.value.find((t) => t.id === tokenId);
    if (
      token &&
      !token.upgradedToPermanent &&
      token.importMethod !== "url" &&
      token.importMethod !== "bin" &&
      token.importMethod !== "wxQrcode"
    ) {
      updateToken(tokenId, {
        upgradedToPermanent: true,
        upgradedAt: new Date().toISOString(),
      });
      return true;
    }
    return false;
  };

  const validateConnectionUniqueness = (tokenId: string) => {
    const connections = Object.values(wsConnections.value).filter(
      (conn) =>
        conn.tokenId === tokenId &&
        (conn.status === "connecting" || conn.status === "connected"),
    );
    if (connections.length > 1) {
      wsLogger.warn(
        `检测到重复连接: ${tokenId}, 连接数: ${connections.length}`,
      );
      const sortedConnections = connections.sort(
        (a, b) => new Date(b.connectedAt || 0) - new Date(a.connectedAt || 0),
      );
      for (let i = 1; i < sortedConnections.length; i++) {
        const oldConnection = sortedConnections[i];
        wsLogger.debug(`关闭重复连接: ${tokenId}`);
        closeWebSocketConnectionAsync(oldConnection.tokenId!);
      }
      return false;
    }
    return true;
  };

  const connectionMonitor = {
    startMonitoring: () => {
      setInterval(() => {
        const now = Date.now();
        Object.entries(wsConnections.value).forEach(([tokenId, connection]) => {
          const lastActivity =
            connection.lastMessage?.timestamp || connection.connectedAt;
          if (lastActivity) {
            const timeSinceActivity = now - new Date(lastActivity).getTime();
            if (
              timeSinceActivity > 30000 &&
              connection.status === "connected"
            ) {
              wsLogger.warn(`检测到连接可能已断开: ${tokenId}`);
              if (connection.client) {
                connection.client.emit("heart_beat");
              }
            }
          }
        });
        Object.entries(connectionLocks.value).forEach(([tokenId, lock]) => {
          if (now - lock.timestamp > 600000) {
            delete connectionLocks.value[tokenId];
            wsLogger.debug(`清理过期连接锁: ${tokenId}`);
          }
        });
        Object.entries(activeConnections.value).forEach(([tokenId, state]) => {
          if (now - state.timestamp > 300000) {
            wsLogger.debug(`清理过期跨标签页状态: ${tokenId}`);
            delete activeConnections.value[tokenId];
            localStorage.removeItem(`ws_connection_${tokenId}`);
          }
        });
      }, 10000);
    },
    getStats: () => {
      const duplicateTokens: string[] = [];
      const stats = {
        totalConnections: Object.keys(wsConnections.value).length,
        connectedCount: 0,
        connectingCount: 0,
        disconnectedCount: 0,
        errorCount: 0,
        duplicateTokens,
        activeLocks: Object.keys(connectionLocks.value).length,
        crossTabStates: Object.keys(activeConnections.value).length,
      };
      const tokenCounts = new Map();
      Object.values(wsConnections.value).forEach((connection) => {
        stats[connection.status + "Count"]++;
        const count = tokenCounts.get(connection.tokenId) || 0;
        tokenCounts.set(connection.tokenId, count + 1);
        if (count > 0) {
          stats.duplicateTokens.push(connection.tokenId!);
        }
      });
      return stats;
    },
    forceCleanup: async () => {
      wsLogger.info("开始强制清理所有连接...");
      const cleanupPromises = Object.keys(wsConnections.value).map((tokenId) =>
        closeWebSocketConnectionAsync(tokenId),
      );
      await Promise.all(cleanupPromises);
      Object.keys(localStorage).forEach((key) => {
        if (key.startsWith("ws_connection_")) {
          localStorage.removeItem(key);
        }
      });
      wsLogger.info("强制清理完成");
    },
  };

  const setupCrossTabListener = () => {
    window.addEventListener("storage", (event) => {
      if (event.key?.startsWith("ws_connection_")) {
        const tokenId = event.key.replace("ws_connection_", "");
        wsLogger.debug(
          `检测到跨标签页连接状态变化: ${tokenId}`,
          event.newValue,
        );
        if (event.newValue) {
          try {
            const newState = JSON.parse(event.newValue);
            const localConnection = wsConnections.value[tokenId];
            if (
              newState.action === "connected" &&
              newState.sessionId !== currentSessionId &&
              localConnection?.status === "connected"
            ) {
              wsLogger.info(
                `检测到其他标签页已连接同一token，关闭本地连接: ${tokenId}`,
              );
              closeWebSocketConnectionAsync(tokenId);
            }
          } catch (error) {
            wsLogger.warn("解析跨标签页状态失败:", error);
          }
        }
      }
    });
  };

  const initTokenStore = () => {
    cleanExpiredTokens();
    connectionMonitor.startMonitoring();
    setupCrossTabListener();
    setAuthUserRateLimiterCallback((waitTimeMs: number, queueSize: number) => {
      const waitSeconds = Math.ceil(waitTimeMs / 1000);
      $emit.emit("token:refresh:waiting", {
        waitTimeMs,
        waitSeconds,
        queueSize,
        timestamp: Date.now(),
      });
    });
    tokenLogger.info("Token Store 初始化完成，连接监控已启动");
  };

  const setBattleVersion = (version: number | null) => {
    gameData.value.battleVersion = version;
    gameData.value.lastUpdated = new Date().toISOString();
  };

  const getBattleVersion = () => {
    return gameData.value.battleVersion;
  };

  const createTokenGroup = (name: string, color: string = "#1677ff") => {
    const group: TokenGroup = {
      id: "group_" + Date.now() + Math.random().toString(36).slice(2),
      name,
      color,
      tokenIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    tokenGroups.value.push(group);
    return group;
  };

  const deleteTokenGroup = (groupId: string) => {
    const index = tokenGroups.value.findIndex((g) => g.id === groupId);
    if (index !== -1) {
      tokenGroups.value.splice(index, 1);
    }
  };

  const updateTokenGroup = (groupId: string, updates: Partial<TokenGroup>) => {
    const group = tokenGroups.value.find((g) => g.id === groupId);
    if (group) {
      Object.assign(group, updates, {
        updatedAt: new Date().toISOString(),
      });
    }
  };

  const addTokenToGroup = (groupId: string, tokenId: string) => {
    const group = tokenGroups.value.find((g) => g.id === groupId);
    if (group && !group.tokenIds.includes(tokenId)) {
      group.tokenIds.push(tokenId);
      group.updatedAt = new Date().toISOString();
    }
  };

  const removeTokenFromGroup = (groupId: string, tokenId: string) => {
    const group = tokenGroups.value.find((g) => g.id === groupId);
    if (group) {
      const index = group.tokenIds.indexOf(tokenId);
      if (index !== -1) {
        group.tokenIds.splice(index, 1);
        group.updatedAt = new Date().toISOString();
      }
    }
  };

  const getTokenGroups = (tokenId: string): TokenGroup[] => {
    return tokenGroups.value.filter((g) => g.tokenIds.includes(tokenId));
  };

  const getGroupTokenIds = (groupId: string): string[] => {
    const group = tokenGroups.value.find((g) => g.id === groupId);
    return group ? group.tokenIds : [];
  };

  const getValidGroupTokenIds = (groupId: string): string[] => {
    const tokenIds = getGroupTokenIds(groupId);
    const validTokenIds = gameTokens.value.map((t) => t.id);
    return tokenIds.filter((id) => validTokenIds.includes(id));
  };

  const cleanupInvalidTokens = () => {
    const validTokenIds = new Set(gameTokens.value.map((t) => t.id));
    tokenGroups.value.forEach((group) => {
      group.tokenIds = group.tokenIds.filter((id) => validTokenIds.has(id));
    });
  };

  return {
    gameTokens,
    selectedTokenId,
    wsConnections,
    gameData,
    hasTokens,
    selectedToken,
    selectedTokenRoleInfo,
    addToken,
    updateToken,
    removeToken,
    selectToken,
    parseBase64Token,
    importBase64Token,
    createWebSocketConnection,
    closeWebSocketConnection,
    getWebSocketStatus,
    getWebSocketClient,
    sendMessage,
    sendMessageWithPromise,
    setMessageListener,
    setShowMsg,
    sendHeartbeat,
    sendGetRoleInfo,
    sendGetDataBundleVersion,
    sendSignIn,
    sendClaimDailyReward,
    sendGetTeamInfo,
    sendGameMessage,
    exportTokens,
    importTokens,
    clearAllTokens,
    cleanExpiredTokens,
    upgradeTokenToPermanent,
    initTokenStore,
    sendMessageToLegion,
    sendMessageToWorld,
    getCurrentTowerLevel,
    getTowerInfo,
    setBattleVersion,
    getBattleVersion,
    validateToken,
    debugToken: (tokenString: string) => {
      console.log("🔍 Token调试信息:");
      console.log("原始Token:", tokenString);
      const parseResult = parseBase64Token(tokenString);
      console.log("解析结果:", parseResult);
      if (parseResult.success) {
        console.log("实际Token:", parseResult.data.actualToken);
        console.log(
          "Token有效性:",
          validateToken(parseResult.data.actualToken),
        );
      }
      return parseResult;
    },
    validateConnectionUniqueness,
    connectionMonitor,
    currentSessionId: () => currentSessionId,
    tokenGroups,
    createTokenGroup,
    deleteTokenGroup,
    updateTokenGroup,
    addTokenToGroup,
    removeTokenFromGroup,
    getTokenGroups,
    getGroupTokenIds,
    getValidGroupTokenIds,
    cleanupInvalidTokens,
    devTools: {
      getConnectionStats: () => connectionMonitor.getStats(),
      forceCleanup: () => connectionMonitor.forceCleanup(),
      showConnectionLocks: () => Object.keys(connectionLocks.value),
      showCrossTabStates: () => Object.keys(activeConnections.value),
      testDuplicateConnection: (tokenId: string) => {
        const token = gameTokens.value.find((t) => t.id === tokenId);
        if (token) {
          createWebSocketConnection(tokenId + "_test", token.token);
        }
      },
    },
  };
});