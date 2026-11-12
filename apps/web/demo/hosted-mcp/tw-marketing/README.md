# tw-marketing（平台代管 MCP）

行銷顧問用的兩個工具：`site_audit`（網站 SEO 與 AI 爬蟲健檢）、`tw_calendar`（台灣國定假日、連假與行銷檔期）。資料來源與授權見 [NOTICE.md](NOTICE.md)。

## 測試

**改了這個套件就要跑**（這些測試不在 `pnpm test` 裡）。在這個目錄、裝好 `requirements.txt` 的虛擬環境裡執行：

```bash
python -m venv ~/.venvs/tw-marketing      # 第一次；放在套件外，避免被打包上傳
~/.venvs/tw-marketing/bin/pip install -r requirements.txt   # Windows：Scripts\pip
~/.venvs/tw-marketing/bin/python -m unittest discover -s tests
```

測試不連網，用固定的 HTML、robots.txt、辦公日曆 CSV 跑真的解析程式。

## 每年要更新的資料

- `data/qixi.json`：中央氣象署公布次年《日曆資料表》後，補上那年的七夕（農曆七月初七）日期，跑測試後部署新版本。
- 國定假日不用手動更新，工具執行時從政府資料開放平臺即時取得。
