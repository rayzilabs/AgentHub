# qm 架構圖解

`yc-software/qm` 的架構、資料模型與安全設計，用 ASCII 圖解釋。

> **這不是 qm 官方文件**，是我們為了評估它而做的架構筆記。所有敘述都對照過原始碼，但取捨與評語是我們的，不是作者的立場。
>
> **基準版本：`01be29e8`（2026-09-25）。** qm 更新很快——光 09-25 到 09-27 兩天就進了 30 個 commit。文中的行數、star 數這類數字會漂移；架構層面的事實（scope 種類、swarm 預算、安全姿態）在 09-27 的上游仍然成立，我有逐項比對過。你 clone 到的版本若數字不同，以你的為準。
>
> 文中說「README」一律指 **qm 自己的 README**。另有一份姊妹文件記錄逐檔筆記、可直接搬用的檔案清單、以及跟 AgentHub `platform/packages/parser` 契約的異同——那份沒有附在這裡，需要的話跟我說。

---

## qm 是什麼

一個**給公司用的 AI agent 平台**，入口是 Slack 和網頁。TypeScript、MIT、`src/` 132,468 行（530 個 `.ts`，不含 test／cli／plugins）、15.2k stars、活躍開發中。

它要解的問題，README 第一段就講明：

> 大多數 agent 是照個人助理設計的。你可以讓一個 agent 服務整間公司，但它很快就會變得複雜。QM 是為新創公司設計的。

複雜在哪：全公司共用一個 agent，就會共用一份記憶、一份檔案、一組憑證、一套權限。財務問的事會出現在工程頻道，某人丟進去的 API key 變成所有人都能用，agent 記住的「使用者偏好」其實是幾十個人互相矛盾的偏好混在一起。

它的答案是一個貫穿全系統的概念：**scope**。

---

## 1. 三層服務

qm 部署三個服務。刻意拆開，是為了把信任邊界切乾淨。

```
                    browser
                       |
                       v
          +--------------------------+
          |  portal            :8091 |   公開大門
          |  - login / session       |
          |  - CSRF                  |
          |  - strips fake identity  |
          |    headers from outside  |
          +--------------------------+
                       |
                       |  signed portal identity
                       v
          +--------------------------+
          |  web-ui            :8090 |   聊天介面 + /admin
          |  - turns clicks into     |
          |    SIGNED requests       |
          |  - makes no authz        |
          |    DECISIONS; core does  |
          +--------------------------+
                       |
                       |  source-auth, signed with
                       |  CORE_SIGNING_SECRET
                       v
          +==========================+
          |  core              :8080 |   大腦
          |  authz | agent loop      |
          |  memory | sandbox | cron |
          |  Slack plugin (optional) |
          +==========================+
                       |
              +--------+--------+
              v                 v
          Postgres          sandboxes
       sessions/memory      (per scope)
```

信任**單向收斂**：portal 確認你是誰 → web-ui 幫你簽章 → core 決定你能不能做。

三件推論：

- **core 沒有任何未簽章的對外入口。** 直接用瀏覽器打 `:8080` 回 `401 missing, invalid, or stale source-auth headers`——那是設計，不是壞了。
- **web-ui 不做授權判斷**，它只負責把操作轉成簽章請求。
- **admin 身分的唯一真實來源是 core 的 `ADMIN_GRANTS`。** 前兩層都不能自己決定誰是管理員。

（port 號是我在本機手接時自己選的，不是 qm 的預設，正式部署也不同。想在 Windows 上跑起來，官方兩條路都走不通——`qm init` 是部署到 Fly／AWS，而 `npm run dev-instance` 的 supervisor 用 Unix domain socket。我照 `scripts/dev/supervisor/specs.ts` 手動接出三個 process 的完整步驟在姊妹文件裡，跟我要。）

---

## 2. Scope：整套設計的骨幹

```
  一個 scope = 一個容器，擁有它「自己那一份」全部東西

  +-- scope -------------------------------------+
  |   memory      files      keychain VIEW       |
  |   perms       crons      web apps            |
  |   sandbox  <-- a DURABLE computer;           |
  |                installed tools stay installed|
  +----------------------------------------------+

  README 的原話是「每個人和每個房間」各有上面這一份。
  程式碼裡 (src/types.ts) scope 共五種：

   personal:john    channel:#proj-x    group:...   team:...   org:acme
        |                  |
        v                  v
   只有 John 看得到    該頻道成員共用
   的記憶/檔案/憑證    的記憶/檔案/憑證
```

這就是「multiplayer」的意思：員工各自在隔離的工作區獨立工作、互不影響，同時又能在頻道、群組、專案裡跟 agent 協作。

注意 **sandbox 是一台持久的電腦**，不是每次跑完就丟的容器——裝過的工具會留著。

---

## 3. 一次對話（turn）走過的路

```
  人在 Slack 或網頁輸入
        |
        v
  core 判斷這是哪個 scope？  (personal / channel / group / team / org)
        |
        v
  載入「那個 scope 的」：   memory  --> 塞進 prompt
                           skills  --> 可用清單
                           creds   --> keychain
        |
        v
  agent loop  (harness: Pi | OpenCode | Codex | Claude Code)
              ^ qm 講的 harness = 實際驅動 agent 那一圈的執行器。
                四個都是現成的 coding agent，驅動同一個 core。
        |
        |  它想跑一個指令
        v
  安全姿態檢查 ------ Strict?     --> 停下來問人
        |             Auto?       --> 審查內容 + 擋私有網路
        |             Dangerous?  --> 放行
        |
        |  但是：預宣告的指令政策「所有姿態都生效」
        |        rm -rf / 破壞性 SQL = 硬性拒絕
        v
  在「那個 scope 的」沙盒裡執行
        |
        v
  回覆  -->  turn 結束後抽取記憶
             (只記使用者自己說過的事，不從 agent 回覆推導)
```

最後那一行是它記憶設計裡最容易被忽略、但最重要的一條規則，詳見第 7 節。

---

## 4. Swarm：multi-agent 協作

```
   root session  =  人的那個對話
        |
        |  spawn count=3, contexts=[planner, worker, reviewer]
        v
   +----------+     +----------+     +----------+
   | worker 1 |     | worker 2 |     | worker 3 |
   | planner  |     | worker   |     | reviewer |
   +----------+     +----------+     +----------+
    blank box        blank box        blank box
        ^                ^                ^
        +------- swarm messages ----------+
                 audience = [ids] | "all"

   預算（預設/上限）:
     agents  32/64      depth      4/8
     msgs    128/256    notifs     256/1024
     lifetime 1h/24h    turn       10m/1h

   兩條硬規則:
     - 每個 worker 一台「全新空白」電腦，不複製 parent 檔案
     - worker 不繼承 parent 的核准授權，要自己重新申請
```

其他值得抄的不變式，出自 `docs/swarms.md`：

- roster 凍結，改動 fail closed
- 互相等待的 agent 會 timeout，不會互鎖
- **失敗的預留仍然消耗預算**，避免無限重試迴圈
- delegation 本身不授權洩漏憑證、改權限或蓋掉更高優先的指示——那些照樣要過審查

出自 `docs/persistent-subagent-sessions.md`（講的是 `sessions` 那套 subagent 機制，不是 swarm）：

- **訊息是外部資料，不是人的授權**，每則訊息獨立過審查
- **觀眾單調性**：較寬的目標觀眾收不到較窄來源的內容

還有一個 29 行的關鍵檔案 `src/swarms/swarm-fence.ts`：agent 的 API token 只在其 run 持有**未過期 lease 且 attempt 完全相符**時有效——被取代的嘗試所發的憑證無法授權新工作。

---

## 5. Skill 從 repo 到可用

```
   一個裝滿 SKILL.md 的 git repo
        |
        |  fetch，釘在某個 commit
        v
   normalize.ts   一個通用正規化器，零 per-repo code
        |          別名表 / 未知欄位存進 meta / 安全預設值
        v
   planIngest     逐個分類
        |
        +--> eligible（可匯入）
        |
        +--> excluded，附具名理由 + 計數：
               scope | private | collision | binary-asset | malformed
        |
        v
   importPack  -->  create -> review -> publish
        |
        v
   org SkillStore
        |
        +--> skills 工具直接回傳 SKILL.md（不喚醒沙盒）
        |
        +--> 只有「附帶檔案或 pack bundle」的 skill
             才落到 .agent-turn/<conversation>/skills/<name>/
             （pack 放旁邊的 .packs/<id>/）
                  ^
                  +-- 每一輪結束時、以及下一輪開始前「清空」
                      所以被撤銷的內容活不過那一輪
```

兩個設計亮點：

- **每個排除都有具名理由加計數**，管理員在 UI 上看得到某個 skill 為什麼沒被匯入。
- **附帶檔案落在每輪清空的私有目錄**，所以不需要 reconcile、lock、sweep；普通指令與檔案讀取永遠不會卡在 skill 同步上。

`normalize.ts` 只有 125 行就吃掉所有 repo 的 frontmatter 方言：別名表（`scope` ↔ `visibility`）、`egress` 自動補成 `egress:` 前綴、description 缺就從 body 第一段散文或標題推導、body 出現 `$ENV_VAR` 就推導成需要的憑證、body 含 `THE-AGENT-ONLY` 判為私有。每個 repo 的差異只用宣告式 config 表達（`skillGlobs` / `exclude` / `fieldOverrides`）。

---

## 6. 安全的兩條獨立軸線

```
  軸一：SECURITY posture  ——「它能做多少」

  Strict ------------- Auto (預設) ------------- Dangerous
  每個工具呼叫          擋私有網路                不做姿態型的
  都要人核准            + 內容審查（僅在部署      內容審查，也
                        有設審查器時；模型        不做工具核准
                        審查預設關閉）            關卡


  軸二：SHARING posture  ——「它能看多少」

  Isolated (預設) ----------------------- Open
  資源不出 scope                          說話者選擇性開放的
                                          檔案/skills/記憶
                                          可在開放房間被讀取
                                          （全部標註來源 + 稽核）

  +----------------------------------------------------------+
  |  組織設的值是「天花板」，底下的 scope 只能收得更緊       |
  |  預宣告的指令政策在「所有姿態」生效，Dangerous 也不例外  |
  +----------------------------------------------------------+
```

`Strict` 的例外只有兩個「無副作用的收尾」工具（`stay_silent`、`finish_silently`）。

`Open` 有一長串明確的**不做**清單：不把個人工作區掛進共享電腦、不對其他參與者暴露憑證、不帶訊息歷史、不跨組織、不弱化審查／核准／egress。

整體安全立場跟本機 coding agent 同一套：**agent 就是以它服務的那個人的身分行動**，用那個人的憑證與權限，所做的一切都被稽核。

---

## 7. 記憶：storage × strategy 兩層分離

```
   +-- MemoryService (storage) ----+     +-- MemoryStrategy (when) ------+
   |  recall / capture / query     |  x  |  per-turn (預設)              |
   |  read / replace / history     |     |  scratch-promote              |
   +-------------------------------+     |  agent-only                   |
              ^                          +-------------------------------+
              |                                    + consolidation
              |                                      (decorator)
   +----------+----------------------------------+
   |  provider-router.ts  (142 行，零依賴)       |
   |                                             |
   |  route: scope kind 或精確 scope id          |
   |         -> 哪個 provider                    |
   |         -> capture: off | explicit | automatic
   |         -> manage: 誰提供編輯與版本歷史     |
   |         -> failOpen: 外部掛掉要不要擋       |
   +---------------------------------------------+
              |                    |
              v                    v
     built-in notebook      external provider
     (local / Postgres)     (MCP 協定，讀寫各一組
                             OAuth client credentials)
```

**per-turn 策略裡兩個值得直接抄的細節：**

1. **Provenance 規則。** 偏好或指令只有在**使用者自己的訊息**裡說了才算事實，**絕不從 agent 自己的回覆推導**——agent 說「依照 X 的偏好」不構成任何人有那個偏好。使用者下的指令要**原話引用**不要改寫。這是在防記憶被自己的輸出污染。
2. **不是每輪都抽取。** 攢到安靜 180 秒或 10 輪才送一次（burst buffer）。而且 `autonomous` 或系統 actor 的 turn **完全不寫記憶**。

---

## 8. 什麼可以換掉

它宣稱「每一個底層都在介面後面」。證據是數量：

```
  sandbox 後端  x9   local / sprites / smolmachines / agent37 /
                     superserve / e2b / modal / aws / porter
                     ^ 後面七個都是 microVM / 沙盒即服務的供應商
                       (Fly Sprites、E2B、Modal 等)，不是 qm 的元件

  harness       x5   Pi / OpenCode / Codex / Claude Code / mock
                     ^ mock 是測試用的假 harness，也是預設值

  session store x2   memory / Postgres

  memory        x3   built-in notebook / MCP provider / memorable
```

但要知道代價：`src/harness/` 是 **15,887 行**，比 memory（2,366）+ skills（1,619）+ swarms（1,056）+ acl（406）加起來還多。「不綁單一 harness」是真的有護城河味道的性質，價碼就是這個數字。

另外一個關鍵分界：**core 本身是通用的。** 組織設定、自訂工具與 skills、沙盒 image、基礎設施，全部放在獨立的 **deployment directory**，由 `qm` CLI 驗證與部署。不需要 fork 原始碼就能客製一間公司。

---

## 9. 對 AgentHub 的定位

```
  qm 已經做完的（可參考/可搬）        AgentHub 要做而 qm 沒有的
  ---------------------------------   ---------------------------------
  scope 化的記憶分層                  專家 agent 市集
  多人身分折疊 (principal links)      創作者變現 / 分潤
  multi-agent 安全邊界                「雇用專業人士調教過的 agent」
  skill 從 repo 匯入並發布            上架審核 / 評價 / 收入紀錄
  9 種沙盒後端 / 5 種 harness
  三段安全姿態 + 兩段分享姿態
```

一句話：**它是基礎設施的參考答案，不是產品的參考答案。**

它把我們講了很久但還沒實作的幾塊做完了，而且同語言（TypeScript）、同生態、同授權（MIT），`platform/` 可以直接受益。但它賣的是「給公司用的 agent harness」，沒有市集、沒有分潤、沒有創作者——我們的產品命題一項都不在它身上。

這既是好消息（沒撞車），也提醒護城河得自己長。

---

## 延伸閱讀

你 clone 的 qm repo 內最省時間的入口，依序：

| 檔案 | 為什麼看 |
|---|---|
| `README.md` | 設計動機講得很直白 |
| `adrs/` | 架構決策記錄。裡面只有一個檔案不是漏寫——qm 只收「人寫的文字」當貢獻，不收 code：你把想要的變更寫成 `.md` 丟這裡，談定了由他們實作 |
| `docs/swarms.md` | multi-agent 安全邊界的完整規格 |
| `docs/memory-providers.md` | 記憶分層的設定模型 |
| `docs/skill-registry.md` | skill 發布流程 |
| `docs/principal-links.md` | 多登入身分折疊成一個人 |
| `src/memory/provider-router.ts` | 142 行，可直接抄 |
| `src/skills/normalize.ts` | 125 行，frontmatter 方言正規化 |
| `src/swarms/swarm-fence.ts` | 29 行，run lease 憑證圍欄 |

---

姊妹文件（未附上）另有：逐檔筆記、可直接搬用的檔案清單、Windows 本機跑法、以及 qm 的 skill 正規化跟我們 `platform/packages/parser` 契約的逐點異同——簡短講，**我們那份在兩個地方比它嚴**：它的 frontmatter parser 對解析不出來的行直接跳過（靜默丟失），而且把所有解析失敗壓成單一理由 `malformed` 沒有細節；另外它從「已抓下來的檔案清單」讀，不走檔案系統，所以 symlink 不是它的問題。需要完整那份跟我說。
