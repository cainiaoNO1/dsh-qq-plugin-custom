# dsh-qq-plugin 自用改造版

在上游 [`dsh-qq-plugin`](https://github.com/xcisxc29/dsh-qq-plugin) 基础上做自用改造，
**不 fork 整个仓库**，而是保存"上游 + 补丁"的组合。

- 上游基线：`dsh-qq-plugin@1.0.3`
- 改造数量：12 项
- 测试：441 项

---

## 为什么这样组织

上游更新频繁。如果直接 fork 改代码，每次上游发版都要手工 merge 一大堆文件。
这里改成**补丁**：每个改动是一份可独立应用、可独立跳过的 diff，
上游更新后跑一次脚本就知道哪些能干净套用、哪些需要手工看。

```
upstream/1.0.3/     上游纯净副本（基线，不修改）
patches/            按文件拆的补丁
tests/              441 项自测
tools/              升级 / 部署 / 测试脚本
docs/CHANGES.md     每一项改造的详细说明
docs/UPGRADE.md     上游更新后怎么做
```

---

## 当前改了什么

见 [docs/CHANGES.md](docs/CHANGES.md)。12 项改造一句话概括：

| # | 改造 | 一句话 |
|---|---|---|
| 1 | 旁白过滤 | 过程性思考不再一条条刷屏 |
| 2 | 全局推送 | 任何会话跑完都推结果到 QQ |
| 3 | 推送带提问 | 推送开头带上你当时的提问 |
| 4 | `/run` | 看正在跑的任务，可切过去 |
| 5 | 切换补发提问 | 切会话后显示它最后一次提问 |
| 6 | `111` 快速对话 | 发到另一个目录的会话，不动当前绑定 |
| 7 | 提问兜底 | 修 `/run` 显示"内容未知" |
| 8 | `rrr` | 回话给最近跑完的会话 |
| 9 | 忙时四选一 | 会话正忙时问插入/排队/分叉/撤回 |
| 10 | Markdown 转纯文本 | QQ 不渲染 Markdown，转掉 |
| 11 | `/model` 列表选择 | 回编号直接切模型 |
| 12 | 触发词放宽 | `111` 不空格也能识别 |

---

## 日常操作

### 部署到 DSH

```powershell
.\tools\deploy.ps1
# 然后重启 dsh web
```

### 跑测试

```powershell
.\tools\test.ps1
```

### 上游更新了

```powershell
.\tools\upgrade.ps1 -NewVersion 1.0.6
```

详细步骤见 [docs/UPGRADE.md](docs/UPGRADE.md)。

---

## 注意

- 这套补丁**绑定上游 1.0.3 的上下文行**。上游改同一批函数时补丁会冲突，属于预期。
- `patches/*.patch` 被 `.gitattributes` 标记为 `-text`，**不要**让编辑器改它们的行尾。
- 部署前先跑 `test.ps1`，全绿再装。

---

## 许可

上游是 MIT。这里的改造补丁同样是 MIT。
