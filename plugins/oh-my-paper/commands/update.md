---
description: 一键更新 OMP 插件到最新版本，支持自动检查更新
---

> **OMP 插件更新工具**
> 此命令会检查 GitHub 上的最新版本，并自动更新插件。

## 第一步：解析参数

支持的参数：
- `--check-only` — 仅检查更新，不执行安装
- `--auto` — 自动更新，不询问确认

如果用户只输入 `/omp:update --check-only`，跳到"第三步：检查版本"。

## 第二步：确认更新

如果没有 `--auto` 参数，用 `AskUserQuestion` 询问用户：

> 检测到 OMP 插件更新可用。
> 更新将：
> 1. 从 GitHub 下载最新代码
> 2. 安装到插件缓存目录
> 3. 提示重新加载插件
>
> 是否继续？

选项：
- `立即更新` — 继续执行更新
- `仅检查版本` — 跳到第三步，只检查不安装
- `取消` — 中止更新

## 第三步：检查版本

运行版本检查脚本：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-update.mjs"
```

检查脚本会：
1. 读取当前版本（`.claude-plugin/plugin.json`）
2. 从 GitHub 获取最新版本
3. 比较版本号

退出码：
- `0` = 有新版本
- `1` = 已是最新
- `2` = 检查失败（网络错误等）

如果已是最新版本（退出码 1）：
> ✅ 已是最新版本（当前版本：x.x.x）

如果检查失败（退出码 2）：
> ⚠️ 无法检查更新，请检查网络连接

## 第四步：执行更新

如果有新版本（退出码 0），运行更新脚本：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/do-update.mjs"
```

更新脚本会：
1. 显示当前版本和最新版本
2. 从 GitHub 克隆最新代码到临时目录
3. 复制到插件缓存目录
4. 清理临时文件
5. 更新本地版本号（如果在开发环境）

## 第五步：完成提示

更新完成后，显示：

> ✅ **OMP 插件更新完成！**
>
> **更新详情：**
> - 当前版本：x.x.x
> - 最新版本：y.y.y
> - 更新时间：YYYY-MM-DD HH:mm
>
> **下一步：**
> 1. 运行 `/reload-plugins` 重新加载插件
> 2. 如果 hooks 有变更，请重启 Claude Code
>
> 更新日志已记录到 `.pipeline/memory/update_log.md`

## 错误处理

### 网络错误
> ❌ 无法连接到 GitHub，请检查网络连接。
> 可以稍后重试，或手动更新：
> ```
> /plugin uninstall omp
> /plugin install omp@oh-my-paper
> /reload-plugins
> ```

### Git 未安装
> ❌ 未检测到 Git。请安装 Git 后重试，或手动更新插件。

### 权限错误
> ❌ 无权限写入插件缓存目录。
> 请检查目录权限：`~/.claude/plugins/cache/oh-my-paper/`

## 更新日志

每次更新后，追加记录到 `.pipeline/memory/update_log.md`：

```markdown
# Update Log

## 2026-05-02 09:45
- 版本：1.0.0 → 1.1.0
- 方式：自动更新
- 状态：成功
- 用户：guojiong
```

如果 `.pipeline/memory/update_log.md` 不存在，先创建它。
