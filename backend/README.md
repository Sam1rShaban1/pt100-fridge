# Backend (MQTT → InfluxDB 3 → Grafana + OTA server)

Full self-hosted stack on a VPS with a domain and Let's Encrypt TLS:

```
Pico W ──MQTTS 8883──▶ Mosquitto ──▶ Telegraf ──▶ InfluxDB 3 Core ──▶ Grafana
   │                          │
   └──HTTPS /firmware/*───────┴──▶ OTA server (FastAPI)
```

- **Caddy** terminates TLS (Let's Encrypt) for Grafana and the OTA API.
- **Mosquitto** does native TLS on 8883 for the Pico W (internal 1883 for Telegraf/OTA server).
- **InfluxDB 3 Core** stores the time series (HTTP API on 8181).
- **Telegraf** parses the MQTT JSON and writes line protocol to InfluxDB 3.
- **Grafana** visualizes (InfluxQL datasource, pre-provisioned dashboard).
- **OTA server** stores firmware binaries, serves them, and orchestrates staged rollouts.

## Prerequisites

- A VPS with Docker + Docker Compose.
- A domain with DNS A records: `grafana.<domain>`, `ota.<domain>`, `mqtt.<domain>` → VPS IP.
- Open ports 80, 443 (Caddy / ACME) and 8883 (MQTT) in the firewall.

## Setup

```bash
cp .env.example .env
# edit .env: set DOMAIN, strong passwords/tokens, PUBLIC_BASE_URL, DEVICE_GROUPS
docker compose build
docker compose up -d
```

Caddy obtains certificates automatically. The InfluxDB database (`pt100`) and the
Mosquitto `server` / `telegraf` users are created on first start.

## Per-device credentials

For every Pico W you flash, create a broker account (replace `fridge-001`):

```bash
docker compose exec mosquitto \
  mosquitto_passwd -b /etc/mosquitto/passwd fridge-001 <device-password>
```

and set `MQTT_USER` / `MQTT_PASSWORD` in `firmware/src/config.h` to match. Also add the
device id to `DEVICE_GROUPS` in `.env` so it can be targeted for rollouts.

## OTA workflow

1. Build firmware locally: `cd firmware && pio run -e pico-w` →
   `firmware/.pio/build/pico-w/firmware.bin`.
2. Open `https://ota.<domain>/` (admin token from `.env`).
3. Upload the `.bin`, set a version (e.g. `1.1.0`), the target group and the
   hardware target (`pico-w`). The server rejects UF2 files, cross-board images
   and images that cannot fit the Pico flash layout.
4. "Start staged rollout" with a canary size (e.g. 1). The server MQTT-publishes the
   update to the canary devices only.
5. Canaries download (HTTPS + SHA-256 verify), reboot, and report `success`.
6. When all canaries succeed, the server promotes the rollout to the rest of the group.
   If a canary fails, the rollout is aborted (remaining devices keep the old firmware).

Devices also self-check the manifest every hour, so a missed command is eventually applied.

Only firmware for the device's own board is ever offered: the manifest is
filtered by `hw`, and rollout targets must have reported a matching `hw` in
their `hello`. If `PUBLIC_BASE_URL` is unset/placeholder, rollout commands ask
the device to pull the manifest instead of handing it an unreachable URL.

## API (all admin endpoints require `Authorization: Bearer <OTA_ADMIN_TOKEN>`)

- `POST /api/firmware` (multipart `file`, `group`, `version`, `hw`)
- `GET  /api/firmware` (list stored images per board)
- `GET  /api/firmware/manifest?device_id=&group=&current=&hw=` (204 when nothing applies)
- `POST /api/rollout` `{version, group, canary, hw}`
- `GET  /api/rollout` , `GET /api/devices`
- `GET  /firmware/<file>` (binary, used by devices)

## Notes

- InfluxDB 3 Core is queried via InfluxQL over HTTP (port 8181). If your build does not
  enable InfluxQL, switch the Grafana datasource to the SQL/FlightSQL plugin (gRPC 8182).
- InfluxDB auth uses `INFLUX_TOKEN` (set as `INFLUXDB3_AUTH_TOKEN` on the server and reused
  by Telegraf + Grafana). To create a scoped token instead: `docker compose exec influxdb3
  influxdb3 create token --database pt100`.
- Regenerating the MQTT CA: `./mosquitto/gen-certs.sh`, then update `MQTT_ROOT_CA` in
  `firmware/src/certs.h`.
- OTA safety tests: `cd ota-server && python -m unittest discover -s tests -v`.
