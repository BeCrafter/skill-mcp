# skill-mcp Helm Chart

Kubernetes deployment for **skill-mcp**, the MCP server that manages reusable skill packages for AI assistants.

This chart wraps the runtime documented in [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) and exposes every knob from the [`Environment Variables Reference`](../../CLAUDE.md#environment-variables-reference) under typed `values.yaml` keys.

## TL;DR

```bash
helm install skill-mcp ./charts/skill-mcp \
  --namespace skill-mcp --create-namespace \
  --set secrets.authToken=$(openssl rand -hex 32)
```

## Prerequisites

- Kubernetes ≥ 1.25
- Helm ≥ 3.10
- A default StorageClass that can satisfy `ReadWriteOnce` for the SQLite PVC (10Gi by default)

## Key choices baked into the chart

| Choice                                  | Why                                                                                                                     |
|-----------------------------------------|-------------------------------------------------------------------------------------------------------------------------|
| `replicas: 1` + `strategy: Recreate`    | Runtime uses SQLite (single-writer). Two pods sharing a PVC will corrupt the DB. Recreate prevents two-writer overlap. |
| `autoscaling.enabled: false`            | Same reason. Re-enable only after switching to Postgres (P1 §3.1.1).                                                    |
| Liveness on `/api/v1/livez` (no DB)     | A stuck DB must NOT cascade into kubelet restart loops.                                                                 |
| Readiness on `/api/v1/readyz` (DB ping) | If DB is unreachable, drop the pod from Service endpoints — but don't kill it.                                          |
| `readOnlyRootFilesystem: true`          | Defence in depth. Writable scratch is provided via `/tmp` emptyDir + the data PVC.                                      |
| `runAsNonRoot: true`, UID/GID 1000      | Image must be built to honour this; default ghcr.io image is.                                                           |
| `persistence.enabled: true`             | Skills are user-uploaded artifacts. Losing the PVC = losing customer data.                                              |

## Common scenarios

### A. Standalone, single-cluster (default)

```yaml
config:
  deploymentMode: standalone
  transport:
    type: http
    port: 3000
secrets:
  authToken: <generated>
ingress:
  enabled: true
  className: nginx
  hosts:
    - host: skill-mcp.example.com
      paths:
        - path: /
          pathType: Prefix
```

### B. Gateway → remote cloud service

```yaml
config:
  deploymentMode: gateway
  gateway:
    cloudServiceUrl: http://skill-mcp-cloud.skill-mcp.svc.cluster.local:3000
secrets:
  gatewayAuthToken: <token issued by upstream>
```

Set `config.mcpOnlyMode: true` for the client-facing replica to hide `/api/admin/*`.

### C. Cloud service backend (data plane only)

```yaml
config:
  deploymentMode: cloud
  transport:
    type: http
  storage:
    type: aliyun-oss
    bucket: skill-mcp-prod
    region: oss-cn-hangzhou
secrets:
  aliyun:
    accessKeyId: <key>
    accessKeySecret: <secret>
```

In this mode `/api/gateway/*` is the only client-facing surface; MCP tools are disabled.

## Probes

The chart wires three probe endpoints that came out of P0 §6.4:

- **`/api/v1/livez`** — process is alive. Returns 200 unconditionally; never touches the DB.
- **`/api/v1/readyz`** — process is ready to serve. Performs `SELECT count(*)` against the skill table. Returns `503` if the DB is unreachable.
- **`/api/v1/livez`** as the startup probe target — gates liveness/readiness until first migrations complete. Default budget is `30 × 5s = 150s`.

Override per-probe budgets through `values.probes.*`.

## Secrets

The chart writes a `Secret` from `values.secrets.*` by default. To plug into an existing secret manager:

```yaml
secrets:
  create: false
  existingSecret: skill-mcp-prod   # must contain SKILL_MCP_AUTH_TOKEN, etc.
```

External-Secrets / Sealed-Secrets / Vault Agent users typically take this path.

## Values reference

See [`values.yaml`](./values.yaml) for the exhaustive list with inline rationale. The most-used keys:

| Key                                | Default                                  | Notes                                        |
|------------------------------------|------------------------------------------|----------------------------------------------|
| `image.repository`                 | `ghcr.io/becrafter/skill-mcp`            |                                              |
| `image.tag`                        | `""` → falls back to `.Chart.AppVersion` |                                              |
| `config.deploymentMode`            | `standalone`                             | `standalone` / `gateway` / `cloud`           |
| `config.mcpOnlyMode`               | `false`                                  | Disable `/api/admin/*` when `true`           |
| `config.storage.type`              | `local-fs`                               | `local-fs` / `aliyun-oss`                    |
| `config.transport.{type,port}`     | `http` / `3000`                          | stdio is not useful inside k8s               |
| `persistence.size`                 | `10Gi`                                   | SQLite + skills + L2 cache                   |
| `probes.{liveness,readiness}.path` | `/api/v1/livez` / `/api/v1/readyz`       |                                              |
| `secrets.authToken`                | `""`                                     | Required for stdio mode; ignored over HTTP   |
| `autoscaling.enabled`              | `false`                                  | Do NOT flip to true while DB = SQLite        |

## Smoke test

```bash
helm lint charts/skill-mcp
helm template release-test charts/skill-mcp --debug | kubectl apply --dry-run=client -f -
```

## Uninstall

```bash
helm uninstall skill-mcp -n skill-mcp
# PVC is retained by default — delete explicitly if you want to wipe data.
kubectl delete pvc -n skill-mcp -l app.kubernetes.io/instance=skill-mcp
```
