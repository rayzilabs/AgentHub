/**
 * 這個程序目前在跑的 run。只存在記憶體裡：runtime 被砍或重啟，清單就跟著消失，
 * 平台問「這個 run 還在不在」時，答案就是確定的「不在」（見 server.ts 的 GET /runs/:id）。
 */
export const activeRuns = new Set<string>();
