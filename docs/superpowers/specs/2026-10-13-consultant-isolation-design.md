# 顧問之間隔離（子專案 2）技術規格

- 日期：2026-10-13
- 狀態：設計已逐段確認，待最終審閱
- 目標：同一專案裡不同創作者的顧問，讀不到彼此的 skill（SOP、腳本）與工作目錄；主管只讀得到 `/shared`；`/shared` 仍是所有顧問共用的交接區
- 前提：子專案 1-A 已上線（`docs/superpowers/specs/2026-10-13-platform-key-isolation-design.md`）：agent 代為執行的一切都經 `sudo unshare --mount` → `/usr/local/bin/agenthub-sandbox` → `setpriv` 降權執行
- 長期參考：`docs/security-model.md`（帳號、目錄、誰看得到什麼以那份為準）

---

## 0. 現況

子專案 1-A 之後，所有顧問與主管共用 `agent` 帳號；`/workspace/agents/<顧問id>` 是 `sprite:workspace 2770`，`agent` 在 `workspace` 群組。因此：

- 顧問 B 可以 `cat /workspace/agents/<A>/skills/*/SKILL.md`，讀到創作者 A 的 SOP 與腳本。
- 主管的 `read_file` 可以讀任何顧問的目錄。
- `/tmp` 所有帳號共用，A 寫的暫存檔 B 讀得到。

金融顧問之間的交接（評等檔、投組權重、VIX 訊號、週報）全部透過 `/shared`（見 `agenthub-fintech-agents` 各 SKILL.md），隔離工作目錄不會打斷協作。

## 1. 決策紀錄

| 項目 | 決定 |
|---|---|
| 隔離方式 | 每位顧問一個 Linux 帳號（uid 是作業系統強制的邊界）。不採用「共用帳號＋掛載命名空間」（同 uid 可透過 `/proc/<pid>/root` 看到別人的檔案），也不採用每位顧問一台 Sprite（成本與延遲） |
| 顧問帳號 | `agent-<顧問 id 去掉連字號後的前 12 個十六進位字元>`，例如 `agent-5f0c2a9b31d4`；主群組同名；另加入 `workspace` |
| 主管帳號 | 沿用 `agent`（`SANDBOX_USER`），只在 `workspace` 群組 |
| 單一顧問模式 | 顧問用自己的帳號 |
| 建立時機 | runtime 每次 run 開始時，對專案裡每位顧問呼叫一次 `agenthub-sandbox-adduser`（同一個 runtime 程序成功過就不再呼叫）；在同步 skill 之前 |
| 私人 `/tmp` | 沙盒腳本把 `/var/lib/agenthub/tmp/<帳號>`（`700`，擁有者是該帳號）掛到 `/tmp`；父目錄只有 root 能寫（不放 `/var/tmp`：人人可寫，會被搶先建立或換成 symlink） |
| 失敗處理 | 建立帳號或目錄失敗 → 這次 run 失敗，不在沒有隔離的狀態下執行 |
| 不處理 | 顧問之間看得到彼此的程序清單（名稱與參數）；祕密不放在參數裡，記為已知限制 |

## 2. 帳號與目錄

| 路徑 | 擁有者 | 權限 | 誰能進 |
|---|---|---|---|
| `/workspace/agents/` | `sprite:workspace` | `0711` | 只有 runtime 能建立項目；顧問只能進入自己的目錄（避免顧問先放 symlink 或搶佔別人的目錄名稱） |
| `/workspace/agents/<顧問id>/` | `sprite:agent-<id12>` | `2770` | runtime、該顧問 |
| `/workspace/shared/` | `sprite:workspace` | `2770` | runtime、所有顧問、主管 |
| `/home/agent-<id12>/` | 該顧問 | `750`（Ubuntu 預設） | 該顧問 |
| `/var/lib/agenthub/tmp/` | `root:root` | `711` | 只能進入已知名稱的子目錄 |
| `/var/lib/agenthub/tmp/<帳號>/` | 該帳號 | `700` | 該帳號（在沙盒裡看到的是 `/tmp`） |

- 目錄的 setgid 讓 runtime 寫入的檔案（同步下來的 skills）沿用顧問群組；runtime 的 umask 是 `002`，顧問讀寫得到。
- 顧問建立的檔案擁有者是顧問；runtime 是目錄擁有者，可以刪除（同步時先刪再寫，沿用 1-A 的做法）。

## 3. 元件

### 3.1 `agenthub-sandbox-adduser`（新增，佈建時安裝）

`/usr/local/bin/agenthub-sandbox-adduser <帳號> <目錄>`，`root:root 755`，由 runtime 以 `sudo -n` 呼叫。內容由 `apps/web/lib/sprites.ts` 的常數產生，可重複執行：

1. 開頭重設 `PATH`、清掉 `LD_*`／`BASH_ENV`／`ENV`／`IFS`（與 `agenthub-sandbox` 相同），指令用絕對路徑。
2. 參數檢查：帳號必須符合 `^agent-[0-9a-f]{12}$`；目錄必須是 `/workspace/agents/` 底下的單層目錄名稱（UUID 格式），不可含 `..`。不符就失敗。
3. 帳號不存在 → `useradd --create-home --shell /bin/bash --groups workspace <帳號>`。
4. 目錄不存在 → 建立。設定擁有者為 `$SUDO_USER:<帳號>`（即 runtime 帳號）、權限 `2770`。
5. 目錄群組不是 `<帳號>` → 整個目錄 `chgrp -R <帳號>`、`chmod -R g+rwX,o-rwx`、子目錄補 setgid（轉換 1-A 時期的目錄）。

### 3.2 `agenthub-sandbox`（修改）

在降權前多一步：建立並掛載私人 `/tmp`。

```sh
/usr/bin/install -d -m 700 -o "$user" -g "$user" "/var/lib/agenthub/tmp/$user"   # 父目錄由佈建時以 root 建立（711）
/usr/bin/mount --bind "/var/lib/agenthub/tmp/$user" /tmp
```

其餘（重設環境變數、蓋掉 `/.sprite/api.sock`、`setpriv` 降權）不變。帳號名稱檢查：只接受 `agent` 或 `^agent-[0-9a-f]{12}$`。

### 3.3 runtime

- `packages/runtime/src/sandbox.ts`：新增 `consultantUser(instanceId: string): string`；新增 `ensureConsultantSandbox(instanceId, agentsRoot)`：本機模式（未設定 `SANDBOX_USER`）直接回傳；否則以 `sudo -n /usr/local/bin/agenthub-sandbox-adduser <帳號> <目錄>` 執行，成功的 instance id 記在程序內的集合裡。
- `packages/runtime/src/run.ts` 的 `prepareRootAgent`：同步 skills 前，對每位顧問呼叫 `ensureConsultantSandbox`；失敗就丟出錯誤（run 標成失敗）。
- `packages/runtime/src/agents/build.ts`：`buildConsultant` 用 `createSandbox(config.SANDBOX_USER ? consultantUser(instance.id) : undefined)`；`buildManager` 維持 `createSandbox(config.SANDBOX_USER)`。
- `sync.ts` 的 `syncSkills` 不變（目錄由 adduser 建好，runtime 是擁有者）。

## 4. 錯誤處理

| 情境 | 處理 |
|---|---|
| adduser 腳本不存在（舊 Sprite 尚未重新佈建） | 呼叫失敗 → run 失敗，錯誤訊息寫明「沙盒帳號建立失敗」；重新佈建後恢復 |
| 帳號或目錄參數不合格 | 腳本拒絕，run 失敗 |
| 私人 `/tmp` 建立或掛載失敗 | 沙盒腳本 `set -eu` 失敗 → 指令失敗（與蓋不掉 api.sock 相同的處理） |
| 顧問被移出專案 | 帳號與目錄留著，不影響其他顧問；不自動刪除 |

另外：佈建腳本不再遞迴修改整個 `/workspace`（1-A 的寫法會在每次重新佈建時把顧問目錄改回 `workspace` 群組），只處理 `/workspace`、`/workspace/agents` 本身與 `/workspace/shared`；顧問目錄一律交給 adduser。adduser 拒絕處理 symlink。

## 5. 測試

1. **單元測試（Vitest）**
   - `consultantUser`：格式、去掉連字號、長度。
   - `ensureConsultantSandbox`：本機模式不執行任何指令；Sprite 模式組出正確的 sudo 指令；同一個 id 只執行一次；失敗時丟出錯誤。
   - `buildConsultant`：設定 `SANDBOX_USER` 時，bash 以顧問帳號執行（沿用 1-A 用不存在帳號證明的寫法）。
   - 佈建腳本：安裝 `agenthub-sandbox-adduser`；兩支腳本都有參數檢查與環境變數重設。
2. **暫時 Sprite 驗收**（擴充 `apps/web/scripts/probe-sandbox.ts`）：建立顧問 A、B 兩個帳號，逐項確認：
   - A 在自己目錄與 `/tmp` 寫的檔案，B 與主管（`agent`）都讀不到。
   - A 的 skills 目錄 B 讀不到。
   - A 寫到 `/shared` 的檔案 B 讀得到、改得了。
   - B 終止不了 A 的程序。
   - adduser 腳本拒絕不合格的帳號與目錄（例如 `root`、`/etc`、`../`）。
   - 1-A 的 12 項檢查仍然全部通過。

**驗收結果（2026-10-14）**：`apps/web/scripts/probe-sandbox.ts`（runtime `main-a6d28b5.js`）30 項全部通過，含 1-A 的 13 項。

## 6. 部署

| 順序 | 內容 | 方式 |
|---|---|---|
| 1 | web（佈建腳本） | push `main` |
| 2 | runtime | `publish-runtime` |
| 3 | 既有 Sprite | `redeploy-runtime`（會重啟所有 Sprite，含展覽 Demo；先與使用者確認）；完成後逐台驗證 |

順序重要：runtime 先上線但 Sprite 沒裝 adduser 腳本時，run 會失敗；所以 web（新佈建流程）與 redeploy 要在 publish 後立刻接著做。

## 7. 不在本次範圍

- 顧問之間的程序清單可見性（hidepid 需要重新掛載 `/proc`，影響整台 Sprite）。
- 顧問被移出專案後的帳號清理。
- 同一位創作者的多位顧問共用目錄。
