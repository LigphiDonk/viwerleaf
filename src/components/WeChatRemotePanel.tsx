import { useState, useEffect, useRef, useCallback } from "react";
import QRCode from "qrcode";
import type { AppLocale } from "../types";
import { desktop } from "../lib/desktop";

interface WeChatConfig {
  token: string;
  apiUrl: string;
  allowFrom: string;
  autoStart: boolean;
  pollTimeoutMs: number;
}

interface WeChatStatus {
  state: "disconnected" | "scanning" | "connected" | "error";
  message: string;
  boundUser?: string;
}

interface QrCodeInfo {
  qrUrl: string;
  scanTicket: string;
}

interface WeChatRemotePanelProps {
  locale: AppLocale;
}

export function WeChatRemotePanel({ locale }: WeChatRemotePanelProps) {
  const isZh = locale === "zh-CN";
  const [config, setConfig] = useState<WeChatConfig>({
    token: "",
    apiUrl: "https://ilinkai.weixin.qq.com",
    allowFrom: "",
    autoStart: false,
    pollTimeoutMs: 35000,
  });
  const [status, setStatus] = useState<WeChatStatus>({
    state: "disconnected",
    message: isZh ? "未连接" : "Not connected",
  });
  const [qrInfo, setQrInfo] = useState<QrCodeInfo | null>(null);
  const [qrDataUri, setQrDataUri] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isBinding, setIsBinding] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load config & status on mount
  useEffect(() => {
    loadConfig();
    refreshStatus();
  }, []);

  // Cleanup poll timer on unmount
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
      }
    };
  }, []);

  async function loadConfig() {
    try {
      const cfg = await desktop.loadWeChatConfig();
      setConfig(cfg);
    } catch {
      // Use default config
    }
  }

  async function refreshStatus() {
    try {
      const s = await desktop.getWeChatStatus();
      setStatus(s as WeChatStatus);
    } catch {
      // ignore
    }
  }

  async function handleSaveConfig() {
    try {
      await desktop.saveWeChatConfig(config);
      setError("");
    } catch (err) {
      setError(String(err));
    }
  }

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    setIsBinding(false);
    setQrInfo(null);
    setQrDataUri(null);
  }, []);

  // Generate QR code data URI from the URL returned by the API
  useEffect(() => {
    if (!qrInfo?.qrUrl) {
      setQrDataUri(null);
      return;
    }
    // If it's already a data URI or a direct image URL, use as-is
    if (qrInfo.qrUrl.startsWith("data:")) {
      setQrDataUri(qrInfo.qrUrl);
      return;
    }
    // Otherwise generate a QR code image from the URL
    QRCode.toDataURL(qrInfo.qrUrl, { width: 280, margin: 2, errorCorrectionLevel: "M" })
      .then((dataUri: string) => setQrDataUri(dataUri))
      .catch((err: Error) => {
        console.error("[WeChat QR] failed to generate QR code:", err);
        setQrDataUri(null);
      });
  }, [qrInfo?.qrUrl]);

  async function handleStartBinding() {
    setError("");
    setIsBinding(true);
    setStatus({
      state: "scanning",
      message: isZh ? "正在获取二维码…" : "Requesting QR code...",
    });

    try {
      const qr = await desktop.startWeChatBinding(config.apiUrl);
      setQrInfo(qr);
      setStatus({
        state: "scanning",
        message: isZh ? "请用手机微信扫描二维码" : "Scan QR code with WeChat on your phone",
      });

      // Start polling scan status
      pollTimerRef.current = setInterval(async () => {
        try {
          const token = await desktop.pollWeChatBindingStatus(
            qr.scanTicket,
            config.apiUrl,
          );
          if (token) {
            stopPolling();
            const newConfig = { ...config, token };
            setConfig(newConfig);
            await desktop.saveWeChatConfig(newConfig);
            setStatus({
              state: "connected",
              message: isZh ? "绑定成功！" : "Binding successful!",
            });
          }
        } catch {
          // Continue polling
        }
      }, 3000);

      // Auto-stop after 8 minutes
      setTimeout(() => {
        if (isBinding) {
          stopPolling();
          setStatus({
            state: "error",
            message: isZh ? "扫码超时，请重试" : "QR scan timed out. Please try again.",
          });
        }
      }, 480_000);
    } catch (err) {
      setIsBinding(false);
      setStatus({
        state: "error",
        message: String(err),
      });
      setError(String(err));
    }
  }

  async function handleStartListener() {
    setError("");
    try {
      await desktop.startWeChatListener();
      await refreshStatus();
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleStopListener() {
    try {
      await desktop.stopWeChatListener();
      await refreshStatus();
    } catch (err) {
      setError(String(err));
    }
  }

  function handleCancelBinding() {
    stopPolling();
    setStatus({
      state: "disconnected",
      message: isZh ? "已取消" : "Cancelled",
    });
  }

  const hasBoundToken = config.token.trim().length > 0;

  const statusColor =
    status.state === "connected"
      ? "var(--color-success, #22c55e)"
      : status.state === "scanning"
        ? "var(--color-warning, #f59e0b)"
        : status.state === "error"
          ? "var(--color-danger, #ef4444)"
          : "var(--color-muted, #94a3b8)";

  return (
    <div className="wechat-remote-panel">
      {/* Description */}
      <div className="settings-section">
        <div className="settings-section__label">
          {isZh ? "微信远程控制" : "WeChat Remote Control"}
        </div>
        <div className="settings-section__desc">
          {isZh
            ? "通过微信远程与 AI Agent 对话，随时随地指挥 AI 做实验、跑代码。"
            : "Chat with your local AI Agent via WeChat. Control experiments and run code from anywhere."}
        </div>
      </div>

      {/* Connection status */}
      <div className="wechat-status-card">
        <div className="wechat-status-card__header">
          <div className="wechat-status-indicator" style={{ backgroundColor: statusColor }} />
          <div className="wechat-status-card__info">
            <div className="wechat-status-card__state">
              {status.state === "connected"
                ? isZh ? "已连接" : "Connected"
                : status.state === "scanning"
                  ? isZh ? "等待扫码" : "Waiting for scan"
                  : status.state === "error"
                    ? isZh ? "错误" : "Error"
                    : isZh ? "未连接" : "Disconnected"}
            </div>
            <div className="wechat-status-card__message">{status.message}</div>
          </div>
        </div>

        {/* QR code display */}
        {isBinding && qrInfo && (
          <div className="wechat-qr-container">
            <div className="wechat-qr-frame">
              {qrDataUri ? (
                <img
                  src={qrDataUri}
                  alt="WeChat QR Code"
                  className="wechat-qr-image"
                />
              ) : (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 220, height: 220, color: "var(--text-secondary)", fontSize: 13 }}>
                  {isZh ? "正在生成二维码…" : "Generating QR code…"}
                </div>
              )}
            </div>
            <div className="wechat-qr-hint">
              {isZh
                ? "打开手机微信 → 扫一扫 → 扫描上方二维码"
                : "Open WeChat on your phone → Scan → Scan the QR code above"}
            </div>
            <button
              className="btn-secondary wechat-cancel-btn"
              type="button"
              onClick={handleCancelBinding}
            >
              {isZh ? "取消绑定" : "Cancel"}
            </button>
          </div>
        )}

        {/* Action buttons */}
        {!isBinding && (
          <div className="wechat-status-card__actions">
            {!hasBoundToken ? (
              <button
                className="btn-primary"
                type="button"
                onClick={() => void handleStartBinding()}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                  <rect x="3" y="3" width="7" height="7" />
                  <rect x="14" y="3" width="7" height="7" />
                  <rect x="3" y="14" width="7" height="7" />
                  <rect x="14" y="14" width="7" height="7" rx="1" />
                </svg>
                {isZh ? "扫码绑定微信" : "Bind WeChat (QR Scan)"}
              </button>
            ) : (
              <>
                {status.state !== "connected" ? (
                  <button
                    className="btn-primary"
                    type="button"
                    onClick={() => void handleStartListener()}
                  >
                    {isZh ? "▶ 启动监听" : "▶ Start Listener"}
                  </button>
                ) : (
                  <button
                    className="btn-secondary"
                    type="button"
                    onClick={() => void handleStopListener()}
                  >
                    {isZh ? "⏹ 停止监听" : "⏹ Stop Listener"}
                  </button>
                )}
                <button
                  className="btn-secondary"
                  type="button"
                  onClick={() => void handleStartBinding()}
                >
                  {isZh ? "重新绑定" : "Re-bind"}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Allow-from whitelist */}
      {hasBoundToken && (
        <div className="wechat-section">
          <label className="compute-node-field">
            <span>
              {isZh ? "允许操作的微信用户" : "Allowed WeChat Users"}
              <span className="wechat-field-hint">
                {isZh
                  ? '（用户 ID 以逗号分隔，留空或填 "*" 允许所有人）'
                  : '(Comma-separated user IDs. Leave empty or "*" for all.)'}
              </span>
            </span>
            <input
              className="sidebar-input"
              value={config.allowFrom}
              onChange={(e) =>
                setConfig((c) => ({ ...c, allowFrom: e.target.value }))
              }
              placeholder="user1@im.wechat, user2@im.wechat"
            />
          </label>
        </div>
      )}

      {/* Advanced settings toggle */}
      {hasBoundToken && (
        <button
          className="wechat-advanced-toggle"
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            width="14"
            height="14"
            style={{
              transform: showAdvanced ? "rotate(90deg)" : "rotate(0)",
              transition: "transform 0.2s",
            }}
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
          {isZh ? "高级设置" : "Advanced Settings"}
        </button>
      )}

      {showAdvanced && hasBoundToken && (
        <div className="wechat-advanced-section">
          <label className="compute-node-field">
            <span>{isZh ? "API 网关地址" : "API Gateway URL"}</span>
            <input
              className="sidebar-input"
              value={config.apiUrl}
              onChange={(e) =>
                setConfig((c) => ({ ...c, apiUrl: e.target.value }))
              }
              placeholder="https://ilinkai.weixin.qq.com"
            />
          </label>

          <label className="compute-node-field">
            <span>{isZh ? "轮询超时（毫秒）" : "Poll Timeout (ms)"}</span>
            <input
              className="sidebar-input"
              type="number"
              value={config.pollTimeoutMs}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  pollTimeoutMs: parseInt(e.target.value) || 35000,
                }))
              }
            />
          </label>

          <div className="compute-node-field">
            <span>{isZh ? "自动启动监听" : "Auto-start Listener"}</span>
            <div className="settings-language-options">
              <button
                type="button"
                className={`settings-lang-btn ${config.autoStart ? "is-active" : ""}`}
                onClick={() => setConfig((c) => ({ ...c, autoStart: true }))}
              >
                {isZh ? "开启" : "On"}
              </button>
              <button
                type="button"
                className={`settings-lang-btn ${!config.autoStart ? "is-active" : ""}`}
                onClick={() => setConfig((c) => ({ ...c, autoStart: false }))}
              >
                {isZh ? "关闭" : "Off"}
              </button>
            </div>
          </div>

          <div className="compute-node-form__footer">
            <button
              className="btn-primary"
              type="button"
              onClick={() => void handleSaveConfig()}
            >
              {isZh ? "保存设置" : "Save Settings"}
            </button>
          </div>
        </div>
      )}

      {error && <div className="compute-node-error">{error}</div>}

      {/* Empty state */}
      {!hasBoundToken && !isBinding && (
        <div className="compute-node-empty">
          <div className="compute-node-empty__icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="40" height="40">
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
            </svg>
          </div>
          <div className="compute-node-empty__text">
            {isZh
              ? "尚未绑定微信。绑定后，你可以通过手机微信远程与 AI Agent 对话，随时随地指挥实验。"
              : "WeChat not bound yet. After binding, you can remotely chat with your AI Agent from your phone anywhere."}
          </div>
        </div>
      )}
    </div>
  );
}
