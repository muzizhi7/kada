# 把一份混合源码资料整理为可移交的包，并修好已有构建器

这是一个可展示的开发案例，不是留出评测。incoming/ 是实际 Click 固定源码及声明的少量格式边界文件；来源、提交和许可证在 inputs/provenance.json。修复 project/build.py，保持 Python 3.9+ 标准库 CLI，默认 --inputs incoming --out deliverables，并支持任意新输出目录。不联网、不执行 Click 源码、不安装依赖、不操作桌面。只写 project/、tests/、deliverables/、README.md；其他输入保持原样。

最终交付：project/（修好的构建器）、tests/（至少5项真正执行的 unittest）、README.md（命令、变更、验证范围）、deliverables/（规范化副本、清单、统计、INDEX、release.zip）。目录、空文件和空目录本身都是合法交付。允许用同一份命令回执覆盖相关标准，不要为登记添加无关步骤。

处理与交接要求：

1. 遍历全部常规文件，保留隐藏/空文件、相对路径和空目录；不跟随符号链接。text = 原字节严格UTF-8且无NUL（空文件是text）。text至多去掉一个开头BOM，然后CRLF→LF、孤立CR→LF，除此不变。binary逐字节保留。
2. manifest.csv固定8列：source,target,kind,source_sha256,target_sha256,source_bytes,target_bytes,changed。source为输入相对POSIX路径，target为normalized/<source>；真实原字节/目标字节哈希与长度，changed为true/false，按source的Unicode NFC形式排序。
3. audit.json包含source_files、text_files、binary_files、changed_files、source_bytes、target_bytes、skipped_symlinks，全部从真实文件核对。
4. INDEX.md含上述统计，链接manifest.csv/audit.json/release.zip，说明原件在incoming/、规范化不可逆/不是原字节备份、源码语义未检查，准确给出normalized/LICENSE.txt。不要把资料包叫可还原原字节的备份。资料不支持的事实不能补写为已核验。
5. release.zip为ZIP_STORED，文件成员恰好为normalized下全部文件及manifest.csv/audit.json/INDEX.md；字节和磁盘一致。保留空目录的ZIP目录条目，无重复/不安全名字。固定元数据与顺序；同一输入在默认/任意新目录重建时整个ZIP逐字节相同，不嵌入本机路径/时间。每次重建清理过时输出，输入增删改后重新计算，不能清理--out之外的任何文件，拒绝输入/输出重叠。
6. 新增至少5项有意义的unittest；README写实际执行的命令、结果和没覆盖的范围。已有验收程序不能修改、删减或复制成实现。

确认说明必须包含一项check标准，其verification为：

```json
{"command":"python3 acceptance/check.py","inputs":["acceptance","incoming","inputs"],"outputs":["project","tests","README.md","deliverables"]}
```

该命令核对实际字节/统计/ZIP、默认与新目录重建、重复、输入增删改、原件、空目录及自编测试。其他标准可以具体自检，但不能冒称独立语义证明。确认前只读并提出说明；确认后在总预算USD0.25、执行时限15分钟内自主修复、执行检查和交付，无需再问继续。按需读取共同methods；不读取其他运行、参考答案、配置或凭据。
