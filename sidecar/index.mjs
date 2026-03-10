import process from "node:process";

import { runAgent } from "./agent.mjs";

function parsePayload() {
  const raw = process.argv[3] ?? "{}";
  return JSON.parse(raw);
}

async function main() {
  const command = process.argv[2];

  switch (command) {
    case "agent": {
      const payload = parsePayload();
      await runAgent(payload);
      break;
    }
    case "test-provider": {
      const payload = parsePayload();
      await testProvider(payload);
      break;
    }
    case "figure-skill": {
      const payload = parsePayload();
      await runFigureSkill(payload);
      break;
    }
    case "banana": {
      const payload = parsePayload();
      await runBanana(payload);
      break;
    }
    default:
      process.stderr.write(`Unknown sidecar command: ${command}\n`);
      process.exitCode = 1;
  }
}

async function testProvider(config) {
  const { loadProvider } = await import("./providers/index.mjs");
  const provider = loadProvider(config);

  try {
    const messages = [{ role: "user", content: "Say 'ok' and nothing else." }];
    for await (const _chunk of provider.chat({ messages, tools: [] })) {
      // Streaming success is enough.
    }
    process.stdout.write(JSON.stringify({ success: true }));
  } catch (error) {
    process.stderr.write(error?.message || String(error));
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

  const { apiKey, baseUrl, prompt, aspectRatio, resolution, projectRoot, briefId } = payload;
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
