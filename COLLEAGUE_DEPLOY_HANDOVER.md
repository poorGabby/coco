# Hermes 部署交付说明（给同事）

你将用一个**专用 service account**（无需 Google 账号）把 Hermes 部署到一个**独立 GCP 项目**里。你只能操作这一个项目，碰不到组织里其他项目。

完整部署原理见随附的 `HERMES_DEPLOYMENT_GUIDE.md`。本文件只讲**你要做的事**和**要改的值**。

---

## 1. 你拿到的东西

| 项 | 值 |
|----|----|
| GCP 项目 ID | `furever-dock-hermes-agent` |
| 区域 / 可用区 | `us-central1` / `us-central1-a` |
| Artifact Registry repo | `hermes-agent`（已预建，`us-central1`） |
| Service Account | `hermes-deployer@furever-dock-hermes-agent.iam.gserviceaccount.com` |
| SA key 文件 | `hermes-deployer-key.json`（单独安全渠道发你，**勿入 git**） |
| 权限范围 | 该项目内 `editor` + IAP 隧道（够部署，但不能改 IAM/提权） |
| 计费 | 已绑定，无需你处理 |
| API | compute / artifactregistry / cloudbuild / iap 已启用 |

> APIs、AR repo、计费都已就绪，你**不用**再跑 `setup-gce.sh` 里启 API / 建 repo 的部分。

---

## 2. 用 SA key 登录 gcloud

```bash
gcloud auth activate-service-account \
  --key-file=/path/to/hermes-deployer-key.json
gcloud config set project furever-dock-hermes-agent
# 验证
gcloud config list
```

---

## 3. 必须改的硬编码值（关键！）

参考仓库里的脚本是为旧项目 `hermes-furever` 写的，硬编码了项目 ID 和镜像 URL。复制到你的仓库后，逐个替换：

| 文件 | 原值 | 改成 |
|------|------|------|
| `scripts/deploy.sh` | `PROJECT_ID="${GCP_PROJECT_ID:-hermes-furever}"` | `...:-furever-dock-hermes-agent}` |
| `deploy/startup.sh` | `us-central1-docker.pkg.dev/hermes-furever/hermes-agent/gateway:latest` | `.../furever-dock-hermes-agent/hermes-agent/...` |
| `deploy/vm-restart.sh` | 同上镜像 URL | 同上 |
| `deploy/config.yaml` | `agent.system_prompt` 里的公司名 | 改成你的 |
| 容器名 `hermes-furever` | （可保留，也可改） | startup/vm-restart 里若改要一致 |

一条命令批量替换（在你仓库根目录跑，先确认无误再执行）：
```bash
grep -rl 'hermes-furever' deploy/ scripts/ | xargs sed -i '' 's/hermes-furever/furever-dock-hermes-agent/g'
```
> ⚠️ 注意：容器名也叫 `hermes-furever`，上面这条会把容器名一并改成 `furever-dock-hermes-agent`。这没问题，只要 startup.sh / vm-restart.sh 里保持一致即可。

---

## 4. 填你自己的 `.env`

照 `.env.example` 建 `.env`，填**你自己的**飞书应用 / LLM key / 数据源密钥。`.env` 已被 gitignore。

---

## 5. 创建 VM + 部署

```bash
# 建 VM（API/repo/计费已就绪，脚本里相关步骤会幂等跳过）
export GCP_PROJECT_ID=furever-dock-hermes-agent
bash deploy/setup-gce.sh

# 构建镜像 + 部署
bash scripts/deploy.sh
```

验证（看飞书是否连上）：
```bash
gcloud compute ssh hermes-agent --zone=us-central1-a --tunnel-through-iap \
  --command='sudo docker logs -f <容器名>'
```

---

## 6. 安全须知

- **SA key 是长期密钥**：别提交 git、别发群、用完存密码管理器。建议每 90 天轮换一次（找管理员重发）。
- 你这个 SA **只能动 `furever-dock-hermes-agent` 这一个项目**，且不能改 IAM。
- `.env` 和 `*-key.json` 都不要进版本库。
