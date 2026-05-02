#!/usr/bin/env node
/**
 * do-update.mjs
 * 执行 OMP 插件更新
 * 从 GitHub 下载最新代码并安装到插件缓存目录
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const pluginRoot = path.resolve(__dirname, '..');

console.log('🔍 正在检查更新...');

// 读取当前版本
const pluginJsonPath = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
let currentVersion = '0.0.0';
try {
  const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
  currentVersion = pluginJson.version || '0.0.0';
} catch (e) {
  console.error('❌ 无法读取当前版本');
  process.exit(1);
}

// 获取最新版本
const https = await import('https');
const githubUrl = 'https://raw.githubusercontent.com/LigphiDonk/Oh-my--paper/main/plugins/oh-my-paper/.claude-plugin/plugin.json';

function fetchGitHub(url) {
  return new Promise((resolve, reject) => {
    https.default.get(url, (res) => {
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
  console.error('❌ 无法获取最新版本信息，请检查网络连接');
  console.error('   ', e.message);
  process.exit(1);
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

if (compareVersions(currentVersion, latestVersion) >= 0) {
  console.log(`✅ 已是最新版本 (${currentVersion})`);
  process.exit(0);
}

console.log(`📦 发现新版本：${latestVersion} (当前：${currentVersion})`);
console.log('⬇️  正在下载最新代码...');

// 创建临时目录
const tempDir = `/tmp/omp-update-${Date.now()}`;
try {
  execSync(`git clone --depth 1 https://github.com/LigphiDonk/Oh-my--paper.git "${tempDir}"`, {
    stdio: 'inherit'
  });
} catch (e) {
  console.error('❌ 下载失败，请检查网络连接或手动更新');
  console.error('   手动更新命令：');
  console.error('   /plugin uninstall omp');
  console.error('   /plugin install omp@oh-my-paper');
  console.error('   /reload-plugins');
  process.exit(1);
}

console.log('📋 正在安装更新...');

// 确定插件缓存路径
const home = process.env.HOME || process.env.USERPROFILE || '';
const cachePath = path.join(home, '.claude', 'plugins', 'cache', 'oh-my-paper', 'omp', '1.0.0');

// 如果缓存目录存在，复制到缓存
if (fs.existsSync(cachePath)) {
  const src = path.join(tempDir, 'plugins', 'oh-my-paper');
  if (fs.existsSync(src)) {
    try {
      // 使用 rsync 或 cp 复制
      execSync(`cp -r "${src}/." "${cachePath}/"`, { stdio: 'inherit' });
      console.log('✅ 更新完成！');
      console.log('');
      console.log('⚠️  重要提示：');
      console.log('   1. 请运行 /reload-plugins 重新加载插件');
      console.log('   2. 如果 hooks 有变更，请重启 Claude Code');
      console.log('');
    } catch (e) {
      console.error('❌ 安装失败：', e.message);
      console.error('   请尝试手动更新：');
      console.error('   /plugin uninstall omp');
      console.error('   /plugin install omp@oh-my-paper');
      process.exit(1);
    }
  } else {
    console.error('❌ 下载的代码结构异常');
    process.exit(1);
  }
} else {
  console.log('ℹ️  未找到插件缓存目录，将使用手动安装方式');
  console.log('');
  console.log('请手动执行以下命令更新：');
  console.log('  /plugin uninstall omp');
  console.log('  /plugin install omp@oh-my-paper');
  console.log('  /reload-plugins');
}

// 清理临时目录
try {
  execSync(`rm -rf "${tempDir}"`);
} catch (e) {
  // 忽略清理错误
}

// 更新版本号（如果在开发环境中）
try {
  const localPluginJson = path.join(root, 'plugins', 'oh-my-paper', '.claude-plugin', 'plugin.json');
  if (fs.existsSync(localPluginJson)) {
    const localJson = JSON.parse(fs.readFileSync(localPluginJson, 'utf8'));
    localJson.version = latestVersion;
    fs.writeFileSync(localPluginJson, JSON.stringify(localJson, null, 2));
  }
  
  const localMarketplaceJson = path.join(root, '.claude-plugin', 'marketplace.json');
  if (fs.existsSync(localMarketplaceJson)) {
    const marketJson = JSON.parse(fs.readFileSync(localMarketplaceJson, 'utf8'));
    if (marketJson.metadata) marketJson.metadata.version = latestVersion;
    fs.writeFileSync(localMarketplaceJson, JSON.stringify(marketJson, null, 2));
  }
} catch (e) {
  // 忽略版本号更新错误
}

console.log('📝 更新日志已记录');
process.exit(0);
