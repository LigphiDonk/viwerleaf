import { spawn } from "node:child_process";

export class McpStdioClient {
  constructor(command, args = [], env = {}) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.stderr = "";
    this.exitError = null;
  }

  async connect() {
    if (this.child) {
      return;
    }

    this.child = spawn(this.command, this.args, {
      env: {
        ...process.env,
        ...this.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.#drainBuffer();
    });

    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString("utf8");
    });

    this.child.on("error", (error) => {
      this.exitError = error;
      this.#rejectAll(error);
    });

    this.child.on("exit", (code, signal) => {
      if (code === 0) {
        return;
      }
      const exitLabel = signal || code || "unknown";
      const error = new Error(
        `MCP server exited unexpectedly (${exitLabel}): ${this.stderr || "no stderr"}`,
      );
      this.exitError = error;
      this.#rejectAll(error);
    });
  }

  async initialize() {
    await this.connect();

    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "viewerleaf-sidecar",
        version: "0.2.1",
      },
    });

    await this.notify("notifications/initialized", {});
  }

  async listTools() {
    const result = await this.request("tools/list", {});
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name, args = {}) {
    return this.request("tools/call", {
      name,
      arguments: args,
    });
  }

  async request(method, params) {
    if (!this.child?.stdin || this.exitError) {
      throw this.exitError || new Error("MCP server is not connected");
    }

    const id = this.nextId++;
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    this.#writeMessage(payload);
    return promise;
  }

  async notify(method, params) {
    if (!this.child?.stdin || this.exitError) {
      throw this.exitError || new Error("MCP server is not connected");
    }

    this.#writeMessage({
      jsonrpc: "2.0",
      method,
      params,
    });
  }

  async close() {
    if (!this.child) {
      return;
    }

    this.child.kill();
    this.child = null;
    this.pending.clear();
    this.buffer = Buffer.alloc(0);
  }

  #writeMessage(message) {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
    this.child.stdin.write(Buffer.concat([header, body]));
  }

  #drainBuffer() {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }

      const headerText = this.buffer.slice(0, headerEnd).toString("utf8");
      const contentLengthMatch = headerText.match(/Content-Length:\s*(\d+)/i);
      if (!contentLengthMatch) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = Number.parseInt(contentLengthMatch[1], 10);
      const totalLength = headerEnd + 4 + contentLength;
      if (this.buffer.length < totalLength) {
        return;
      }

      const body = this.buffer.slice(headerEnd + 4, totalLength).toString("utf8");
      this.buffer = this.buffer.slice(totalLength);

      let message;
      try {
        message = JSON.parse(body);
      } catch {
        continue;
      }

      if (message.id != null && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
        } else {
          pending.resolve(message.result);
        }
      }
    }
  }

  #rejectAll(error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
