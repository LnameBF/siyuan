import {Constants} from "../constants";
/// #if !MOBILE
import type {Tab} from "./Tab";
/// #endif
import type {App} from "../index";

interface IConnectOptions {
    id: string,
    type?: TWS,
    callback?: () => void,
    msgCallback?: (data: IWebSocketData) => void
}

// 存活的 Model 实例，页面从 Back-Forward Cache 恢复时统一重连
const activeModels = new Set<Model>();

export class Model {
    public ws: WebSocket;
    public reqId: number;
    private mainMessageQueue: {
        data: string,
        callback: (data: IWebSocketData) => void
    }[] = [];

    public parent:

        /// #if !MOBILE
        Tab;
    /// #else
    // @ts-ignore
    null;
    /// #endif
    public app: App;
    private connectOptions?: IConnectOptions;
    private reconnectTimer?: number;

    constructor(options: {
        app: App,
    }) {
        this.app = options.app;
    }

    private processWebSocketMessage(data: string, callback: (data: IWebSocketData) => void) {
        // 消息处理依赖面板子类，调用时加载以避免基类初始化期间形成循环依赖。
        const {processMessage}: typeof import("../util/processMessage") = require("../util/processMessage");
        callback.call(this, processMessage(JSON.parse(data)));
    }

    public flushMainMessages() {
        const messages = this.mainMessageQueue.splice(0);
        messages.forEach((message) => {
            try {
                this.processWebSocketMessage(message.data, message.callback);
            } catch (error) {
                console.error("Failed to process queued WebSocket message:", error);
            }
        });
    }

    public connect(options: IConnectOptions) {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        this.connectOptions = options;
        activeModels.add(this);
        const websocketURL = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;
        const ws = new WebSocket(`${websocketURL}?app=${Constants.SIYUAN_APPID}&id=${options.id}${options.type ? "&type=" + options.type : ""}`);
        ws.onopen = () => {
            if (options.callback) {
                options.callback.call(this);
            }
            const logElement = document.getElementById("errorLog");
            if (logElement) {
                const {reloadSync}: typeof import("../util/reloadSync") = require("../util/reloadSync");
                // 内核中断后无法 catch fetch 请求错误，重连会导致无法执行 transactionsTimeout
                reloadSync(this.app, {upsertRootIDs: [], removeRootIDs: []});
                window.siyuan.dialogs.find(item => {
                    if (item.element.id === "errorLog") {
                        item.destroy();
                        return true;
                    }
                });
            }
        };
        ws.onmessage = (event) => {
            if (!options.msgCallback) {
                return;
            }
            if (options.type === "main" && !window.siyuan.isReady) {
                this.mainMessageQueue.push({
                    data: event.data,
                    callback: options.msgCallback,
                });
                return;
            }
            // 非主 WebSocket 在界面初始化后创建，保留配置保护以避免异常连接提前处理消息。
            if (window.siyuan.config) {
                this.processWebSocketMessage(event.data, options.msgCallback);
            }
        };
        ws.onclose = (ev) => {
            if (0 <= ev.reason.indexOf("unauthenticated")) {
                return;
            }

            if (0 > ev.reason.indexOf("close websocket")) {
                console.warn("WebSocket is closed. Reconnect will be attempted in 3 second.", ev);
                this.reconnectTimer = window.setTimeout(() => {
                    this.reconnectTimer = undefined;
                    this.connect({
                        id: options.id,
                        type: options.type,
                        msgCallback: options.msgCallback
                    });
                }, 3000);
            }
        };
        ws.onerror = (err: Event & { target: { url: string, readyState: number } }) => {
            if (err.target.url.endsWith("&type=main") && err.target.readyState === 3) {
                const {kernelError}: typeof import("../util/kernelFault") = require("../util/kernelFault");
                kernelError();
            }
        };
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.close();
        }
        this.ws = ws;
    }

    // 页面进入 Back-Forward Cache 前主动断开：Chrome 会在页面进入 bfcache 时
    // 强制掐断 WebSocket 并在控制台报错，主动关闭可避免
    public pause() {
        if (!this.ws || WebSocket.OPEN < this.ws.readyState) {
            return;
        }
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
        this.ws.close();
    }

    // 页面从 Back-Forward Cache 恢复后立即重建连接
    public resume() {
        if (!this.connectOptions || (this.ws && WebSocket.OPEN === this.ws.readyState)) {
            return;
        }
        this.connect(this.connectOptions);
    }

    public send(cmd: string, param: Record<string, unknown>, process = false) {
        if (!this.ws ||
            this.ws.readyState === WebSocket.CLOSING ||
            this.ws.readyState === WebSocket.CLOSED) { // Inbox 无 WebSocket，关闭中的连接不能继续发送
            return;
        }
        this.reqId = process ? 0 : Date.now();
        this.ws.send(JSON.stringify({
            cmd,
            reqId: this.reqId,
            param,
            // pushMode
            // 0: 所有应用所有会话广播
            // 1：自我应用会话单播
            // 2：非自我会话广播
            // 4：非自我应用所有会话广播
            // 5：单个应用内所有会话广播
            // 6：非自我应用主会话广播
        }));
    }

    public destroy() {
        // 子类按需释放模型持有的资源。
    }
}

// 页面进入 Back-Forward Cache 时 Chrome 会强制断开 WebSocket，
// pagehide 时主动关闭、pageshow(persisted) 恢复时立即重连
window.addEventListener("pagehide", () => {
    activeModels.forEach((model) => model.pause());
});
window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
        activeModels.forEach((model) => model.resume());
    }
});
// ws.close() 的关闭握手无法保证在页面冻结前完成，CLOSING 状态的连接仍会被
// Chrome 记为 failed。注册 beforeunload 使页面不符合 BFCache 条件，从根源消除该报错，
// 代价是后退导航时整页重载而非瞬时恢复
window.addEventListener("beforeunload", () => {
    // no-op，仅用于使页面退出 BFCache 资格
});
