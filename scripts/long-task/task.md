# 已确认任务：2027 汽车电动化展望交付包

为行业研究人员交付一份可核对、可复算的本地研究资料包。使用 inputs 中冻结的 OWID/IEA 真实公开资料，完成数据整理、计算、2027 情景推演、图表、证据索引与中文报告。历史截止 2025 年；2026 年 IEA 文稿作背景，2027 为本任务的机械情景计算。

材料与口径已确认，正常实现取舍自行决定；不需要再问用户。不得将尚未核对的结果视为完成。无法实现的部分需明确保留，不得编造数据、改变下列标准或用更短的替代草稿交付。

## 输入和边界

- inputs 中有四份原始 CSV、对应元数据、三篇 IEA 原文的行号文本，以及 sources.json。保留输入原值；不改输入、TASK.md 或 acceptance.json。
- 仅使用本工作区及其子目录。不要读其他试验组、项目配置、凭据或评测器。不要访问外网、安装依赖或操作桌面。
- Node 和 Python 标准库可用；图表用 SVG，无需安装绘图库。整个资料包不得依赖试验目录绝对路径。
- 所有实验组可用相同终端/文件、子 Agent、进度和提交工具。子 Agent 在自己的目录工作，最终由主 Agent 集成至工作区根下 deliverables。可以按需要委派，不要求为展示能力创建多个 Agent。
- 已确认单组费用上限估算 USD 1、时限 45 分钟。目标明确后应在此范围内持续工作；真实外部阻塞或硬预算耗尽时如实停止。
- acceptance.json 是共同的最低交付检查，不代表完整质量评分。最终还有独立核对，检查标准就是本文；不因检查文件写了 passed=true 就认定数值正确。

## 交付一：标准化数据和审计

deliverables/normalized.csv，字段严格为：
entity,code,year,ev_sales,ev_sales_share_pct,ev_stock,ev_stock_share_pct

四份 CSV 以 Entity+Year 做全外连接，保留所有实体、全部历史年份和稀疏行，不能只保留八个重点市场。原始 code 保留；同一键若有冲突需报错。数值缺失保留空字符串，真实 0 保留 0。比例是 0—100 的百分数，不是 0—1；不要以车型总量或保有量替代销量。

原表重复 Entity+Year、非空数值无法解析、数值为 NaN/Infinity、百分比不在 0—100 范围，应使构建命令失败并说明来源，不能静默丢弃/平均/填零。标准化表按 entity、year 升序，键唯一，数值保留来源精度。

deliverables/audit.json：
```
{
  "sources": {
    "electric-car-sales.csv": {"rows": 0, "unique_keys": 0, "duplicate_keys": 0, "latest_year": 0},
    "electric-car-sales-share.csv": {"rows": 0, "unique_keys": 0, "duplicate_keys": 0, "latest_year": 0},
    "electric-car-stocks.csv": {"rows": 0, "unique_keys": 0, "duplicate_keys": 0, "latest_year": 0},
    "share-car-stocks-electric.csv": {"rows": 0, "unique_keys": 0, "duplicate_keys": 0, "latest_year": 0}
  },
  "normalized_rows": 0,
  "missing_counts": {"ev_sales": 0, "ev_sales_share_pct": 0, "ev_stock": 0, "ev_stock_share_pct": 0}
}
```
以上 0 是 schema 示例，应填写实际计算值。另写入审计说明，解释原表覆盖差异、地理层级不可直接求和、缺失与零、销售渗透率与存量渗透率，以及结构化表和 IEA 文稿中可能出现的近似口径差异。

## 交付二：重点市场计算

重点市场准确名称：World、China、Europe、European Union (27)、United States、India、Norway、Germany。Europe 与 EU27 保留为两个不同实体；World 不得通过这些重叠地理集合求和。

deliverables/market_metrics.csv：上述八市场在 normalized 中所有可用年份，列为：
entity,year,ev_sales,ev_sales_share_pct,ev_stock,ev_stock_share_pct,sales_yoy_pct,sales_share_change_pp

sales_yoy_pct = (当年销量/上一自然年销量-1)*100；仅当前后值存在且上一年销量>0 时计算。sales_share_change_pp = 当年销量占比-上一自然年占比；缺前一年或值则为空。不要将“百分点”写成相对增长率。

## 交付三：2027 三情景

必须按下列统一公式计算，便于复核；不要称为 IEA 官方预测，也不要用其他经验数值替代。对于每个重点市场，取结构化表 2022、2025 年数据：

- g = (销量2025/销量2022)^(1/3)-1。
- d = (销量占比2025-销量占比2022)/3，单位为百分点/年。
- downside/base/upside 对应因子 f=0.5/1/1.5。
- 情景年增长率 r = min(0.5,max(-0.05,g*f))。
- 销量2027 = 销量2025*(1+r)^2。
- 占比2027 = min(100,max(0,占比2025+2*d*f))。

deliverables/scenarios_2027.csv，恰好八市场×三情景=24 行，列：
entity,scenario,base_year,target_year,annual_growth_pct,annual_share_change_pp,ev_sales_2027,ev_sales_share_2027_pct

其中 base_year=2025，target_year=2027，annual_growth_pct=100*r，annual_share_change_pp=d*f。保持足够计算精度，数量误差≤0.5 辆，比例/增长率误差≤0.000001。对高增长市场增长上限和接近饱和市场占比上限，需明确说明。

## 交付四：来源、图表和研究报告

deliverables/claims.csv，至少 12 条关键判断，列：
claim_id,claim,source_file,source_locator,url,status

- 至少 8 条来自实际计算的定量判断，定位到原始 CSV 的实体/年份/指标或输出表的键。
- 至少 4 条引用 IEA 文稿，给出文本文件和真实 L 行号范围，链接原始网页。
- status 只用 historical、source_forecast、task_scenario、interpretation，区分历史值、IEA 预测、本任务机械情景和解释。
- 计算中的原值以冻结的 CSV 为准；不要因文稿中的近似表述而覆盖 CSV，遇到差异应解释。

四份真实数据图表，SVG 格式、能打开、标题/图例/坐标/单位/年份/来源可读：
- deliverables/charts/sales-trend.svg：2015—2025 八市场销量趋势，处理量级差异，不把缺失画成 0。
- deliverables/charts/share-trend.svg：同期间八市场新车电动化占比趋势。
- deliverables/charts/sales-vs-stock.svg：2025 年八市场销量占比与保有量占比对比。
- deliverables/charts/scenarios-2027.svg：2027 年三情景的新车占比对比，清楚区分实际与情景。

deliverables/report.md：约 3500—6000 汉字的完整中文报告，含执行摘要、口径与方法、八市场 2025 数据表、市场分化分析、2027 三情景、政策/价格/供应链因素、至少三个反向观点与触发信号、风险和数据缺口、来源。引用四幅图和 claims 索引。预测必须标明公式假设及局限，不把 2025 历史、2026 原文展望和 2027 自建情景混在一起，不以未核对的外部印象填补缺口。

## 交付五：可复算与自查

- 根目录 build.py：`python3 build.py --inputs inputs --out deliverables` 能从原始资料重建 normalized、market_metrics、scenarios、audit 和四张图。支持任意工作目录中的参数路径，不读取已生成结果当输入，不硬编码这批数据的答案。允许报告与 claims 是独立撰写的文稿。
- tests/test_pipeline.py：至少 5 个有意义的 unittest 测试，包含缺失值/真实零、重复键拒绝、非法数值或百分比拒绝、增长或占比上限、重建结果。`python3 -m unittest discover -s tests -v` 可运行。禁止测试只比较结果与自身。
- README.md：实际可执行的重建/测试命令、文件导览、来源及口径局限。
- deliverables/checks.json：`{"passed":true,"checks_executed":[...],"failures":[]}`，记录实际执行过的自查和结果。未通过则 passed=false 并记录真实问题，不得伪造。
- 完成前实际运行构建和测试，核对原始输入未改变、全部交付物可读且结果一致，再返回总结和相对交付路径；可以使用 task_submit 提交结果。
