# DSH 文件撤回（Revert）功能 — 补丁包

给 DSH Desktop 的 edit/write 工具结果卡片加上 **「撤回」按钮**：一键把文件恢复到该次
修改之前的完整内容。同时提供 `/fs_revert <callId>` 命令作为底层入口。

> 为什么是补丁而不是直接改安装目录：`C:\Program Files\DSH Desktop` 的 ACL 对普通用户
> 只读（`BUILTIN\Users: ReadAndExecute`），本次会话进程非管理员，无法就地写入。
> 因此这里交付**完整修改后的文件 + unified diff + 管理员应用脚本**，由你（或管理员
> 环境）执行部署。

## 目录

```
revert-feature/
├── final/                        # 修改后的完整文件（部署时复制这些）
│   └── @deepseek-ai/
│       ├── dsh-tool-fs/lib/index.js          # 服务端：revert 基准持久化 + /fs_revert 命令
│       └── dsh-client-ui-tool/lib/client.js  # 客户端：diff 卡片上的「撤回」按钮
├── patches/                      # 两个 unified diff（git diff --no-index，供 review）
│   ├── dsh-tool-fs.patch
│   └── dsh-client-ui-tool.patch
├── apply.ps1                     # 管理员应用脚本（备份 + 复制 + 提示）
├── .check/                       # 测试目录（含指向安装目录 node_modules 的 junction）
│   ├── test-revert.mjs           # 纯函数冒烟测试（21 断言）
│   └── test-revert-flow.mjs      # 端到端命令处理器测试（6 断言）
└── README.md
```

## 部署

1. **关闭 DSH Desktop**。
2. 以管理员身份运行：
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\apply.ps1
   ```
   （脚本会自动尝试提权；原文件先备份到 `backup\<时间戳>\`。）
3. 重新启动 DSH Desktop。
   - 客户端 bundle 以启动时计算的内容哈希作为 URL rev，**必须重启**浏览器才会拉取
     新 bundle，仅硬刷新可能仍命中旧缓存。

## 使用

- 让模型执行一次 `edit`（或覆盖式 `write`）后，行内卡片底部会出现 **「撤回」** 按钮：
  - 第一次点击 → 变成 **「确认撤回？」**；
  - 第二次点击 → 执行（**「撤回中…」→「已撤回」**，失败显示 **「撤回失败」**，悬停可看原因）；
  - 点错可再次点击「撤回失败」复位。
- 也可以直接在输入框敲 `/fs_revert <callId>`（callId 就是卡片上的
  `data-chat-call-id` / Inspect 面板里的调用 id）。

## 工作原理

```
edit/write 执行时（dsh-fs-local 已返回 before/after，均为 LF 归一化）
  └─ presentationMeta 把 { path, before } 写进结果 meta（before ≤ revertMaxBytes，默认 1 MiB）
       └─ 随会话 JSONL 持久化（历史可重放，重放时按钮依然可用）
GUI 点「撤回」→ ctx.remote.commands.execute(sessionId, "/fs_revert <callId>")
  └─ dsh-tool-fs 注册的命令处理器：
       1. findRevertBasis：在本会话日志里按 callId 找 tool/result 事件，读 meta.revert
          —— 只有本会话真实记录过、且是 edit/write 的调用才能撤回（授权边界=会话历史）
       2. 走与工具相同的 ctx.waterfall("fs/write-intent") 观察策略瀑布
          （无观察记录时先 stat+emit fs/observed 再写，兼容子代理产生的编辑）
       3. 读取当前文件探测行尾风格（CRLF 保留 CRLF），把 before 恢复原风格后 writeText
       4. 写回后 emit fs/observed 新版本，模型的后续操作看到的是撤回后的状态
  └─ 命令生命周期 command/run + command/done 落日志（来源 user，可审计）
```

## 行为细节与安全边界

- **大小闸门**：`before` 超过 `revertMaxBytes`（配置项，默认 1 MiB）不持久化 →
  卡片不显示按钮（避免 JSONL 膨胀）。
- **write 新建文件**（`before === null`）不可撤回 —— 撤回语义没有「删除」这一破坏性动作。
- **文件被后续改动**：观察策略的版本 CAS（`replaceIfVersion`）不匹配 → 返回
  `FS_STALE_VERSION` 及补救提示，不覆盖用户/模型之后的修改。
- **行尾**：以「当前文件」的风格恢复 before，edit 会保留原风格，所以 CRLF 文件撤回后仍是 CRLF。
- **模型不知情**：命令不进入模型上下文；模型下一次 read/edit 看到的是撤回后的文件。
- **子代理**：子代理的 edit 结果若记录在本会话日志且 meta 带 revert，同样可撤回
  （处理器会先观察再写）。

## 改动清单

### `dsh-tool-fs/lib/index.js`（服务端，1 个文件）
- 新增 `revertFromMeta` / `findRevertBasis` / `parseRevertCallId` /
  `detectLineEndings` / `restoreLineEndings` 辅助函数（已导出，便于测试）。
- `write`/`edit` 的 `presentationMeta`：尺寸闸门内把 `{ path, before }` 加入 meta；
  `presentResult` 的 diff 视图携带 `revert: { path }` 标记。
- `Config` 新增 `revertMaxBytes`（默认 1 MiB）；`inject` 增加 `commands`。
- 新增 `/fs_revert` 命令（`applyRevertCommand`），由 `apply` 注册。

### `dsh-client-ui-tool/lib/client.js`（客户端，1 个文件）
- `narrowRevert` + `diffCardModel`：从结果视图防御性提取 revert 标记（仅结果侧）。
- `ToolRow`：可选 `revert` 属性 → 两段确认按钮 + 状态机（撤回/确认/进行中/成功/失败）。
- `FileMutationRow`：把 `{ path, onRevert }` 接给 ToolRow。
- `fileMutationToolview`：注入 `remote.commands`，提供按 session 绑定的
  `onRevertFile(callId)` → 执行 `/fs_revert <callId>` 并解析结果。
- 按钮文案沿用 DiffBlock 的中文直写惯例（"撤回"/"复制" 同级）。

## 验证

- `node --check`：两个修改文件语法均通过。
- `test-revert.mjs`（21 断言）：revertFromMeta 防御性收窄、findRevertBasis 按 callId
  查会话日志（含畸形 meta / 新建无 revert / 未知 id / 缺 session）、parseRevertCallId、
  行尾探测与恢复、导出面与 Config 默认值。
- `test-revert-flow.mjs`（6 断言）：用假 ctx/fs 跑完整 `apply()`，抓出命令处理器后
  验证 —— 空输入/未知 callId 拒绝、CRLF 内容恢复 + 行尾保留 + 重新观察、
  stale version 返回带补救的错误、无观察记录时先观察再写。
  （假 fs 的语义对齐真实 `dsh-fs-local`：`readText` 返回原始文本、`writeText` 抛
  真实 `FsError`。）

运行测试：

```powershell
node .\.check\test-revert.mjs
node .\.check\test-revert-flow.mjs
```

## 注意事项

- **DSH Desktop 更新会覆盖这些补丁**（安装目录随更新重新解压）。该功能的正式归宿是
  deepseek-harness 源码仓库（本目录改动均基于编译产物 `lib/`，若在上游应用需在
  `src/` 中对应修改并重新构建）。
- 按钮文案为中文直写，与现有 DiffBlock（"复制"/"复制成功"）一致；如需 i18n 应并入
  语言包。
