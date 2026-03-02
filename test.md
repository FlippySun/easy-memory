🧠 Easy Memory MCP — 可行性分析报告

> 多智能体推演摘要
> 动态实例化了 5 个 Sub-Agent：架构Agent、安全Agent、检索策略Agent、数据质量Agent、DevOps Agent
> 核心矛盾点：检索质量 vs 系统复杂度（Re-ranking 提升质量但增加延迟和部署成本）
> 最终共识：Phase 1 用基础混合检索（已够用），Phase 2 再引入 Re-ranking
> 一、技术选型推荐
> 层 选型 理由
> 运行时 TypeScript (Node.js) MCP SDK 官方首选，单一运行时部署简单
> 向量数据库 Qdrant (Docker) 单容器部署、支持 Dense+Sparse 混合向量、Payload Filter 极强、~200MB 内存
> Embedding 双轨制：Ollama (本地免费) + OpenAI API (可选高质量) 兼顾免费自托管和质量优先两种需求
> Embedding 模型 nomic-embed-text (768维) / text-embedding-3-small (1536维) 性价比最优
> 分块 递归语义分块 + 10-20% overlap 按语义边界切割，代码变更按 commit 为自然单元
> VPS 最低配置
> 组件 CPU RAM Disk
> MCP Server 1核 256MB 100MB
> Qdrant 1核 512MB-1GB 按数据量
> Ollama 2核 2GB 4GB (模型)
> 总计 4核 3-4GB ~10GB
> 💡 如果 VPS 配置不够，可只用 OpenAI API Embedding，去掉 Ollama 后仅需 2核/1GB
> 二、MCP 工具接口设计（8 个工具）
> 核心工具（Phase 1）
> 工具 类型 说明
> memory_search 🔍检索 语义搜索，返回 top-k 相关记忆（附带元数据+时效性警告）
> memory_search_by_tag 🔍检索 按标签+语义混合检索
> memory_save 📝写入 保存新记忆（内部自动：安全过滤→清洗→分块→向量化→去重→入库）
> memory_save_session 📝写入 保存会话总结（特殊处理：提取结论、去除寒暄）
> memory_forget 🔧管理 软删除/标记过期
> memory_update 🔧管理 更新已有记忆（版本化，旧版不删除）
> memory_status 🔧管理 记忆库状态（总量、标签分布、健康度）
> memory_validate 🔧管理 AI 主动验证某条记忆是否仍有效
> Phase 2 扩展
> 工具 说明
> memory_related 给一条记忆找关联，形成知识网络
> memory_timeline 按时间线浏览某主题记忆演变
> 设计原则
> 清洗/分块/向量化/去重/分类 ≠ MCP 工具，全部是内部 Pipeline 自动步骤
> 工具数量控制在 8-10 个，避免 AI 选择困难
> 三、多层检索策略
> Query → Query 增强（生成变体 query）

     → 混合检索（Dense + Sparse 向量 + BM25）→ 粗筛 top-50


     → 元数据过滤（时间衰减 + 来源加权 + 标签 + 置信度门槛 ≥ 0.65）


     → Re-ranking（Cross-encoder / LLM 打分，Phase 2）


     → 返回 top-3~5（⚠️ 超过6个月的记忆标注"可能过期"）


     → 无高质量结果时返回"未找到相关记忆"（宁缺毋滥）

时间衰减公式
final_score = semantic_score × time_decay × source_weight

time_decay = max(0.3, 1.0 - 0.05 × months)

source_weight: 架构决策=1.2, 报错方案=1.1, 代码变更=1.0, 会话总结=0.9, 笔记=0.8

四、四大风险 & 对策

1. 记忆污染 — 错误结论被长期保存
   入库前：LLM 评估置信度（<0.6 标记为"待验证"）
   入库后：版本化存储（同主题不覆盖，保留版本链）
   检索时：冲突检测（同主题多版本时标注冲突，让 AI 自行判断）
   维护：memory_validate 工具、用户反馈标记
   记忆状态机：draft → active → outdated → archived（+ disputed 分支）
2. 检索漂移 — 搜出来不相关
   混合检索（语义+关键词 RRF 融合）
   Query 意图分类（事实/方案/调试/概念 → 不同检索参数）
   记忆粒度标准化（100-500 tokens/条）
   负向反馈学习（用户标记"不相关" → 降低该记忆权重）
3. 安全问题 — 密钥/隐私入库
   Layer 1：正则过滤（API Key/密码/连接串/私钥/IP/邮箱手机号）
   Layer 2：LLM 语义审查 + 自动脱敏 sk-xxx → [REDACTED]
   Layer 3：传输 TLS 加密 + 存储加密 + API Key 访问控制
4. 时效性 — 旧决策覆盖新事实
   时间衰减评分
   入库时预估有效期（代码细节=3月，架构=12月，通用=永久）
   自动矛盾检测：新记忆入库时搜索相似度>0.85的旧记忆 → LLM 判断"补充"或"矛盾" → 矛盾时旧记忆自动标记 outdated
   Cron 定期扫描过期记忆
   五、"免维护"实现策略
   维度 方案
   部署 docker compose up -d 一键部署（Qdrant + Ollama + MCP Server）
   记忆采集 AI 主动调用 memory_save（主）+ File Watcher 监听（辅）+ Git Hook/CI（可选）
   过期清理 Cron 每日凌晨自动扫描
   去重 每周自动合并相似度>0.95 的记忆
   备份 每日 Qdrant snapshot
   健康检查 定时检测 Qdrant/Ollama 状态
   升级 Watchtower 自动更新 Docker 镜像（可选）
   六、记忆质量筛选（"不是所有聊天都入库"）
   直接丢弃 ❌
   寒暄、纯操作指令、临时调试输出、重复(>0.92相似度)、太短(<20 tokens)
   直接入库 ✅
   含"决策/选择/因为…所以…"、含"解决方案/修复/原因是"、结构化内容（表格/步骤）、用户说"记住这个"
   灰色地带 → LLM 评估 🤔
   LLM 按 4 维度打分：复用性(0.35) + 确定性(0.25) + 独特性(0.20) + 完整性(0.20)，综合 ≥ 0.6 入库
   七、分阶段实施路线
   阶段 时间 内容
   Phase 1 MVP 2-3周 MCP Server 骨架 + Qdrant + 基础检索 + OpenAI Embedding + 正则安全过滤 + Docker 部署
   Phase 2 增强 2-3周 混合检索 + Ollama 支持 + LLM 质量评估 + 时间衰减 + 版本化/矛盾检测
   Phase 3 自动化 1-2周 File Watcher + Git Hook + Cron 后台任务 + Dashboard(可选)
   Phase 4 打磨 持续 Re-ranking + 领域自适应 + 反馈闭环 + 高级工具
   八、总体结论
   ✅ 完全可行，值得做。
   技术栈全部成熟可用，无需从零造轮子
   难度集中在"检索质量调优"和"记忆质量把控"（可增量优化）
   差异化核心：安全脱敏 + 质量把控 + 时效性管理 = 市场空白
   竞品对比：Mem0/Anthropic Memory 都偏简单，没有三层安全防护和矛盾检测
