# AgentHub 網站重新設計：Apple 設計原則

> 依使用者提供的 apple-design skill（WWDC《Designing Fluid Interfaces》等）重新設計 `apps/web` 的呈現層。功能、API、資料流不變。

## 決策

| 面向 | 做法 | 依據 |
|---|---|---|
| 色彩 | 淺灰底 `paper #f5f5f7` 上放白色群組 `surface`，群組不加框線與陰影；只有浮在內容上的表面（導覽列、輸入列、底部面板、加入顧問卡片）才有陰影或材質 | 材質厚度表達層級 |
| 深色模式 | 同一組 token 在 `prefers-color-scheme: dark` 重新定義；`brand`（填色）與 `link`（文字色）拆開，兩種模式的文字對比都 ≥ 4.5:1 | Craft：顏色隨明暗調整 |
| 字體 | 標題維持霞鶩文楷 TC；內文優先系統字（PingFang TC），其他平台退回 Noto Sans TC；字距依字級調整（40px −0.015em、28px −0.005em、14px +0.01em） | 字距依大小調整、優先系統字 |
| 按壓回饋 | `.btn`、卡片、列表列在 `:active` 立即縮放 0.97–0.98，100ms | 在按下時回應，不等放開 |
| 材質 | `.material` / `.material-surface`：半透明 + `backdrop-filter`；導覽列只有在內容捲到下面時才出現分隔線（scroll-driven animation） | 材質、捲動邊緣效果 |
| 導覽 | 目前所在頁面以底色標出 | Wayfinding |
| 手機工作區 | 顧問、資料與記憶改成可拖曳的底部面板（`components/ui/bottom-sheet.tsx`）：1:1 跟手、越界橡皮筋、放手依速度推算落點、速度交給彈簧、動畫中可隨時抓住；原生 `<dialog>` 負責焦點鎖定與 Esc | 直接操作、動量投射、可中斷 |
| 對話分頁 | 分段控制，選中底色以彈簧從原位置滑到新分頁（`layoutId`） | 空間一致性 |
| 訊息 | 使用者訊息從輸入列方向長出；收合內容展開時用彈簧接續高度；從伺服器載入的歷史訊息不播動畫 | 動態只回應使用者的操作 |
| 顧問識別 | 識別色改成頭像圓（名字第一個字），名字用一般文字色；頭像底色加深 14%，白字在所有識別色上 ≥ 5.5:1 | 對比與一致性 |
| 無障礙 | `prefers-reduced-motion`：彈簧換成淡入淡出、按壓不縮放；`prefers-reduced-transparency`：材質改實心；`prefers-contrast: more`：實心加框線 | 減少動態不是沒有回饋 |

## 新增依賴

`motion`（`motion/react`）：彈簧、`layoutId`、`height: auto` 動畫。全站預設 `MotionConfig reducedMotion="user"`、臨界阻尼、`visualDuration 0.35`。

## 驗證

見 `docs/superpowers/reports/2026-10-03-apple-redesign-verification.md`。
