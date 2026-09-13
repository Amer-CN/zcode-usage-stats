# zcode-usage-stats

在 DeepSeek Harness（DSH）设置页提供的 Token 用量统计插件：扫描全历史会话，聚合每天 / 每小时 / 每个模型的 Token 用量。

> 非官方社区插件，与 DeepSeek / ZCode 无关联。"zcode" 仅为致敬对象与包名沿用。

## 界面预览

浅色主题：

![浅色主题](assets/usage-stats.png)

深色主题：

![深色主题](assets/usage-stats2.png)

## 功能

- **时间范围**：今天、昨天、近 7 天、近 30 天、本月、上月、全部、自定义区间（起止自动校验防倒序）。
- **活跃分布**：日历点阵，一格一天，点面积 = 当日 Token（sqrt 换算），支持每日 / 每周 / 累计三档；峰值日虚线圈标注。
- **用量趋势**：一条线一个模型，圆点 = 当期用量，峰值直接标数；图例可点击显隐。
- **模型用量**：刻度环，100 刻 = 100%，每 10 刻一枚锚点；悬停看模型明细。
- **顶部指标**：累计 Token、单日峰值、最长会话时长、连续天数等。
- **无障碍与体验**：WCAG AA 对比度、`prefers-reduced-motion` 降级、命中区域按容器密度优化（小点也能轻松悬停）、深浅主题跟随 DSH。

## 安装

先确保已安装 `@deepseek-ai/dsh`（以及 `pnpm`，DSH 插件命令依赖）：

```bash
dsh plugin --profile web add zcode-usage-stats
```

安装后重启 DSH 进程，打开 **设置 → 使用统计** 即可看到统计页面。

## 使用

- 顶部切换时间范围；「全部」显示自使用以来的所有数据。
- 趋势图悬停查看各模型分项，点击图例显隐对应模型。
- 「刷新」强制重新扫描全部会话。

## 设计与实现

- 图表为手写 SVG（日历点阵 / 发丝折线 / 刻度环），无运行时图表库依赖。
- 配色自研：类目色（6 个跨色相）承载模型身份，序数色（单色相明度阶）承载用量大小；两套主题均满足 WCAG AA 对比度，类目色两两色距经过核算保证一眼可分。
- 排版采用固定字阶 + 4 的倍数间距阶梯；图表按实测容器宽度 1:1 出图，不做等比缩放，保证字号真实可读。
- 服务端复用宿主 `sessionPersistence` 服务聚合数据，磁盘 + 内存双层缓存（SWR），接口经宿主信任栅栏鉴权。

## 兼容性

- 针对 DSH 开发者预览版开发，锁定 `@deepseek-ai/dsh` 的 `>=0.1.0-rc.5`。
- 依赖 DSH 宿主提供的 `sessionPersistence`、`webServer` 服务，以及客户端运行时的 `@deepseek-ai/dsh-client-runtime`、`@deepseek-ai/dsh-client-ui-slots`。

## 数据口径

- token 用量：以 `assistant/message` 事件携带的全量 `usage` 为准（去除重复计数）。
- turns：以 `step/end` 事件按新 turn 计数。
- 未知模型归并为 `other`。

## 许可

MIT
