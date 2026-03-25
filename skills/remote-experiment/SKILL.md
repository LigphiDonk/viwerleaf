---
id: remote-experiment
name: Remote Experiment Execution
version: 1.0.0
stages: [experiment]
tools: [bash, read_file, write_file]
description: 在远程计算节点上自主执行实验、解析指标、决策优化方向
summary: Autonomous remote experiment execution via compute-helper CLI — sync, run, collect, evaluate, iterate
primaryIntent: remote_experiment_execution
capabilities:
  - remote_code_sync
  - remote_command_execution
  - metric_parsing
  - autonomous_optimization
domains:
  - machine_learning
  - reinforcement_learning
keywords:
  - experiment
  - remote
  - gpu
  - training
  - evaluation
  - compute-helper
---

# Remote Experiment Execution

你可以通过 `compute-helper` CLI 在远程 GPU 服务器上自主执行实验。

## 环境感知

启动时请检查计算节点：
1. 运行 `node <compute-helper-path> info` 查看节点配置
2. 如果失败，查看 `~/.viewerleaf/compute-nodes.json`
3. 确认节点连通后才开始实验

> compute-helper 路径通常在 system prompt 的 `<compute_node>` 块中给出。
> 如果没有，尝试在项目的 sidecar/bin/ 目录下查找。

## 工作流程

### 第 1 步：代码同步
```bash
node <helper> sync up --cwd <project_root>
```
将本地代码同步到远程服务器。rsync 会自动排除 `.git/`, `node_modules/`, `__pycache__/`, `.venv/` 等。

### 第 2 步：远程执行
```bash
node <helper> run "<command>" --cwd <project_root>
```
自动同步 + 远程执行。例如：
```bash
node <helper> run "python run_evaluation.py --n_episodes 50 --seed 42 --mode cbf" --cwd <project_root>
```

### 第 3 步：收集结果
```bash
node <helper> sync down --cwd <project_root> --files "results/ logs/ checkpoints/"
```

### 第 4 步：纯 SSH 执行（不同步）
```bash
node <helper> ssh "nvidia-smi"
node <helper> ssh "cd /path && python train.py"
```

## 指标输出规范

**关键要求：** 评估脚本必须在 stdout 输出一行 JSON 指标，例如：
```
{"ISR": 0.8523}
```
自动实验系统会解析这一行来判断是否达标。如果你修改了评估脚本，确保输出格式不变。

## 自主优化决策

每次迭代你应该：

1. **分析历史** — 读取之前的实验结果 (`results/` 目录)，了解哪些参数组合已经尝试过
2. **诊断瓶颈** — 根据指标走势判断是：
   - 收敛太慢 → 调大学习率或 batch size
   - 过拟合 → 增加正则化、early stopping
   - 策略质量差 → 改奖励函数设计
   - 安全约束冲突 → 调整 CBF 参数
3. **提出改进** — 选择 ONE 个最可能有效的改动（不要同时改多个变量）
4. **实施修改** — 修改代码文件
5. **执行评估** — sync up + run，等待结果
6. **汇报进展** — 清晰说明：
   - 这次改了什么，为什么
   - 指标变化 (例如 ISR: 0.72 → 0.78)
   - 下一步方向

## 优化策略库

### 超参数优化
- 学习率：先固定其他参数，网格搜索 {1e-4, 3e-4, 1e-3}
- Batch size：根据 GPU 内存，尝试 {32, 64, 128}
- 网络结构：层数、隐藏维度

### 算法优化
- MAPPO：GAE 参数 λ，clip ratio ε，entropy bonus
- MADDPG：soft update τ，replay buffer 大小，exploration noise

### 安全约束 (CBF)
- CBF 权重平衡安全与性能
- 安全裕度 (safety margin) 调整
- 约束违反惩罚系数

### 训练策略
- 课程学习：从简单场景逐步到复杂场景
- 自博弈 (self-play)：对手策略多样性
- 多种子平均：至少 3 个随机种子验证鲁棒性

## 进度汇报格式

每次迭代结束后，用以下格式汇报：

```
📊 实验迭代报告
━━━━━━━━━━━━━━
轮次: 3/10
改动: 将 MAPPO clip ratio 从 0.2 调整为 0.1
指标: ISR = 0.7823 (上轮: 0.7512, 最优: 0.7823)
阈值: ISR ≥ 0.85
状态: 继续优化
下一步: 尝试增大 entropy bonus 以增加探索
```
