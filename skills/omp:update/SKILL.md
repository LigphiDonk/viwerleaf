---
id: omp:update
name: omp:update
version: 1.0.0
description: 一键更新 OMP 插件到最新版本，支持自动检查更新
stages: []
tools: [read_file, write_file, Bash, AskUserQuestion]
---

# omp:update - 一键更新插件

使用此技能更新 Oh My Paper 插件到最新版本。

## 调用方式

```
/omp:update [--check-only] [--auto]
```

### 参数
| 参数 | 说明 | 示例 |
|------|------|------|
| `--check-only` | 仅检查是否有新版本，不执行更新 | `/omp:update --check-only` |
| `--auto` | 自动更新，不询问确认 | `/omp:update --auto` |

## 功能说明

### 1. 版本检查
- 读取当前版本：`.claude-plugin/plugin.json` 中的 `version` 字段
- 获取最新版本：从 GitHub 仓库获取最新的 `plugin.json`
- GitHub 原始文件 URL：`https://raw.githubusercontent.com/LigphiDonk/Oh-my--paper/main/plugins/oh-my-paper/.claude-plugin/plugin.json`

### 2. 版本比较
使用语义化版本比较（semver）：
- 格式：`major.minor.patch`
- 比较规则：从左到右依次比较每个数字
- 示例：`1.0.0` < `1.0.1` < `1.1.0` < `2.0.0`

### 3. 更新流程
如果检测到新版本：

#### 方案 A：使用 Claude Code 内置命令（推荐）
```bash
# 卸载旧版本
/plugin uninstall omp

# 安装最新版本
/plugin install omp@oh-my-paper

# 重新加载插件
/reload-plugins
```

#### 方案 B：直接覆盖缓存（快速）
```bash
# 下载最新代码
git clone https://github.com/LigphiDonk/Oh-my--paper.git /tmp/omp-update

# 复制到插件缓存
cp -r /tmp/omp-update/plugins/oh-my-paper/. \
  ~/.claude/plugins/cache/oh-my-paper/omp/1.0.0/

# 重新加载插件
/reload-plugins

# 清理临时文件
rm -rf /tmp/omp-update
```

### 4. 更新后处理
- 更新 `.claude-plugin/marketplace.json` 中的版本号
- 提示用户重启 Claude Code（如果 hooks 有变更）
- 记录更新日志到 `.pipeline/memory/update_log.md`

## 自动化检查机制

### SessionStart 时检查
在 `scripts/on-session-start.mjs` 中增加更新检查逻辑：

```javascript
// 检查更新（每日最多一次）
const lastCheck = readLastUpdateCheck();
const today = new Date().toISOString().split('T')[0];

if (lastCheck !== today) {
  const updateAvailable = await checkForUpdate();
  if (updateAvailable) {
    console.log('🔔 发现新版本，运行 /omp:update 更新');
  }
  writeLastUpdateCheck(today);
}
```

### 检查记录文件
创建 `.pipeline/.last-update-check` 文件，记录最后一次检查日期：
```
2026-05-02
```

## 实现步骤

### 步骤 1：创建更新检查脚本
创建 `scripts/check-update.mjs`：

```javascript
#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// 读取当前版本
const pluginJsonPath = path.join(root, '.claude-plugin/plugin.json');
const current = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
const currentVersion = current.version;

// 获取最新版本
const githubUrl = 'https://raw.githubusercontent.com/LigphiDonk/Oh-my--paper/main/plugins/oh-my-paper/.claude-plugin/plugin.json';
const response = await fetch(githubUrl);
const latest = await response.json();
const latestVersion = latest.version;

// 比较版本
function compareVersions(a, b) {
  const aa = a.split('.').map(Number);
  const bb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (aa[i] > bb[i]) return 1;
    if (aa[i] < bb[i]) return -1;
  }
  return 0;
}

const result = compareVersions(currentVersion, latestVersion);
if (result < 0) {
  console.log(`New version available: ${latestVersion} (current: ${currentVersion})`);
  process.exit(0); // 有新版本
} else {
  console.log(`Already up to date (version: ${currentVersion})`);
  process.exit(1); // 已是最新
}
```

### 步骤 2：修改 SessionStart hook
在 `plugins/oh-my-paper/scripts/on-session-start.mjs` 中增加更新检查：

```javascript
// 检查更新（每日最多一次）
const lastCheckFile = path.join(projectRoot, '.pipeline', '.last-update-check');
const today = new Date().toISOString().split('T')[0];
let shouldCheck = true;

if (fs.existsSync(lastCheckFile)) {
  const lastCheck = fs.readFileSync(lastCheckFile, 'utf8').trim();
  if (lastCheck === today) shouldCheck = false;
}

if (shouldCheck) {
  try {
    const checkScript = path.join(pluginRoot, 'scripts', 'check-update.mjs');
    const result = runCommand(`node "${checkScript}"`);
    if (result.exitCode === 0) {
      // 有新版本，提示用户
      console.log('\n🔔 OMP 插件有可用更新！');
      console.log('   运行 /omp:update 更新到最新版本\n');
    }
  } catch (e) {
    // 检查失败，静默忽略
  }
  fs.writeFileSync(lastCheckFile, today);
}
```

### 步骤 3：创建更新执行脚本
创建 `scripts/do-update.mjs`：

```javascript
#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve('.');
const cachePath = path.join(process.env.HOME, '.claude', 'plugins', 'cache', 'oh-my-paper', 'omp', '1.0.0');

// 下载最新代码
const tempDir = '/tmp/omp-update-' + Date.now();
execSync(`git clone --depth 1 https://github.com/LigphiDonk/Oh-my--paper.git "${tempDir}"`);

// 复制到缓存
const src = path.join(tempDir, 'plugins', 'oh-my-paper');
execSync(`cp -r "${src}/." "${cachePath}/"`);

// 清理
execSync(`rm -rf "${tempDir}"`);

console.log('✅ 更新完成，请运行 /reload-plugins 重新加载插件');
```

## 使用示例

### 示例 1：检查更新
```
/omp:update --check-only
```

输出：
```
当前版本：1.0.0
最新版本：1.1.0
🎉 发现新版本！运行 /omp:update 更新
```

### 示例 2：执行更新
```
/omp:update
```

输出：
```
正在检查版本...
发现新版本：1.1.0
正在下载最新代码...
正在安装更新...
✅ 更新完成！
请运行 /reload-plugins 重新加载插件
```

## 注意事项

1. **备份重要配置**：更新前建议备份 `.pipeline/` 目录
2. **Hooks 更新需要重启**：如果 hooks 有变更，必须重启 Claude Code
3. **网络依赖**：更新需要访问 GitHub，确保网络连通性
4. **版本回滚**：如果更新后出现问题，可以手动下载指定版本并覆盖缓存

## 自动更新检查配置

在 `.pipeline/memory/update_config.json` 中配置自动检查行为：

```json
{
  "autoCheck": true,
  "checkIntervalDays": 1,
  "autoInstall": false,
  "lastCheck": "2026-05-02"
}
```

- `autoCheck`: 是否启用自动检查
- `checkIntervalDays`: 检查间隔（天）
- `autoInstall`: 是否自动安装更新（谨慎启用）
