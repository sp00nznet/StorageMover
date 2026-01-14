# API Reference

Complete REST API documentation for StorageMover.

## Base URL

```
http://localhost:3001/api
```

## Authentication

All endpoints (except `/auth/*`) require a Bearer token:

```
Authorization: Bearer <token>
```

---

## Auth Endpoints

### Register User

```http
POST /auth/register
```

**Body:**
```json
{
  "username": "admin",
  "password": "password123"
}
```

**Response:**
```json
{
  "message": "User registered successfully",
  "token": "eyJhbG...",
  "user": {
    "id": "uuid",
    "username": "admin",
    "role": "user"
  }
}
```

### Login

```http
POST /auth/login
```

**Body:**
```json
{
  "username": "admin",
  "password": "password123"
}
```

**Response:**
```json
{
  "token": "eyJhbG...",
  "user": {
    "id": "uuid",
    "username": "admin",
    "role": "user"
  }
}
```

### Verify Token

```http
GET /auth/verify
```

**Response:**
```json
{
  "valid": true,
  "user": {
    "id": "uuid",
    "username": "admin",
    "role": "user"
  }
}
```

---

## Device Endpoints

### List Devices

```http
GET /devices
```

**Response:**
```json
[
  {
    "id": "uuid",
    "name": "Production Isilon",
    "type": "isilon",
    "hostname": "192.168.1.100",
    "port": 8080,
    "username": "admin",
    "status": "connected",
    "last_connected": "2024-01-15T10:30:00Z"
  }
]
```

### Add Device

```http
POST /devices
```

**Body:**
```json
{
  "name": "Production Isilon",
  "type": "isilon",
  "hostname": "192.168.1.100",
  "port": 8080,
  "username": "admin",
  "password": "secret"
}
```

**Device Types:** `isilon`, `powerscale`, `powerstore`

### Get Device

```http
GET /devices/:id
```

### Update Device

```http
PUT /devices/:id
```

**Body:**
```json
{
  "name": "Updated Name",
  "hostname": "192.168.1.101",
  "password": "newpassword"
}
```

### Delete Device

```http
DELETE /devices/:id
```

### Test Connection

```http
POST /devices/:id/test
```

**Response:**
```json
{
  "success": true,
  "message": "Connection successful"
}
```

### Discover Exports

```http
POST /devices/:id/discover
```

**Response:**
```json
{
  "exports": [...],
  "count": 15
}
```

---

## Export Endpoints

### List Exports

```http
GET /exports
GET /exports?deviceId=uuid
```

**Response:**
```json
[
  {
    "id": "uuid",
    "device_id": "uuid",
    "device_name": "Production Isilon",
    "export_path": "/ifs/data/share1",
    "export_type": "nfs",
    "clients": ["*"],
    "permissions": "root_squash",
    "size_bytes": 1073741824
  }
]
```

### Get Export

```http
GET /exports/:id
```

### Delete Export

```http
DELETE /exports/:id
```

### Export Statistics

```http
GET /exports/stats/summary
```

**Response:**
```json
{
  "total": 25,
  "nfs": 15,
  "smb": 8,
  "both": 2,
  "total_size": 5368709120
}
```

---

## Migration Endpoints

### List Migrations

```http
GET /migrations
```

**Response:**
```json
[
  {
    "id": "uuid",
    "name": "Q1 Migration",
    "source_device_name": "Old Isilon",
    "target_device_name": "New PowerScale",
    "status": "running",
    "progress": 45,
    "bytes_transferred": 536870912,
    "total_bytes": 1073741824,
    "files_transferred": 100,
    "total_files": 250
  }
]
```

### Create Migration

```http
POST /migrations
```

**Body:**
```json
{
  "name": "Q1 Migration",
  "sourceDeviceId": "uuid",
  "targetDeviceId": "uuid",
  "exportIds": ["uuid1", "uuid2"],
  "targetBasePath": "/ifs/migrated"
}
```

### Get Migration

```http
GET /migrations/:id
```

### Start Migration

```http
POST /migrations/:id/start
```

### Pause Migration

```http
POST /migrations/:id/pause
```

### Cancel Migration

```http
POST /migrations/:id/cancel
```

### Delete Migration

```http
DELETE /migrations/:id
```

---

## Configuration Endpoints

### Generate PowerScale Config

```http
POST /config/powerscale/generate
```

**Body:**
```json
{
  "targetDeviceId": "uuid",
  "sourceDeviceId": "uuid",
  "exportIds": ["uuid1", "uuid2"],
  "targetBasePath": "/ifs/migrated",
  "nfsSettings": {
    "rootSquash": true,
    "accessZone": "System"
  },
  "smbSettings": {
    "allowGuest": false,
    "accessZone": "System"
  }
}
```

### Apply PowerScale Config

```http
POST /config/powerscale/apply
```

### Export PowerStore Config

```http
POST /config/powerstore/export
```

**Body:**
```json
{
  "deviceId": "uuid"
}
```

### Import PowerStore Config

```http
POST /config/powerstore/import
```

### List Saved Configs

```http
GET /config/saved
GET /config/saved?deviceId=uuid
```

### Download Config

```http
GET /config/download/:id
```

---

## WebSocket

Connect to `/ws` for real-time updates.

**Message Types:**
- `migration_started`
- `migration_progress`
- `migration_paused`
- `migration_completed`
- `migration_failed`
- `transfer_progress`

**Example Message:**
```json
{
  "type": "migration_progress",
  "migrationId": "uuid",
  "progress": 45,
  "bytesTransferred": 536870912,
  "filesTransferred": 100,
  "timestamp": "2024-01-15T10:30:00Z"
}
```

---

## Error Responses

All errors follow this format:

```json
{
  "error": "Error message here"
}
```

**Common Status Codes:**
- `400` - Bad Request
- `401` - Unauthorized
- `404` - Not Found
- `409` - Conflict
- `500` - Internal Server Error
