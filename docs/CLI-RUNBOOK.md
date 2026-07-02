# StorageMover — Terminal Runbook (Isilon → PowerScale / Isilon → Isilon)

This is a "drive it from a shell with `curl`" guide. It skips the web UI and the
Windows gateway mode entirely.

---

## 0. Mental model (read this first)

StorageMover is **not** a CLI binary. It's a small Node server + SQLite DB that
exposes a **REST API** (and a React web UI you can ignore). You:

1. Run the server somewhere (your laptop, a jump box, a container).
2. Register/login to get a JWT.
3. Register your **source** and **target** arrays as "devices".
4. Discover exports on the source.
5. Create a migration (source + target + which exports + target base path).
6. Start it and poll status.

### What actually moves the data

When you start a migration, for each export the server does this
(`src/services/migration.ts` → `transferBetweenStorageDevices`):

```
ssh <target>                                  # connects to the TARGET device
  mkdir -p "<targetPath>"
  rsync -avz --progress \
    -e "sshpass -p '<sourcePass>' ssh -o StrictHostKeyChecking=no" \
    <sourceUser>@<source>:"<sourcePath>/" "<targetPath>/"
```

So the transfer is a **pull**: the server logs into the **target** over SSH and
runs `rsync`, which pulls from the **source** over SSH. If `rsync` exits non-zero
it falls back to `mount -t nfs <source>:<path>` on the target + `cp -r`.

**This means the requirements are on the TARGET box, not the StorageMover host:**

| Requirement | Where |
|---|---|
| SSH reachable with the creds you register | Target |
| `rsync` in PATH | Target **and** source |
| `sshpass` in PATH | Target |
| Network + SSH (tcp/22) from target → source | Target → Source |
| Write permission to the target base path | Target SSH user |

> ⚠️ **OneFS gotcha:** Isilon/PowerScale nodes ship `rsync` but usually **not
> `sshpass`**. If the target is a bare OneFS node, the `sshpass` wrapper fails and
> it drops to the NFS-mount + `cp` fallback (which needs the source NFS-exported
> and reachable from the target). For clean, resumable runs many people register a
> **Linux staging host** as the "target device" (it has rsync+sshpass, mounts both
> arrays) and let StorageMover rsync onto that, or just use the tool to *drive* the
> rsync and accept the fallback. Know which path you're on before you start a
> multi-TB job.

The device `port` field (default 8080) is only used for API discovery/test calls.
The actual data transfer always uses **SSH (tcp/22)** to the hostnames.

---

## 1. Start the server

Pick one. It listens on **`http://localhost:3001`**.

```bash
# Docker (simplest)
git clone https://github.com/sp00nznet/StorageMover.git
cd StorageMover
docker-compose up -d
docker-compose logs -f          # watch it

# --- or, from source ---
npm install
cd client && npm install && cd ..
cp .env.example .env             # set JWT_SECRET + ENCRYPTION_KEY (see below)
npm run dev
```

`.env` needs at minimum (see `docs/CONFIGURATION.md`):

```env
JWT_SECRET=$(openssl rand -base64 32)
ENCRYPTION_KEY=change-me-exactly-32-bytes-long!!   # must be 32 chars
PORT=3001
```

Sanity check:

```bash
curl -s http://localhost:3001/api/devices -o /dev/null -w '%{http_code}\n'
# 401 = server up (needs auth). Connection refused = not running.
```

---

## 2. Set up your shell

```bash
export API=http://localhost:3001/api
```

Get `jq` (`apt install jq` / `yum install jq`) — makes this sane.

---

## 3. Auth — register once, then login

```bash
# First time only: create a user
curl -s -X POST $API/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"ChangeMe123"}' | jq

# Login and capture the token into $TOKEN
export TOKEN=$(curl -s -X POST $API/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"ChangeMe123"}' | jq -r .token)

echo "$TOKEN"     # sanity check, should be a long eyJ... string
```

Every call below uses `-H "Authorization: Bearer $TOKEN"`. Token lasts 24h by
default; just re-run the login to refresh.

---

## 4. Register the source and target arrays as "devices"

`type` is one of: `isilon`, `powerscale`, `powerstore`. Username/password are the
SSH creds StorageMover will use.

```bash
# SOURCE (old Isilon)
export SRC_ID=$(curl -s -X POST $API/devices \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
        "name":"old-isilon",
        "type":"isilon",
        "hostname":"ca-isilon-02.infoimageinc.com",
        "port":8080,
        "username":"root",
        "password":"<source-ssh-pass>"
      }' | jq -r .id)

# TARGET — new PowerScale (Isilon -> PowerScale)
export DST_ID=$(curl -s -X POST $API/devices \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
        "name":"new-powerscale",
        "type":"powerscale",
        "hostname":"ca-san-isilon-01.infoimageinc.com",
        "port":8080,
        "username":"root",
        "password":"<target-ssh-pass>"
      }' | jq -r .id)

echo "SRC=$SRC_ID  DST=$DST_ID"
```

> For **Isilon → Isilon** just make the target `type":"isilon"` with the other
> cluster's hostname/creds. Everything else is identical.

Verify connectivity before you trust it:

```bash
curl -s -X POST $API/devices/$SRC_ID/test -H "Authorization: Bearer $TOKEN" | jq
curl -s -X POST $API/devices/$DST_ID/test -H "Authorization: Bearer $TOKEN" | jq
# expect {"success":true,...}
```

List devices any time:

```bash
curl -s $API/devices -H "Authorization: Bearer $TOKEN" | jq -r '.[] | "\(.id)  \(.type)  \(.name)  \(.status)"'
```

---

## 5. Discover exports on the source

```bash
curl -s -X POST $API/devices/$SRC_ID/discover -H "Authorization: Bearer $TOKEN" | jq '.count'

# List the discovered exports and their IDs
curl -s "$API/exports?deviceId=$SRC_ID" -H "Authorization: Bearer $TOKEN" \
  | jq -r '.[] | "\(.id)  \(.export_type)  \(.export_path)"'
```

Grab the export IDs you want to move. To pull **all** source export IDs into a
JSON array automatically:

```bash
export EXPORT_IDS=$(curl -s "$API/exports?deviceId=$SRC_ID" \
  -H "Authorization: Bearer $TOKEN" | jq -c '[.[].id]')
echo "$EXPORT_IDS"
```

…or hand-pick: `export EXPORT_IDS='["id1","id2"]'`

---

## 6. Create the migration

`targetBasePath` is **prepended verbatim** to each source export path. So export
`/ifs/data/share1` with `targetBasePath":"/ifs/migrated"` lands at
`/ifs/migrated/ifs/data/share1`. Use no trailing slash. Leave it empty/omit to
keep the exact same path on the target.

```bash
export MIG_ID=$(curl -s -X POST $API/migrations \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{
        \"name\":\"isilon02-to-powerscale-$(date +%Y%m%d)\",
        \"sourceDeviceId\":\"$SRC_ID\",
        \"targetDeviceId\":\"$DST_ID\",
        \"exportIds\":$EXPORT_IDS,
        \"targetBasePath\":\"/ifs/migrated\"
      }" | jq -r .id)

echo "MIG=$MIG_ID"
```

---

## 7. Start it and watch

```bash
# Kick it off (runs in background on the server)
curl -s -X POST $API/migrations/$MIG_ID/start -H "Authorization: Bearer $TOKEN" | jq

# Poll status (progress %, bytes, files, per-item state)
watch -n 5 "curl -s $API/migrations/$MIG_ID -H 'Authorization: Bearer $TOKEN' \
  | jq '{status, progress, bytes_transferred, files_transferred, items: [.items[] | {export_path, target_path, status, error_message}]}'"
```

Control:

```bash
curl -s -X POST $API/migrations/$MIG_ID/pause  -H "Authorization: Bearer $TOKEN" | jq
curl -s -X POST $API/migrations/$MIG_ID/start  -H "Authorization: Bearer $TOKEN" | jq   # resume
curl -s -X POST $API/migrations/$MIG_ID/cancel -H "Authorization: Bearer $TOKEN" | jq
```

Real-time push (optional): the server also emits WebSocket events at `ws://localhost:3001/ws`
(`migration_progress`, `transfer_progress`, `migration_completed`, …). Polling the
REST endpoint above is fine for a shell workflow.

Final statuses: `completed`, `completed_with_errors` (check per-item
`error_message`), `failed`, `cancelled`.

---

## 8. Live server logs (where the real rsync errors show up)

The migration status only tells you pass/fail per export. The actual `rsync` /
`sshpass` / mount errors land in the **server** logs:

```bash
# Docker
docker-compose logs -f storagemover | grep -Ei 'rsync|ssh|mount|migrat'

# from source
tail -f logs/combined.log
```

If an item shows `failed`, 90% of the time it's one of:
- `sshpass: command not found` on the target → install sshpass, or use a Linux
  staging target.
- SSH auth/host-key from target → source → wrong creds, or firewall on tcp/22.
- `Permission denied` on `mkdir -p <targetPath>` → the target SSH user can't write
  the base path.
- rsync fell back to NFS mount and the source isn't NFS-exported to the target.

---

## Quick reference — full run in one paste

```bash
export API=http://localhost:3001/api
export TOKEN=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"ChangeMe123"}' | jq -r .token)

export SRC_ID=$(curl -s -X POST $API/devices -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"src","type":"isilon","hostname":"SRC-HOST","port":8080,"username":"root","password":"SRCPASS"}' | jq -r .id)
export DST_ID=$(curl -s -X POST $API/devices -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"dst","type":"powerscale","hostname":"DST-HOST","port":8080,"username":"root","password":"DSTPASS"}' | jq -r .id)

curl -s -X POST $API/devices/$SRC_ID/test -H "Authorization: Bearer $TOKEN" | jq
curl -s -X POST $API/devices/$DST_ID/test -H "Authorization: Bearer $TOKEN" | jq

curl -s -X POST $API/devices/$SRC_ID/discover -H "Authorization: Bearer $TOKEN" | jq .count
export EXPORT_IDS=$(curl -s "$API/exports?deviceId=$SRC_ID" -H "Authorization: Bearer $TOKEN" | jq -c '[.[].id]')

export MIG_ID=$(curl -s -X POST $API/migrations -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"name\":\"run-$(date +%Y%m%d)\",\"sourceDeviceId\":\"$SRC_ID\",\"targetDeviceId\":\"$DST_ID\",\"exportIds\":$EXPORT_IDS,\"targetBasePath\":\"/ifs/migrated\"}" | jq -r .id)

curl -s -X POST $API/migrations/$MIG_ID/start -H "Authorization: Bearer $TOKEN" | jq
watch -n 5 "curl -s $API/migrations/$MIG_ID -H 'Authorization: Bearer $TOKEN' | jq '{status,progress,items:[.items[]|{export_path,status,error_message}]}'"
```
