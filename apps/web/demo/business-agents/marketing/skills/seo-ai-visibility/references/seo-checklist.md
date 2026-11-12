# 網站 SEO 與 AI 搜尋檢查清單

資料截至 2026-11-12。

**出處**：Google 搜尋中心繁中文件（各項網址如下）；各家 AI 爬蟲的官方說明（[OpenAI](https://platform.openai.com/docs/bots)、[Anthropic](https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler)、[Perplexity](https://docs.perplexity.ai/guides/bots)、[Google 檢索器](https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers?hl=zh-tw)）。tw-marketing MCP 的 `site_audit` 會自動檢查其中大部分項目。

**更新方式**：每半年由維護者對照上述官方文件。

## 1. 爬得到、收得進去

| 項目 | 怎麼看 | 官方說明 |
|---|---|---|
| 網頁打得開（HTTP 200） | `site_audit` 的 `page_unreachable` | [HTTP 狀態碼與網路錯誤](https://developers.google.com/search/docs/crawling-indexing/http-network-errors?hl=zh-tw) |
| 沒有誤設 noindex | `noindex` | [封鎖搜尋索引](https://developers.google.com/search/docs/crawling-indexing/block-indexing?hl=zh-tw) |
| robots.txt 沒擋 Googlebot | `googlebot_blocked`、`robots_unreachable` | [robots.txt 簡介](https://developers.google.com/search/docs/crawling-indexing/robots/intro?hl=zh-tw) |
| 有 Sitemap | `sitemap_missing` | [Sitemap 總覽](https://developers.google.com/search/docs/crawling-indexing/sitemaps/overview?hl=zh-tw) |
| 重複網址有標準網址 | `canonical_missing` | [標準網址](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls?hl=zh-tw) |
| 內容不是只靠 JavaScript 產生 | `site_audit` 看到的內文與瀏覽器看到的差很多 | [SEO 入門指南](https://developers.google.com/search/docs/fundamentals/seo-starter-guide?hl=zh-tw) |

## 2. 看得懂

| 項目 | 寫法 | 官方說明 |
|---|---|---|
| 標題 | 每頁不同，「品名或主題＋地區或特色｜店名」 | [標題連結](https://developers.google.com/search/docs/appearance/title-link?hl=zh-tw) |
| 描述 | 一兩句講這頁的重點與差異 | [摘要](https://developers.google.com/search/docs/appearance/snippet?hl=zh-tw) |
| h1 | 一個，寫這頁最重要的一句話 | [SEO 入門指南](https://developers.google.com/search/docs/fundamentals/seo-starter-guide?hl=zh-tw) |
| 結構化資料 | 店家 LocalBusiness 或更精確的子類型（名稱、地址、電話、營業時間）；商品 Product | [結構化資料簡介](https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data?hl=zh-tw)、[結構化資料規範](https://developers.google.com/search/docs/appearance/structured-data/sd-policies?hl=zh-tw) |
| 分享預覽 | og:title、og:description、og:image（分享到 LINE、FB 用） | [Open Graph 規格](https://ogp.me/) |

## 3. 講得對（AI 最常出錯的地方）

把這些事實寫成**文字**、放在**固定頁面**（關於我們、門市資訊、常見問題），全站與站外（商家檔案、粉專、電商賣場）一致：
- 營業時間與公休日、連假營業時間
- 地址、服務範圍、交通與停車
- 價格區間、付款方式、運費與運送範圍
- 證照、檢驗、得獎（只寫真實有的）

## 4. AI 爬蟲

| 爬蟲 | 用途 | 擋了的影響 |
|---|---|---|
| Googlebot | Google 搜尋（AI 摘要、AI 模式也用同一套索引） | 擋了 Google 搜尋幾乎找不到 |
| Google-Extended | Gemini 等 Google AI 能否使用網站內容 | 不影響 Google 搜尋 |
| bingbot | Bing 搜尋 | 擋了 Bing 搜不到 |
| OAI-SearchBot | ChatGPT 搜尋 | 擋了 ChatGPT 搜尋不會引用 |
| GPTBot | OpenAI 模型訓練 | 不影響 ChatGPT 搜尋 |
| Claude-SearchBot | Claude 搜尋 | 擋了 Claude 搜尋不會引用 |
| ClaudeBot | Anthropic 模型訓練 | 不影響 Claude 搜尋 |
| PerplexityBot | Perplexity 搜尋 | 擋了 Perplexity 不會引用 |

`llms.txt`：目前不在 Google 搜尋中心列出的做法裡，也不保證被任何 AI 服務使用；有餘力再做，優先做上面 1–3 節。

## 5. 常見台灣架站平台

Shopline、Cyberbiz、91APP、WordPress、Wix、Shopify 都能在後台改標題、描述、網址，多數會自動產生 Sitemap；結構化資料、robots.txt、canonical 能不能改依平台而定，請老闆查該平台的官方說明或問客服，不要憑記憶告訴他在哪個選單。
