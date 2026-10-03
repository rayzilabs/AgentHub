# Apple 設計重新設計：production 驗證紀錄

2026-10-03，commit `f2856b2`、`d5c2103` 與後續修正，部署到 https://agenthub-kappa-pink.vercel.app 。

- `pnpm test`（web 56、runtime 102）、`pnpm typecheck`、eslint 全過；`next build` 成功。
- 冒煙測試（`scripts/smoke.ts`，BASE_URL = production）通過，並刪除測試專案與 Sprite。
- 介面端到端（puppeteer，production）：建立專案 → 從市集加入顧問 → 等工作電腦準備好（約 22 秒）→ 在新輸入列送出訊息 → 收到顧問回覆、沒有錯誤提示 → 刪除專案。資料庫只剩 Demo 專案。
- 桌面 1440 / 手機 390、淺色 / 深色截圖檢查所有頁面，`scrollWidth` 都沒有超過視窗寬度。
- 底部面板（手機，localhost 與 production 各跑一次）：慢拉 100px 放開回到打開、快甩 80px 收起、上拉 200px 只移動 96px（橡皮筋）、拉過一半收起、Esc 收起、彈回途中按住會停在目前位置並可繼續拖到收起、減少動態時改成淡入淡出。
- 文字對比（WCAG 相對亮度）：淺色 muted 在 sunken 上 4.87、link 在白底 5.57、白字在 brand 上 4.70；深色 muted 在 surface 上 6.61、link 在 surface 上 5.64；顧問頭像白字在六個識別色上 5.54–10.25。
