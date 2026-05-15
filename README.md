# n8n-nodes-aliyun-oss-vector

[n8n](https://n8n.io) 社区节点：对接**阿里云 OSS 向量 Bucket**（OSS Vector），支持写入向量、相似度检索、按条件过滤、删除向量与索引删除。请求使用 **OSS4-HMAC-SHA256** 与阿里云向量 OpenAPI 规范，无需额外 HTTP 节点拼装签名。

**包名（npm）**：`n8n-nodes-aliyun-oss-vector`  
**源码**：<https://github.com/liuhauyao/n8n-nodes-aliyun-oss-vector>  
**许可**：MIT · **维护**：Matrees

---

## 功能概览

| 操作 | 说明 |
|------|------|
| **Insert** | 连接 Embeddings + Default Data Loader，切块嵌入后批量写入指定向量索引 |
| **Retrieve (as Vector Store)** | 输出 `AiVectorStore`，可接官方 *Vector Store Retriever* |
| **Retrieve (as Tool for AI Agent)** | 输出 `AiTool`，供 AI Agent 直接调用检索 |
| **Query** | 在 Main 上输出相似度检索结果（含 `pageContent` / `score` / `metadata`） |
| **Delete Vectors** | 按向量 key 删除（支持批量） |
| **List Vectors** | 分页列举索引内向量 key，可选客户端 metadata 扁平 AND 匹配，便于配合删除 |
| **Delete Index** | 删除整个向量索引 |

支持 **metadata 过滤**（OSS 文档中的 MongoDB 风格操作符，如 `$eq`、`$and` 等，具体以阿里云向量索引声明的可筛选字段为准）。

---

## 环境要求

- **n8n**：与当前 `peerDependencies` 中的 `n8n-workflow` 大版本兼容的 n8n（请按实际安装的 n8n 版本核对）。
- **Node.js**：`package.json` 声明 **`engines.node` ≥ 18.18**（与全局 `fetch` / `AbortSignal.timeout` 等用法一致）；生产请以您安装的 n8n 所支持的 Node 为准。
- **依赖声明**：`package.json` 的 `peerDependencies` 仅含 `n8n-workflow`（与 n8n Verified 社区包规则一致）。节点源码使用 `zod` 做工具参数校验，由 n8n 运行环境与官方 AI 相关依赖一并提供解析；无需自行在 peer 中声明 `zod`。

安装社区节点后请**重启 n8n**，以便加载节点与凭证定义。

---

## 开发与校验（维护者）

- **`npm run verify`**：先 `tsc` 构建并复制图标，再对 **`dist/**/*.js`** 使用 `@n8n/eslint-plugin-community-nodes` 的 **recommended + `no-console`**（与官方 `npx @n8n/scan-community-package` 拉取 tarball 后对其中 JS 的检查一致），并用脚本对根目录 **`package.json`** 做单文件校验（含 `valid-peer-dependencies`、`no-runtime-dependencies` 等）。
- 发版或提交前建议在仓库根目录执行 **`npm run verify`** 通过后再发布。

---

## 安装方式

### 方式一：n8n 界面（社区节点）

1. 在 n8n 中启用**社区节点**（具体以部署文档为准，例如设置环境变量允许加载社区包）。
2. **设置 → 社区节点**，输入包名：`n8n-nodes-aliyun-oss-vector`，安装。
3. 重启 n8n（若界面提示需要）。

### 方式二：npm / 本地路径（自托管常见）

在 n8n 的社区节点目录（常为 `~/.n8n/nodes`）执行：

```bash
cd ~/.n8n/nodes
npm install n8n-nodes-aliyun-oss-vector
```

或使用本地打包文件：

```bash
npm install /path/to/n8n-nodes-aliyun-oss-vector-0.x.x.tgz
```

然后重启 n8n（如 `pm2 restart n8n`）。

---

## 凭证配置（Aliyun OSS Vector API）

新建凭证 **Aliyun OSS Vector API**，需填写：

| 字段 | 说明 |
|------|------|
| **Access Key ID / Secret** | RAM 用户访问密钥，需具备访问该向量 Bucket 及向量 API 的权限 |
| **Vector Bucket Endpoint** | 在 OSS **向量 Bucket** 控制台复制的 **Endpoint（URL 或主机名）** |

Endpoint 示例（**内网**，同地域 ECS/VPC 可访问）：

```text
https://<bucket>-<accountId>.cn-beijing-internal.oss-vectors.aliyuncs.com
```

**公网**示例（无 `-internal` 段）：

```text
https://<bucket>-<accountId>.cn-beijing.oss-vectors.aliyuncs.com
```

其中已编码：**Bucket 名称**、**主账号 UID**、**地域**、**内网/公网**。请按运行 n8n 的网络环境选择可连通的 Endpoint；凭证表单内可使用 **「测试」** 验证签名与连通性（测试会调用向量 API，占位索引名需符合规范）。

更多产品说明见阿里云文档：[向量 Bucket 概述](https://help.aliyun.com/zh/oss/user-guide/overview-vector-bucket)。

---

## 节点连接说明（简要）

- **Insert**：`Main` + **Embeddings（必填）** + **Document / Default Data Loader（必填）**  
- **Retrieve / Retrieve as Tool**：**仅 Embeddings（必填）**  
- **Query**：`Main` + **Embeddings（必填）**  
- **Delete / Delete Index**：通常仅 `Main`（按界面提示连接）

索引名称、TopK、元数据过滤、是否自动建索引与向量维度等，在节点参数中配置；**向量维度需与 Embeddings 模型输出及 OSS 索引配置一致**。

---

## 本地开发

```bash
git clone <repository-url>
cd n8n-nodes-aliyun-oss-vector
npm install
npm run build
```

构建产物输出至 `dist/`，与 `package.json` 中 `n8n.credentials`、`n8n.nodes` 路径一致。

```bash
npm pack
```

可得到可分发到服务器或 `npm publish` 的 `.tgz` 包。

---

## 相关链接

- 阿里云 OSS 向量 Bucket：[产品文档](https://help.aliyun.com/zh/oss/user-guide/overview-vector-bucket)
- n8n 社区节点：[官方说明](https://docs.n8n.io/integrations/community-nodes/installation/)

---

## 许可证

MIT（见 `package.json` 中的 `license` 字段）。
