# Implicit Tailscale authentication

Users reaching `https://2core.giraffe-gamma.ts.net` through private Tailscale Serve are authenticated by the tailnet policy. They do not enter, receive, or store an app access key. Direct TCP/LAN requests still require the existing bearer key.

## Transport boundary

The normal TCP listener on port 8787 always checks the bearer key. It ignores `Tailscale-User-*`, `Host`, and forwarding headers for authentication. The second HTTP listener is a Unix socket accessible only to the app's Unix user and host root. Host `tailscaled` proxies to that socket:

```sh
cd /opt/2core
mkdir -p tailscale-runtime
chown 1000:1000 tailscale-runtime
chmod 700 tailscale-runtime
```

The production `.env` contains:

```dotenv
TAILSCALE_SOCKET=/run/2core-tailscale/serve.sock
TAILSCALE_ORIGIN=https://2core.giraffe-gamma.ts.net
```

Compose mounts the private directory into the container. After recreating the service:

```sh
tailscale serve --bg unix:/opt/2core/tailscale-runtime/serve.sock
tailscale serve status
```

Keep this endpoint **Serve/tailnet-only**. The private listener trusts traffic delivered to it; enabling public Funnel or adding another untrusted proxy to this socket would change that authentication boundary. Access is granted to any tailnet client allowed to reach this Serve endpoint, including tagged devices. No identity header is required.

Serve rewrites the upstream `Host`, so the app authenticates the private transport rather than trusting that header. Browser writes require an exact matching configured HTTPS `Origin`, in addition to the existing JSON-only command contract. Non-browser clients can supply the normal bearer key. No CORS access is enabled.

## UI contract for the UI agent

`GET /api/auth` returns `{authenticated: true, mode: "tailscale"}` on the private listener, and `{authenticated: false, mode: "key"}` for an unauthenticated LAN client. An authenticated bearer request reports `mode: "key"` on LAN.

`web/auth.js` exports `detectImplicitAuthentication()`. `web/app.js` has three small hooks: await that function at startup; allow `load()` when either implicit auth or a key exists; hide the app's Lock button in implicit mode. Preserve these hooks when modifying the UI. The local hook falls back to key authentication if a still-running development server cannot yet serve the new module; restart that server to load the new routes. There is no app logout for Tailscale identity—access is controlled by the tailnet.

This change was deployed as a narrow patch to the existing production UI. The UI agent's unfinished layout/animation changes were not deployed by this task.

## Updates and rollback

Normal deployments preserve `.env`, `tailscale-runtime`, and Tailscale Serve configuration. Deploy the current backend and `web/auth.js` together with the UI hooks. For rollback to a version before socket authentication, first restore the old app, then point Serve back to the key-protected TCP listener:

```sh
tailscale serve --bg http://192.168.2.6:8787
```

The existing app key remains valid and unchanged throughout.
