# 上游更新后怎么应用改造

## 一、先判断能不能自动套用

```powershell
cd F:\dsh-qq-plugin-custom
.\tools\upgrade.ps1 -NewVersion 1.0.6
```

脚本会：

1. 拉取新版纯净包到 `upstream/1.0.6/`
2. 逐个补丁尝试应用
3. 报告哪些**干净应用**、哪些**冲突**
4. 冲突的补丁留在 `conflicts/` 里供手工合并

---

## 二、如果全部干净应用

脚本会输出 `全部 N 个补丁应用成功`。

接下来：

```powershell
# 1. 跑测试（必须全绿才继续）
.\tools\test.ps1

# 2. 装回插件目录
.\tools\deploy.ps1

# 3. 重启 dsh web
```

---

## 三、如果有冲突

**别慌**。冲突通常只有一两个补丁，原因几乎总是这两种：

### 情况 A：上游改了同一个函数

比如上游重构了 `#flushReply`，而改造 1 也改了它。

处理方式：

1. 打开 `conflicts/改造1-旁白过滤.patch`
2. 看冲突块（`<<<<<<<` 标记）
3. 手工合并到 `upstream/新版本/lib/runtime.js`
4. 合并后删掉冲突标记
5. 重新生成该补丁：

```powershell
.\tools\regen-patch.ps1 -Name "改造1-旁白过滤"
```

### 情况 B：上游已经实现了同样的功能

比如上游某版自己加了 `notifyAllSessions`。

处理方式：**丢掉这个补丁**。

1. 从 `patches/` 里删掉对应文件
2. 更新 `docs/CHANGES.md` 标注"上游已实现，废弃"

---

## 四、补丁清单与依赖关系

补丁按编号顺序应用，**有依赖**：

```
01-旁白过滤.patch          （独立）
02-全局推送.patch          （独立）
03-推送带提问.patch        （依赖 02）
04-run指令.patch           （独立）
05-切换补发提问.patch      （依赖 04）
06-快速对话111.patch       （独立）
07-提问兜底.patch          （依赖 04、05）
08-rrr回话.patch           （依赖 02）
09-忙时四选一.patch        （依赖 04）
10-markdown转纯文本.patch  （独立）
11-model列表选择.patch     （独立）
12-触发词放宽.patch        （依赖 06、08）
```

**应用顺序不能乱**。`upgrade.ps1` 已按编号排好。

---

## 五、每次改完要做的三件事

1. **跑测试**：`.\tools\test.ps1`，必须全绿
2. **更新 CHANGES.md**：新改造加一节，废弃的标注清楚
3. **提交**：

```powershell
git add -A
git commit -m "适配上游 1.0.6"
git push
```

---

## 六、紧急回滚

```powershell
# 回到上一个提交
git checkout -- .
# 或者看历史
git log --oneline
```

插件目录本身也留了备份：`~/.dsh/dsh-qq-plugin-patch-backup/`
