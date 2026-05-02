#!/usr/bin/env node
/**
 * check-update.mjs
 * 检查 OMP 插件是否有可用更新
 * 退出码：0 = 有更新，1 = 已是最新，2 = 检查失败
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');

// 读取当前版本
const pluginJsonPath = path.join(root, '.claude-plugin', 'plugin.json');
let currentVersion = '0.0.0';

try {
  const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
  currentVersion = pluginJson.version || '0.0.0';
} catch (e) {
  console.error('❌ 无法读取当前版本');
  process.exit(2);
}

// 获取最新版本（从 GitHub）
const githubUrl = 'https://raw.githubusercontent.com/LigphiDonk/Oh-my--paper/main/plugins/oh-my-paper/.claude-plugin/plugin.json';

function fetchGitHub(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

let latestVersion = '0.0.0';
try {
  const data = await fetchGitHub(githubUrl);
  const latestJson = JSON.parse(data);
  latestVersion = latestJson.version || '0.0.0';
} catch (e) {
  // 网络失败，静默处理
  process.exit(2);
}

// 比较版本
function compareVersions(a, b) {
  const aa = a.split('.').map(Number);
  const bb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const av = aa[i] || 0;
    const bv = bb[i] || 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

const result = compareVersions(currentVersion, latestVersion);

if (result < 0) {
  console.log(`🔔 发现新版本！`);
  console.log(`   当前版本：${currentVersion}`);
  console.log(`   最新版本：${latestVersion}`);
  console.log(`   运行 /omp:update 更新`);
  process.exit(0);
} else {
  process.exit(1);
}
