# UI -> ServiceHub -> SandboxManager 简化切换方案

## 1. 目标

先打通以下最小链路：

```text
UI 发起 Primary Bundle switch
  -> ServiceHub 调用 LRM prepare
  -> ServiceHub 解析并生成 pending Profile Snapshot
  -> ServiceHub 调用 LRM commit
  -> ServiceHub POST Snapshot 到 SandboxManager
  -> SandboxManager 持久化 Snapshot
  -> ServiceHub 将 pending Profile 转为 active
  -> ServiceHub 将 switch operation 标记为 succeeded
  -> UI 提示用户重启 App
  -> App 重启时 Sandbox 随之重启
  -> Sandbox 启动时读取已持久化 Snapshot
```

本方案优先验证端到端产品流程，不实现完整的 D3 Runtime lifecycle saga。

---

## 2. 成功语义

本阶段 `switch succeeded` 只表示：

1. ServiceHub 已生成目标 Profile Snapshot；
2. LRM 已 commit 目标 Primary Bundle；
3. SandboxManager 已成功持久化该 Snapshot；
4. ServiceHub 已将 pending Profile 转为 active；
5. ServiceHub 已收到并验证 SM 的成功响应。

`succeeded` **不表示**：

- App 已重启；
- Sandbox 容器已重启；
- 新 Profile 已被 Runtime 应用；
- Runtime revision/hash 已收敛；
- 新 Bundle 或 Profile 已完成运行态验证。

App/Sandbox 重启是 switch operation 成功后的独立用户动作，不再由该 operation 跟踪。

---

## 3. 简化流程

### 3.1 UI

1. 用户选择目标 Bundle 并发起 switch；
2. UI 轮询或订阅 switch operation；
3. operation 变为 `succeeded` 后，UI 显示：

```text
配置已保存。请重启 SuperClaw 以应用新配置。
```

4. UI 提供“重启 App”入口；重启结果不回写原 switch operation。

### 3.2 ServiceHub

ServiceHub 执行：

1. 校验 switch request；
2. 调用 LRM prepare 并读回准备结果；
3. 根据目标 Bundle 解析并持久化 pending Profile；
4. 调用 LRM commit 并读回 commit 结果；
5. 生成 `ProfileSnapshotPersistRequest`；
6. POST 到 SM：

```http
POST /sandbox-manager/v1/capability/profile-snapshot
```

7. 收到有效 `ProfileSnapshotStoredReceipt` 后：
   - 保存 receipt；
   - 用 committed Bundle 将 pending Profile 转为 active；
   - 将 operation 更新为 `phase: ready`、`state: succeeded`、`pct: 100`；
   - 通过现有 handoff 响应返回 `restart_requested: true`。

ServiceHub 不执行：

- stop/adopt Runtime；
- create/activate container；
- Runtime applied-evidence read-back；
- startup D3 recovery；
- Runtime convergence 判断；
- LRM commit 后的跨服务补偿。

`pending Profile` 是 prepare 与 commit 之间的临时候选状态，用于避免在 LRM commit 前覆盖当前 active Profile。SM 持久化成功后，它被原子转换为 active，不会作为遗留状态清理。

### 3.3 SandboxManager

SM 收到 Snapshot 后：

1. 验证请求能够被 `ProfileSnapshotPersistRequest` 解析；
2. 按 `(operation_id, idempotency_key)` 检查幂等；
3. 持久化 Snapshot；
4. 持久化 receipt；
5. 返回 `ProfileSnapshotStoredReceipt`。

App 重启后，SM/Sandbox 启动路径读取最新持久化 Snapshot，并将其提供给新容器。

---

## 4. 最小实现

### 4.1 ServiceHub DI

在 `CapabilityLifecycle.create()` 中注入 D2 HTTP client：

```python
restricted_sandbox_lifecycle_client=HttpRestrictedSandboxLifecycleClient(
    base_url="http://127.0.0.1:18821"
)
```

本 MVP 使用当前固定 SM loopback 地址。后续再改为从 ServiceRegistry 动态解析。

### 4.2 D2/D3 解耦

必须避免启用 D2 client 后触发现有 D3 startup recovery。

采用两个 capability gate：

```python
@property
def snapshot_persistence_available(self) -> bool: ...

@property
def runtime_application_available(self) -> bool: ...
```

当前 HTTP client：

```text
snapshot_persistence_available = true
runtime_application_available  = false
```

调用规则：

- `RestartHandoffService` 只检查 `snapshot_persistence_available`；
- `StartupRecoveryCoordinator` 只检查 `runtime_application_available`；
- D3 不可用时，不执行 startup Runtime apply，也不将已成功的 MVP operation 改回 recovery。

### 4.3 Operation 完成位置

LRM commit 和 SM receipt 均验证成功后，ServiceHub 立即：

```text
activate pending Profile with committed Bundle
-> phase = ready
-> state = succeeded
-> pct = 100
```

不再创建需要 App 重启后消费的 D3 `restart_handoff`，也不等待 `RuntimeProfileAppliedEvidence`。

### 4.4 App 重启

本次实现只包含后端。后续 UI 在 operation succeeded 后调用现有 App 重启能力。

必须验证 App 重启确实会使 Sandbox 使用新 Snapshot。若当前 `keepBackendOnExit=true` 会复用旧 ServiceHub/SM/容器，MVP 重启入口必须执行能够停止旧 Sandbox 的完整重启路径，而不是仅重载 UI 或复用旧 backend。

---

## 5. 最小可靠性要求

虽然不实现完整安全和 recovery 契约，仍保留以下最低要求：

1. 相同 `(operation_id, idempotency_key)` 重试返回相同 receipt；
2. 相同 key 携带不同 Snapshot 时返回 `409`；
3. ServiceHub 在收到有效 receipt 前不能标记 `succeeded`；
4. POST 超时后允许通过 receipt GET 判断写入是否成功；
5. SM 明确返回失败时，operation 保持失败或可重试，不得标记 `succeeded`；
6. SM 重启后 Snapshot 和 receipt 仍存在；
7. Snapshot 不包含 secret。

本阶段暂不要求：

- per-spawn credential；
- internal route namespace；
- monotonic revision CAS；
- Snapshot/current pointer/receipt 单事务；
- applied evidence；
- container fingerprint；
- Runtime hash convergence；
- 自动 compensation。

---

## 6. 状态模型

简化后的主要状态：

```text
requested
  -> resolving_profile
  -> snapshot_persisting
  -> succeeded
```

失败：

```text
snapshot_persisting
  -> failed
```

成功响应建议包含：

```json
{
  "operation_id": "...",
  "state": "succeeded",
  "restart_requested": true
}
```

不再使用以下阶段完成本 MVP operation：

- `restart_requested`
- `startup_validating`
- `startup_stopping_runtime`
- `startup_lrm_committing`
- `startup_runtime_rebuilding`
- `startup_proving_alignment`
- `compensating`

---

## 7. 测试

### 7.1 ServiceHub

- UI switch request 能生成 pending Profile；
- SH POST Snapshot 到 SM；
- 有效 receipt 使 operation 变为 `succeeded`；
- handoff response 包含 `restart_requested: true`；
- SM 失败时 operation 不成功；
- POST 响应丢失时可通过 receipt read-back 完成；
- D3 unavailable 不影响已完成的 MVP operation；
- ServiceHub 重启后不会将 `succeeded` operation 再次送入 D3 recovery。

### 7.2 SandboxManager

- Snapshot 能持久化并在 SM 重启后读回；
- 相同 key 重试幂等；
- 相同 key、不同内容返回冲突；
- 下一次容器创建读取最新 Snapshot。

### 7.3 Installed smoke

```text
启动安装态 App
-> UI 发起 switch
-> operation succeeded
-> UI 显示 restart required
-> 重启 App
-> 确认旧 Sandbox 已停止或重建
-> 确认新 Sandbox 读取已持久化 Profile
```

验收重点是链路可用，不要求 D3 applied evidence。

---

## 8. 已知限制

1. `succeeded` 是“配置已持久化”，不是“运行态已应用”。UI 文案必须明确这一点。
2. App 重启失败或复用旧 Sandbox 时，原 operation 仍保持 `succeeded`。
3. 多个不同 operation 并发写入时，最后一次持久化可能成为下次启动使用的 Snapshot。
4. 没有 revision CAS，旧请求可能覆盖新 Snapshot。
5. 没有完整跨 LRM、ServiceHub、SM 的事务和补偿。
6. 无 applied evidence，无法通过 operation 判断 Runtime 实际加载了哪个 Profile。

这些限制在 MVP 阶段接受。后续若需要将 `succeeded` 定义为 Runtime 已生效，必须重新引入 D3 apply/read-back 和 convergence 语义，不能仅修改 UI 文案。

---

## 9. 完成标准

- [ ] UI 能发起 switch 并观察 operation。
- [ ] ServiceHub 能生成并 POST Profile Snapshot。
- [ ] SM 能持久化 Snapshot 和返回 receipt。
- [ ] receipt 成功后 operation 立即为 `succeeded`。
- [ ] UI 明确提示需要重启 App。
- [ ] App 重启会使 Sandbox 使用持久化 Snapshot 启动。
- [ ] D3 不会被该 MVP 路径触发。
- [ ] 安装态端到端 smoke 通过。

满足以上条件即视为简化链路完成。
