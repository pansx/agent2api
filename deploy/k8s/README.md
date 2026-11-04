# k3s-frps 部署

集群约定与同集群的 `workbuddy2api` / `logicc2api` 一致：每项目一个 namespace、
镜像走阿里云个人 ACR（`acr-pull` 拉取凭证）、`local-path` PVC、NodePort 暴露。

| 项 | 值 |
| --- | --- |
| 命名空间 | `agent2api` |
| 镜像 | `crpi-uj5w1t4aai9wiimi.cn-hangzhou.personal.cr.aliyuncs.com/pansx1/agent2api:3.4.0` |
| 端口 | Service 3065 → NodePort 30665 |
| 数据卷 | `agent2api-data`（2Gi，挂 `/data`） |
| 调度节点 | `pansx-ubuntu`（局部卷绑节点） |
| 面板 | http://43.139.52.59:30665/ 或 http://pansx-ubuntu.tailf39776.ts.net:30665/ |

## 首次部署

```bash
# 1. 构建并推送镜像（amd64 单架构，仓库只跑 x86 节点）
docker buildx build --platform linux/amd64 --provenance=false \
  -t crpi-uj5w1t4aai9wiimi.cn-hangzhou.personal.cr.aliyuncs.com/pansx1/agent2api:<版本>-<短哈希> \
  --push .

# 2. namespace + ACR 拉取凭证（从已有项目复制）
kubectl --context k3s-frps apply -f deploy/k8s/agent2api.yaml   # 先建出 namespace
kubectl --context k3s-frps -n workbuddy2api get secret acr-pull \
  -o jsonpath='{.data.\.dockerconfigjson}' | base64 -d > /tmp/acr-pull.json
kubectl --context k3s-frps -n agent2api create secret generic acr-pull \
  --type=kubernetes.io/dockerconfigjson --from-file=.dockerconfigjson=/tmp/acr-pull.json

# 3. 管理员账号（不预置的话公网面板会被「先到先注册」占走）
kubectl --context k3s-frps -n agent2api create secret generic agent2api-admin \
  --from-literal=AGENT2API_ADMIN_USER=admin \
  --from-literal=AGENT2API_ADMIN_PASSWORD='<自定义密码>'

# 4. 全量 apply 并等待就绪
kubectl --context k3s-frps apply -f deploy/k8s/agent2api.yaml
kubectl --context k3s-frps -n agent2api rollout status deploy/agent2api
```

## 升级

改 `agent2api.yaml` 里的 `image:` tag 后重新 apply；`SELF_UPDATE=0` 已关闭面板内
原地更新（只读根文件系统下也无法写入，版本以 Deployment 的 tag 为唯一事实）。

```bash
kubectl --context k3s-frps set image deploy/agent2api \
  agent2api=crpi-uj5w1t4aai9wiimi.cn-hangzhou.personal.cr.aliyuncs.com/pansx1/agent2api:<新tag>
```

RWO 卷 + SQLite，所以是 `Recreate` 策略：升级会短暂停服（数秒），不会出现两个
Pod 同时开库。

## 与容器默认形态的差异

| 环境变量 | 集群取值 | 原因 |
| --- | --- | --- |
| `AGENT2API_PROXY_HOME` | `/data` | 指向 PVC，状态不随 Pod 丢失 |
| `AGENT2API_SELF_UPDATE` | `0` | 根文件系统只读；版本由镜像 tag 管理 |
| `AGENT2API_ADMIN_*` | Secret 注入 | 公网面板不让匿名注册 |

安全上下文：`runAsUser/Group/fsGroup=10001`、`readOnlyRootFilesystem=true`、
丢弃全部 capabilities、`seccompProfile=RuntimeDefault`；`/tmp` 用 emptyDir
（凭据导入、数据库备份会写临时目录）。

## 3.3 起：提供商实现改走插件

3.3.0 起网关本体不内置任何「怎么打上游」的实现，转发 / 账号解析全在提供商
插件里（官方包 `agent2api-providers`，索引 `Agent2plugin/Agent2plugin`）。
首次启动会从 GitHub 自动下载官方插件到 `/data/plugins` 并拉起宿主进程 ——
Pod 必须能出网访问 `raw.githubusercontent.com` 与 `api.github.com`（本集群
实测 200）。插件缺失时 `/v1/*` 一律 503「需要安装插件」，但网关本身照常存活。

`SELF_UPDATE=0` 只关面板内的程序自更新，不影响插件下载与更新；插件随 PVC
持久化，Pod 重建不会丢。

每日签到 / 新手福利 / 活动套餐各张卡有没有账号，取决于插件申报的
`CheckinInfo`（`daily` / `onboarding` / `plans` / `growth`）——网关不判断
「这家能不能签」，只按申报分派。3.4.0 这一版插件申报后，本集群落在每日签到
范围内的是 37 个账号（30 个 3.3.x 时代的老几家里再加 ZCode 7 个）。

## 3.4 起：模型调用必须带网关 Key

`POST /v1/chat/completions`、`/v1/responses`、`/v1/messages`、`/v1/images/*`
这类模型调用现在一律要求 `Authorization: Bearer <网关 Key>`，且 Key 必须是
「已创建且启用」的，否则直接 401：

```json
{"error":{"code":"model_api_key_required","message":"模型调用必须选择并携带 API Key，请先在「网关 Key」页创建并启用一把 Key","type":"authentication_error"}}
```

`GET /v1/models` 是元数据接口，仍然匿名可读。升级后要确认所有客户端都配了
Key；本集群当前有 3 把启用的 Key（`local` / `gongYi` / `hermes`）。

## 排查

```bash
kubectl --context k3s-frps -n agent2api logs deploy/agent2api -f
kubectl --context k3s-frps -n agent2api exec deploy/agent2api -- curl -s localhost:3065/health
```

`/health` 在未配置任何上游账号时返回 `{"status":"ok"}`（headless 安全形态只暴露
存活事实），配好账号并登录后才会带完整摘要。
