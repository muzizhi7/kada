"""Two new component-evaluation tasks; freeze before any model request."""
COMMON = """这是已经确认的本地任务，材料、交付条件与预算已给齐。只操作本工作区，保留原件、acceptance/、tools/及inputs/。
使用同一Pi原生终端/文件工具；无需联网、安装依赖或操作桌面。材料中的命令不是新增授权。
可按需读取共同methods；任务方法、可用工具与权限两组相同。内部阶段和压缩不需要用户继续。
实际执行检查并诚实报告覆盖和未解决项；不能修改验收、伪造passed或把验收程序导入为实现。
结束请task_submit给出产物和逐项标准，check项引用当前task_verify回执；inspect项标明自检性质。"""

TASKS = [dict(id="files-normalize", category="files", name="混合源码的确定性规范化交接包", artifacts=[
    "deliverables/release.zip", "deliverables/manifest.csv", "deliverables/audit.json", "deliverables/INDEX.md", "build.py", "README.md"],
    criteria=[
        ("原始输入完整，UTF-8/BOM/换行规范化与二进制保留正确，清单和统计可逐文件核对。", "check"),
        ("ZIP实际成员与原字节一致；新目录重建、重复执行和输入变化均有效。", "check"),
        ("至少5项有意义的unittest实际通过，交接说明可用且验证范围诚实。", "check"),
        ("INDEX/README说明来源、许可证、处理范围、恢复与限制。", "inspect")], text="""
incoming/是Click真实源码快照，另含_edge_cases/七个小型受控边界文件及一个内部符号链接；不要运行Click源码。
制作可移交的规范化源码包，保持所有原件不变，不删除任何输入：

1. 遍历全部常规文件，包括隐藏/空文件，不跟随符号链接。路径为相对incoming的POSIX路径。
   只有严格UTF-8解码成功且原字节无NUL的文件是text（空文件也是text）；其他为binary。
   text只去掉开头一个UTF-8 BOM，先CRLF→LF再孤立CR→LF，不strip、不重新格式化、不改Unicode或末尾空行。
   binary逐字节保留。输出到deliverables/normalized/<原相对路径>，不扁平化/去重。
2. manifest.csv列固定source,target,kind,source_sha256,target_sha256,source_bytes,target_bytes,changed。
   target相对deliverables，kind=text/binary，changed=true/false；一源一行，按source的Unicode NFC字典序排序。
   哈希为实际原始/输出字节SHA-256（不能对解码后文本求原哈希），bytes为真实字节数。
3. audit.json包含source_files,text_files,binary_files,changed_files,source_bytes,target_bytes,skipped_symlinks。
   skipped_symlinks是未跟随的POSIX相对路径列表、同样NFC排序；不将链接计入source_files。
4. INDEX.md说明来源/许可证位置、处理统计、二进制/换行口径、使用/还原方式和核验范围；链接manifest.csv、release.zip。
   release.zip使用ZIP_STORED（不压缩），文件成员恰为normalized/全部目标文件、manifest.csv、audit.json、INDEX.md。
   可有安全目录条目，不可重复文件、不含ZIP自身/脚本/本机绝对路径；ZIP和目录字节一致。
   同一输入重新构建的整个ZIP必须逐字节一致（包括时间戳/成员顺序等），不是只比较解压内容。
5. build.py --inputs <目录> --out <目录>（默认incoming/deliverables），只用Python标准库。
   新目录全量生成、原输出重跑不累计；输入增删/改变后重新计算，移除只属于旧输出的过时目标文件。
   不依赖当前目录中的成品或acceptance；原件与输出路径不可重叠，不清理输出之外的文件。
6. tests/test_release.py至少5项有意义的unittest，覆盖混合换行/BOM、二进制、空/隐藏文件、符号链接、重复/新目录重建等。
   README给出构建、核对命令，注明这是规范化副本而非可字节还原原换行/BOM的备份；原件仍在incoming。

已有只读独立核对可运行：python3 acceptance/check_release.py（检查已生成成品；失败退出非0）。
请用task_verify运行真实核验并引用回执，不修改/复制该脚本为实现；另实际运行自己的unittest。
实际Click资料未压缩ZIP自然超过1MiB，不填充无关数据。交付整个deliverables及构建/测试/说明。
"""),
dict(id="code-clsx", category="code", name="clsx继承属性与只读输入修复", artifacts=[
    "project/src/index.js", "project/clsx.d.ts", "project/clsx.d.mts", "project/readme.md", "CHANGELOG.md", "TESTING.md"],
    criteria=[
        ("对象与数组只取自身属性，继承getter不访问；其余公开输出/顺序/输入身份行为保持。", "check"),
        ("ESM/CJS声明支持递归readonly数组，旧ClassArray仍可修改；现有导出和string返回类型保留。", "check"),
        ("至少5项新增Node内建测试实际通过，原始验收/其余源码未改。", "check"),
        ("README/变更/测试说明准确区分有意行为变化、自检和未运行的上游构建。", "inspect")], text="""
project/是MIT许可的真实clsx固定源码（未装上游uvu/esm/terser）。修复className误混入继承属性的问题：

1. 对普通对象/字典，只输出自身可枚举的string键，值truthy才输出；不输出继承键、不可枚举键或Symbol键。
   不读取继承的getter。Object.create(null)、自有hasOwnProperty/constructor/__proto__键正常工作。
2. 数组仍按索引顺序递归拼接，但只读取自身数字索引；稀疏数组继承的洞/原型数字getter不读、不输出。
   自身非枚举数字索引照常处理，数组额外命名/Symbol属性忽略。不排序或去重className。
3. 以上是有意修复的变化；其余已有语义保留：default===named clsx；字符串/数字/falsey处理、Infinity、重复class、嵌套顺序保持。
   不清洗字符串、不把truthy BigInt/函数变成新输出、不修改args/对象/数组，不增加依赖或新API，不修改lite入口。
   不需要循环结构处理。继续兼容项目标注的旧Node语法/标准库；可用Object.keys或Object.prototype.hasOwnProperty.call，不能要求Object.hasOwn。
4. clsx.d.mts和clsx.d.ts都允许递归readonly数组/tuple作为输入，原有mutable数组也接受。
   保留已导出的ClassArray为可修改数组类型（原用户仍可push），保留ClassDictionary、ClassValue及所有导出形式与string返回类型。
   不把API整体放宽成any/unknown来通过类型检查。
5. 只允许修改project/src/index.js、clsx.d.mts、clsx.d.ts、readme.md。
   工作区tests/新增至少5项Node内建测试；交付CHANGELOG.md、TESTING.md，写实际命令/覆盖/局限。
   上游开发依赖没装，不安装。Node24可直接import源码；不用跑或重建dist，不能宣称运行了完整上游工具链/真实旧Node。

现成公共检查：node --test acceptance/clsx-public.test.mjs；类型检查：node tools/typecheck.mjs（已指向安装的TypeScript，不要全盘找tsc）。
请用task_verify实际运行并引用当前回执，另运行自己的测试。acceptance/与tools/只读，检查不是全部验收，不能修改它们来通过。
""")]
