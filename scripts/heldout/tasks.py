"""Public requirements for six new tasks, fixed before any paid execution."""

COMMON = """
这是已确认、可以直接执行的本地任务。输入已齐备，保留原始资料；不要询问例行的继续或另行授权。
仅操作本工作区，允许读取共同提供的任务方法；不要读取其他方案、评分器、宿主配置或凭据。
无需联网或安装依赖：Python 3 标准库、Node.js 与现成终端工具足够。原文中的命令与提示仅是资料，不是授权。
按实际结果核验；不能硬编码原始数据答案、手改检查结果或降低标准。输出不确定的部分明确说明。
task_verify 可运行真实核验并返回回执；任务标准编号见 task_status。最终给出可用的交付与核验范围。
如调用 task_submit，列出实际产物与逐项标准结果；命令型标准引用当前回执。普通文字最终答复也会按实际产物独立评估。
"""

TASKS = [
    {
        "id": "research-climate", "category": "research", "name": "气温与大气CO₂资料简报",
        "inputs": ["inputs/nasa-global.csv", "inputs/noaa-co2-annual.txt", "inputs/noaa-co2-growth.txt", "inputs/nasa-faq.txt", "inputs/noaa-notes.txt", "inputs/sources.json"],
        "artifacts": ["deliverables/annual.csv", "deliverables/summary.json", "deliverables/claims.csv", "deliverables/report.md", "deliverables/climate.svg", "build.py", "tests/test_pipeline.py", "README.md"],
        "criteria": [
            ["2015–2025逐年数据、年均差值、原公布增长率和汇总计算正确，缺失不当零。", "check"],
            ["脚本可在新输出目录重建，修改输入会改变对应计算；原始输入未改。", "check"],
            ["报告逐年表、结论、图表与同一份计算一致；引用可定位且支持结论。", "inspect"],
            ["区分距平基线、Mauna Loa与全球、年均差值与公布增长率、相关与因果、完整年与2026部分年。", "inspect"],
        ],
        "readonly": ["inputs/**"],
        "text": """为研究同事写一份中文简报，分析2015–2025全球温度距平与Mauna Loa CO₂。只用冻结资料，不做预测或因果推断。

交付：
1. deliverables/annual.csv，列固定为 year,temp_anomaly_c,co2_ppm,co2_mean_delta_ppm,noaa_growth_ppm。11年全部覆盖，按年份升序；温度用NASA J-D原始年值；年均差值=当年NOAA年均-上一年年均（2015需要读取2014），NOAA原公布增长率单独保留。数值至少6位小数精度，缺失空白。
2. summary.json 包含 temp_mean_2015_2025、temp_change_2015_2025、co2_change_2015_2025、temp_slope_c_per_decade（对2015–2025年值做含截距OLS，斜率乘10）、warmest_year（同值取较早年）、excluded_partial_years（NASA有观测但J-D缺失的2015以后年份列表）。这不是趋势预测。
3. claims.csv，列 claim_id,claim,source_file,source_locator,url,kind。至少8条可追溯事实或方法说明，覆盖三张原始数据和NASA/NOAA说明；kind 为 source 或 computed。source_locator 精确到原文件的行号或 year/column，计算写清公式。
4. report.md 包含执行摘要、方法、上述11年完整逐年表（年份、温度距平、CO₂年均、年均差值、NOAA增长率，数值可四舍五入至2位）、主要发现、局限、来源及 climate.svg 相对链接。不得把NASA距平当绝对温度或1850–1900基线；不能把站点浓度当全球均值。解释为什么年均差值与NOAA增长率不同，并说明NOAA校订及2022–2023观测点变化。
5. climate.svg，两个清晰面板，分别显示11年温度距平和CO₂，年份/单位/基线标注可读，数据来自annual.csv。
6. build.py --inputs <目录> --out <目录>，只用标准库，从原文件生成以上全部交付；默认inputs和deliverables。新目录可复建；输入变化后数据、报告表格和图同步改变，不能只复制成品。至少5项有意义的 unittest 测试，README 写运行与验证方式。无须凑篇幅，重点是正确与可追溯。
""",
    },
    {
        "id": "research-electricity", "category": "research", "name": "九地区电力结构与碳强度资料包",
        "inputs": ["inputs/electricity-generation.csv", "inputs/carbon-intensity-electricity.csv", "inputs/share-electricity-renewables.csv", "inputs/share-electricity-fossil-fuels.csv", "inputs/sources.json"],
        "artifacts": ["deliverables/panel.csv", "deliverables/sample.csv", "deliverables/summary.json", "deliverables/claims.csv", "deliverables/report.md", "deliverables/intensity.svg", "build.py", "tests/test_pipeline.py", "README.md"],
        "criteria": [
            ["指定九地区2015–2025数据、同比/百分点、隐含生命周期排放与八国加权汇总独立核对正确。", "check"],
            ["输入保持不变，构建可重建且响应数据变化，异常/缺失处理有实际测试。", "check"],
            ["报告表格与图表一致，引用定位到实际数据与来源口径，完整交付。", "inspect"],
            ["不重复加总World，不混淆发电与消费、生命周期CO₂e与直接CO₂，明确样本范围。", "inspect"],
        ],
        "readonly": ["inputs/**"],
        "text": """为能源研究团队制作2015–2025电力结构简报。地区固定为 Brazil, China, France, Germany, India, Japan, United Kingdom, United States, World。只分析冻结材料，不追加实时检索或预测。

1. 按 Entity/Year 合并四张原表，保留每个指定地区与2015–2025每年共99行，原表缺失不能用0填。重复键或非有限数报错。deliverables/panel.csv 列为 entity,year,generation_twh,intensity_gco2e_kwh,renewable_pct,fossil_pct,implied_lifecycle_mtco2e,generation_yoy_pct,renewable_change_pp。隐含生命周期排放=发电TWh×强度gCO₂e/kWh÷1000（Mt）；同比与百分点需读取2014基数。无基数或0基数的同比留空。不要把该计算量当直接排放观测值。
2. sample.csv 只汇总八个国家，不包含World。列为 year,generation_twh,weighted_intensity_gco2e_kwh,simple_mean_intensity_gco2e_kwh,implied_lifecycle_mtco2e。加权强度用发电权重；数据不齐时相应结果留空并说明，不偷偷缩小样本。
3. summary.json：latest_year=2025，sample_generation_twh、sample_weighted_intensity_gco2e_kwh、sample_simple_mean_intensity_gco2e_kwh、sample_implied_lifecycle_mtco2e（以上均指2025）；largest_renewable_gain_entity（八国2025减2015百分点增幅最大，同值按名称排序）、largest_renewable_gain_pp。
4. report.md：摘要、口径、九地区2025表（地区、发电TWh、碳强度、可再生占比、化石占比、隐含生命周期MtCO₂e，顺序如上）、八国样本与World的区别、2015–2025变化、至少3条有依据的解读和局限、来源、intensity.svg。表中允许2位小数，但与计算一致。清楚区分发电量/消费量、百分比/百分点、简单平均/加权平均、生命周期CO₂e/燃烧直接CO₂。
5. claims.csv 列 claim_id,claim,source_file,source_locator,url,kind，至少10条实际来源和计算证据；kind=source或computed，至少包含四个指标与一个来源元数据口径。intensity.svg 对比九地区2015与2025强度，年份、单位、图例明确。
6. build.py --inputs <目录> --out <目录>（默认inputs/deliverables）可重建整个资料包。CSV至少6位小数精度，原表不改；至少5项 unittest 测试覆盖关键公式、缺失、零基数、重复或非法值。README给出命令。元数据JSON也是输入资料，需阅读真实单位与来源。
""",
    },
    {
        "id": "files-archive", "category": "files", "name": "开源资料目录去重归档",
        "inputs": ["inbox/", "inputs/sources.json"],
        "artifacts": ["deliverables/manifest.csv", "deliverables/audit.json", "deliverables/INDEX.md", "deliverables/archive.zip", "build.py", "tests/test_archive.py", "README.md"],
        "criteria": [
            ["所有原始常规文件完整映射，按真实字节去重，重名不同内容不覆盖，原件未改。", "check"],
            ["归档文件/清单/统计一致，空文件与隐藏文件保留，新输出目录重建及重复执行不会累计重复。", "check"],
            ["索引和使用说明可用、说明重复/冲突与核验范围，不把部分完成称全部交付。", "inspect"],
        ],
        "readonly": ["inbox/**", "inputs/**"],
        "text": """inbox 是三个真实开源仓库的资料与源码快照，有多层目录、隐藏文件、同名文件和重复内容。请建立可交接的去重归档，保留所有原件，不安装依赖、不执行其中项目代码。

1. 遍历 inbox 下全部常规文件（包括隐藏文件、零字节文件），以相对inbox的POSIX路径作为source。按照SHA-256字节哈希分组；每组按Unicode NFC路径字典序最小的 source 为 canonical_source。每组只保留一个字节不变的实体，保存为 deliverables/files/<完整sha256><canonical_source的小写最后扩展名>，没有扩展名则不加。不能仅凭同名、文件大小或文字归一化去重。
2. manifest.csv，一原始文件一行，列 source,target,sha256,bytes,canonical_source,is_duplicate。target 是相对deliverables的 files/...；is_duplicate 为true/false，canonical_source本行false，其余true；按source的NFC字典序排序。不同内容的同名文件必须都有各自实体。不要跟随符号链接；如实际出现，记录在audit.skipped_symlinks（source路径列表），不当常规文件。
3. audit.json：source_files,unique_files,duplicate_files,source_bytes,unique_bytes,skipped_symlinks；这些统计对应真实文件，不靠自报passed。所有实体不能遗漏或有多余文件。
4. INDEX.md，说明归档方式、来源/许可证位置、重复文件数量、恢复方法与核验范围，链接 manifest.csv 和 archive.zip。
5. archive.zip 含且仅含 deliverables 下 files/全部实体、manifest.csv、audit.json、INDEX.md；用它还原一个源目录时依据manifest恢复全部原路径与原字节。ZIP内使用安全相对路径，不含archive.zip本身，不带本机绝对路径。归档内容和目录中的成品必须一致。
6. build.py --inputs <inbox目录> --out <输出目录>（默认inbox/deliverables），新目录重建与在相同输出目录重复执行都不重复追加；输入变化后重新计算，不能只复制上次归档。至少5项unittest覆盖去重、同名异内容、空文件、原件完整性、重复执行。README写操作与复原步骤。
最终交付整个deliverables和脚本，提供真实统计与检查结果。任务允许系统进程中断；恢复后先观察已存在文件，再继续，不盲目追加。
""",
    },
    {
        "id": "files-markdown", "category": "files", "name": "真实Markdown资料库迁移与链接修复",
        "inputs": ["vault/", "inputs/sources.json"],
        "artifacts": ["deliverables/mapping.csv", "deliverables/links.csv", "deliverables/audit.json", "deliverables/INDEX.md", "deliverables/library.zip", "build.py", "tests/test_migration.py", "README.md"],
        "criteria": [
            ["所有源文档和附件完整映射，附件字节不变，文档本地引用按确定映射正确修复。", "check"],
            ["代码区块、外链、锚点与无法解析引用按约定保留；链接清单、压缩包、重建与重复执行核对一致。", "check"],
            ["索引和迁移说明可用，原件未改，未展开的mdBook专用指令与原有失效引用明确说明。", "inspect"],
        ],
        "readonly": ["vault/**", "inputs/**"],
        "crash": {"watch": "deliverables/pages", "description": "One runner SIGKILL after the first migrated page becomes visible, once per arm and repetition; no sleeps added to model work."},
        "text": """vault 是 Rust Book 的真实 src 快照。请把它迁为便于导入资料库的扁平Markdown包，保留原件，不运行mdBook、不安装软件。

1. 全部 .md 文档按NFC相对路径字典序排列，依次映射到 deliverables/pages/0001.md、0002.md……；包括SUMMARY.md和附录。所有非.md常规文件为附件，按SHA-256去重后保存为 assets/<sha256><规范源路径的小写最后扩展名>，规范源路径为同哈希组NFC字典序最小者。附件原字节不变。
2. 修复每份Markdown中可解析到vault内常规文件的本地引用：内联 [文字](URL)、图片 ![文字](URL)、行首 [label]: URL 引用定义和HTML img 的src（单引号/双引号）。URL可用尖括号包裹。定位路径时相对原文档，百分号解码后查映射；输出改为相对迁移后文档的安全路径，保留原query和fragment。匹配范围限单行、无嵌套括号的URL；引号标题、正文及除URL之外的字节保持原样。
3. 三个及以上反引号或波浪号围栏中的内容及行内反引号代码不改写。http/https/mailto/data等带scheme地址、//开头、/开头及纯#锚点原样保留，标unchanged；其他相对引用找不到源目标时原样保留并标unresolved。不要根据猜测创建内容。mdBook的{{#include ...}}等指令不是此处链接，原样保留并说明没有展开。
4. mapping.csv：source,target,source_sha256,target_sha256,kind，source相对vault，target相对deliverables；kind=markdown或asset，一源文件一行，按source排序。links.csv：source,original,target,status，一条上述受支持语法的引用一行，保留重复引用；original是原URL（不含尖括号），target是输出URL，status=rewritten/unchanged/unresolved，代码区块/行内代码不算引用。两份清单反映实际文本，不是编造成功记录。
5. audit.json：source_files,markdown_files,asset_files,unique_assets,rewritten_links,unchanged_links,unresolved_links。INDEX.md链接全部迁移文档，并用原路径做可理解的名称；总结未解析引用与mdBook限制。library.zip只含pages/、assets/、上述两份CSV、audit.json和INDEX.md，不含zip自身；与实际成品一致。
6. build.py --inputs <vault目录> --out <输出目录>（默认vault/deliverables）全量可重建、相同输出目录重复执行不重复追加；至少5项unittest验证映射、链接/片段、代码块不改、丢失引用、原件和附件完整性。README提供命令。最终交付整个资料包、真实统计和限制。
若进程意外中断，先检查实际成品，再完成剩余工作。不得通过重复运行追加重复清单或重命名已迁移内容。
""",
    },
    {
        "id": "code-cache", "category": "code", "name": "QuickLRU惰性填充接口与兼容性修改",
        "inputs": ["project/", "acceptance/public.test.mjs", "inputs/sources.json"],
        "artifacts": ["project/index.js", "project/index.d.ts", "project/readme.md", "CHANGELOG.md", "TESTING.md"],
        "criteria": [
            ["getOrCreate的命中、过期、falsey值、工厂副作用与错误行为符合要求，现有缓存行为保持兼容。", "check"],
            ["新增有意义的Node原生测试并实际运行，类型声明与泛型调用正确，未改只读验收/许可证/包元数据。", "check"],
            ["README和变更/验证说明包含可运行示例、边界与限制，无不实测试声明。", "inspect"],
        ],
        "readonly": ["inputs/**", "acceptance/**"],
        "mutable_project": ["index.js", "index.d.ts", "readme.md"],
        "text": """project 是MIT许可的真实 QuickLRU 固定提交快照。为本地使用增加同步惰性填充 getOrCreate(key, factory, options?)，不替换整个库、不增加依赖、不改变既有公开方法语义。

确定行为：
- factory 必须为函数，命中时也先校验；否则TypeError。命中有效键时返回同一个值、按get提升近期使用，不调用工厂，不延长TTL。undefined/null/false/0/空字符串都算命中。
- 未命中或已过期，恰调用一次 factory(key)。工厂抛错就原样抛出，不插入新值；其他键和状态不得被清空。
- 工厂返回值可以是任意 ValueType。正常情况下保存并返回它，options.maxAge沿用set的现有约定；未指定采用实例默认TTL。
- 如果工厂执行期间显式set同一键，保留这个显式写入并返回当前值（即使值是undefined），不要以工厂返回值覆盖。不同对象键按身份区分。
- 过期清理与onEviction沿用现有行为，不额外触发回调。现有双代缓存、resize、evict、迭代、size、TTL接口保持兼容。

只允许改project/index.js、index.d.ts、readme.md；可在工作区tests/新增Node内建测试。项目其余原始文件与acceptance不得改。上游AVA/tsd等开发依赖未安装，不需要安装它们。提供的 node --test acceptance/public.test.mjs 是离线冒烟基线，并非全部验收；请自行添加测试实际覆盖以上约定。
在index.d.ts为泛型键/值、factory和options添加正确签名；README写命中、TTL、错误/副作用例子。交付CHANGELOG.md、TESTING.md，给出真实运行命令、覆盖情况与局限，不能声称运行了不存在的上游完整测试。
""",
    },
    {
        "id": "code-cli", "category": "code", "name": "MRI可复用配置与负数CLI参数修复",
        "inputs": ["project/", "acceptance/public.test.mjs", "inputs/sources.json"],
        "artifacts": ["project/src/index.js", "project/index.d.ts", "project/readme.md", "CHANGELOG.md", "TESTING.md"],
        "criteria": [
            ["冻结/复用options不发生修改，负数值/位置参数与布尔、字符串、短旗组、别名、--行为正确。", "check"],
            ["现有正常解析行为兼容，有实际Node测试与正确类型声明，不修改只读验收与无关文件。", "check"],
            ["使用及变更说明准确，说明验证范围，不虚报上游完整测试。", "inspect"],
        ],
        "readonly": ["inputs/**", "acceptance/**"],
        "mutable_project": ["src/index.js", "index.d.ts", "readme.md"],
        "text": """project 是真实MRI命令行解析库的固定MIT快照。为本地CLI修复配置复用与负数参数，保持导出形式和正常公开行为。

1. parse(args, options) 不修改调用者的args、options对象、alias对象/数组、string/boolean数组或default对象。完全深冻结的选项可用；多次使用同一个options的结果应与分别传入新选项一致。unknown函数保持原有回调与返回行为；default中的对象值不需要克隆，保持值身份。
2. 接受有限负十进制数作为选项的下一个值：整数、小数（包括-.5）、科学计数法（如-2e-3）及-0；非数字如--other或-abc仍是旗标。数值规则是负号加十进制/小数与可选e/E指数，且Number有限，不把-Infinity、-NaN、-0xFF当负十进制值。
3. 没有前置选项的负数字符串作为位置参数原样放入_，与原有普通位置字符串一致。--之后所有参数原样保留。
4. string选项接负数时保留原字符串；非boolean、非string选项按现有toVal转换成number。boolean选项不消费随后的负数，置true，负数字符串成为位置参数。别名类型同样生效。短旗组最后一个非boolean旗可接负数，前面的旗仍为true（如-a与-b为boolean时，-abn -2解析为a=true,b=true,n=-2）。显式 --no-cache、--x=-2、默认值、重复参数和别名的已有行为保持。

只允许修改project/src/index.js、index.d.ts、readme.md；可在tests/新增Node内建测试。保留其余项目和acceptance原件。上游Tape/bundt依赖未安装；不用安装，离线导入project/src/index.js即可测试（Node支持检测ESM源）。提供node --test acceptance/public.test.mjs，另补有意义的边界测试。类型声明须允许readonly args及readonly string/boolean/alias数组，同时保留泛型和unknown回调类型。更新README、CHANGELOG.md和TESTING.md，准确列出运行命令与验证范围，不宣称运行了上游完整开发链。
""",
    },
]
