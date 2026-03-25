import process from "node:process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";

/**
 * Shared EventEmitter that fires 'line' events for each NDJSON line
 * received on stdin after the initial payload line.
 */
export const stdinLineEmitter = new EventEmitter();

let _payloadResolve = null;
const _payloadPromise = new Promise((resolve) => {
  _payloadResolve = resolve;
});

// Set up readline on stdin to capture the first line as payload,
// then emit subsequent lines for runner-level IPC (e.g. permission responses).
let _firstLineConsumed = false;
if (!process.stdin.isTTY) {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!_firstLineConsumed) {
      _firstLineConsumed = true;
      try {
        _payloadResolve(JSON.parse(line));
      } catch {
        _payloadResolve({});
      }
      return;
    }
    // Subsequent lines → emit for runner IPC
    stdinLineEmitter.emit("line", line);
  });
  rl.on("close", () => {
    if (!_firstLineConsumed) {
      _payloadResolve({});
    }
  });
} else {
  _payloadResolve({});
}

async function parsePayload() {
  const raw = process.argv[3];
  if (raw && raw !== "--stdin-payload") {
    return JSON.parse(raw);
  }
  return _payloadPromise;
}

async function main() {
  const command = process.argv[2];

  switch (command) {
    case "detect-cli": {
      const { detectAllCliAgents } = await import("./utils/detect-cli.mjs");
      const result = await detectAllCliAgents();
      process.stdout.write(JSON.stringify(result));
      break;
    }
    case "detect-zotero-mcp": {
      const { detectCommandStatus } = await import("./utils/resolve-cli.mjs");
      const result = await detectCommandStatus("zotero-mcp", "zotero-mcp");
      process.stdout.write(JSON.stringify(result));
      break;
    }
    case "figure-skill": {
      const payload = await parsePayload();
      await runFigureSkill(payload);
      break;
    }
    case "banana": {
      const payload = await parsePayload();
      await runBanana(payload);
      break;
    }
    case "ingest-literature": {
      const payload = await parsePayload();
      const { ingestLiteraturePdf } = await import("./utils/literature_ingest.mjs");
      const result = await ingestLiteraturePdf(payload);
      process.stdout.write(JSON.stringify(result));
      break;
    }
    case "search-zotero-literature": {
      const payload = await parsePayload();
      const { searchZoteroLiterature } = await import("./utils/zotero-mcp.mjs");
      const result = await searchZoteroLiterature(payload);
      process.stdout.write(JSON.stringify(result));
      break;
    }
    case "import-zotero-literature": {
      const payload = await parsePayload();
      const { importZoteroLiterature } = await import("./utils/zotero-mcp.mjs");
      const result = await importZoteroLiterature(payload);
      process.stdout.write(JSON.stringify(result));
      break;
    }
    default:
      process.stderr.write(`Unknown sidecar command: ${command}\n`);
      process.exitCode = 1;
  }
}

async function runFigureSkill(payload) {
  process.stdout.write(
    JSON.stringify({
      id: payload.briefId,
      sourceSectionRef: "active-section",
      briefMarkdown: `${payload.briefMarkdown}\n\n## Style direction\nUse a journal-style figure with restrained color.`,
      promptPayload: `${payload.promptPayload} Return a clean wide workflow figure.`,
      status: "ready",
    }),
  );
}

async function runBanana(payload) {
  const { randomUUID } = await import("node:crypto");
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { resolve } = await import("node:path");

  const {
    apiKey,
    baseUrl,
    prompt,
    aspectRatio,
    resolution,
    projectRoot,
    briefId,
  } = payload;
  const url = `${baseUrl || "https://api.ikuncode.cc/v1"}/images/generations`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gemini-3-pro-image-preview",
      prompt,
      aspect_ratio: aspectRatio || "16:9",
      resolution: resolution || "2k",
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    process.stderr.write(`Banana API error: ${response.status} ${errText}`);
    process.exitCode = 1;
    return;
  }

  const result = await response.json();
  const imageData = result.data?.[0]?.b64_json || result.data?.[0]?.url;
  const figureId = randomUUID();
  const fileName = `figure-${figureId.slice(0, 8)}.png`;
  const assetsDir = resolve(projectRoot || ".", "assets", "figures");
  mkdirSync(assetsDir, { recursive: true });
  const filePath = resolve(assetsDir, fileName);

  if (imageData && !String(imageData).startsWith("http")) {
    writeFileSync(filePath, Buffer.from(imageData, "base64"));
  } else if (imageData) {
    const imgResponse = await fetch(imageData);
    writeFileSync(filePath, Buffer.from(await imgResponse.arrayBuffer()));
  }

  process.stdout.write(
    JSON.stringify({
      id: figureId,
      kind: "figure",
      filePath: `assets/figures/${fileName}`,
      sourceBriefId: briefId,
      metadata: {
        generator: "banana",
        createdAt: new Date().toISOString(),
        format: "png",
        prompt,
      },
      previewUri: `file://${filePath}`,
    }),
  );
}

main().catch((error) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
