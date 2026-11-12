# 來源與授權

## vendor/aaron_connectors/

`_http.py`、`_loader.py`、`onpage.py`、`robots.py`、`sitemap.py`、`schema_lint.py` 原封不動取自
[aaron-he-zhu/aaron-marketing-skills](https://github.com/aaron-he-zhu/aaron-marketing-skills) 的 `scripts/connectors/`
（commit `3764d7f4712a79828176e75962dc704e80e0da5e`，2026-11-12），授權為 Apache License 2.0，全文見
[vendor/aaron_connectors/LICENSE](vendor/aaron_connectors/LICENSE)（亦見 <https://www.apache.org/licenses/LICENSE-2.0>）。

`site_audit.py` 呼叫這些程式抓取與解析網頁；問題判斷、嚴重程度與中文說明是本專案另外寫的。

## 資料

| 資料 | 出處 | 更新方式 |
|---|---|---|
| 國定假日、補假、補班 | 行政院人事行政總處《政府行政機關辦公日曆表》，執行時經政府資料開放平臺 API（資料集 14718）即時取得，依《政府資料開放授權條款》使用 | 不用人工更新 |
| `data/qixi.json` 七夕日期 | 中央氣象署《日曆資料表》`https://www.cwa.gov.tw/Data/astronomy/<西元年>cal.pdf` | 氣象署公布次年版本後補一筆、部署新版本 |
| 判斷規則 | Google 搜尋中心繁中文件與各家 AI 爬蟲官方說明（網址寫在 `site_audit.py`） | 每半年對照一次官方文件 |
