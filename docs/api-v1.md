# Location Todo API v1

All paths are under `/api`. Browser mutations require the HttpOnly session cookie plus `X-CSRF-Token`; native requests use `X-Location-Todo-Session`. UUIDs are lowercase-compatible RFC 4122 strings and timestamps are RFC 3339 UTC instants.

## Session And Device

- `POST /session/oidc/start`: `SessionStartRequest` -> `{authorizeUrl,loginTransactionId,expiresAt}`. Web starts also set a short-lived HttpOnly browser-binding cookie; the callback will not issue a service session without the matching cookie.
- `GET /session/oidc/callback`: single-winner confidential PKCE callback. Native `loc://` contains only `transaction` and result fields.
- `POST /session/oidc/complete`: `{loginTransactionId,installationId}` -> `{sessionToken,expiresAt,account:{id,displayName,email?,permission}}`. It is installation-bound and one-time.
- `GET /session/me`: extends idle activity; absolute lifetime stays 180 days.
- `POST /devices/register`: `{installationId,platform,appVersion,metadata?,pushToken?}`. `metadata` is accepted for forward compatibility but not persisted; raw push tokens are never returned.
- `POST /session/logout`: deletes only the current device endpoint/session family.
- Browser activity slides both the database idle expiry and session/CSRF cookie expiry, bounded by the absolute session lifetime.
- Permission requests become `pending` after provider acceptance, `rejected` after an immediate permanent provider rejection, and `approved` when refreshed claims grant `user` or `superadmin`. The auth provider exposes no user-scoped application-status polling endpoint, so later admin rejection remains an external boundary until a provider status API exists.

## Quota And Resources

- `GET /quota` -> `QuotaDto`. A quota failure is `409 QUOTA_EXCEEDED` with `details:{resource,permission,used,limit,upgradeStatus}`.
- `GET /geofences` -> `{geofences: SavedGeofenceDto[]}`; `?deleted=true` selects trash.
- `GET /todos` -> `{todos: TodoDto[]}`; `?deleted=true` selects trash.
- Create returns the created DTO. Mutations require `version`; conflict is `409 VERSION_CONFLICT`.
- TODO lifecycle: `POST /todos/:id/active`, `/complete`, `/reactivate`, `/restore`; delete is `DELETE /todos/:id`.
- Geofence delete rejects `GEOFENCE_IN_USE`; restore consumes quota.

The recurrence and trigger discriminated unions are declared in `src/contracts/v1.ts`. TODOs do not expose a `kind` or `timezone` field. An empty `geofenceIds` array means a time reminder and requires `localTime`; one or more IDs mean a location reminder and require one of immediate/delayed/dwell plus optional non-cross-midnight windows. All calendar evaluation uses `Asia/Seoul`.

## Transition And Delivery

- `POST /transitions/batch`: `{events: TransitionEventDto[]}` -> `{acks: TransitionAckDto[]}`. Only active, immutable iOS/Android device sessions may upload. ACK statuses `ACCEPTED`, `DUPLICATE`, and `IGNORED` are terminal for the exact matching `id+sequence`; per-device sequence authority and replay fingerprints survive audit-event retention.
- `GET /notifications/inbox?after=0&limit=50` -> `{notifications: NotificationEnvelopeDto[],nextCursor}`. Each notification includes `acknowledgedAt` (`null` until read) and `createdAt`.
- `POST /notifications/inbox/ack`: `{eventIds: string[]}` -> `{acknowledged:number}`. `eventIds` are the trigger event IDs already present in the shared notification envelope; the private inbox row ID is not part of the client contract. Matching is account-scoped and repeat ACKs are idempotent.
- Socket.IO namespace `/realtime`, handshake auth `{token: sessionToken}`, emits `notification` using the same inbox payload/event ID. Sessions are revalidated before delivery and periodically; PostgreSQL notification fan-out reaches sockets connected to another API replica, while the inbox remains the durable fallback.

## Map Handoff

- `POST /kakao/map-handoffs`: `{draft:{name,address,latitude,longitude,radiusMeters,placeMetadata?,version?,draftNonce}}` -> `{handoffId,url,expiresAt}`.
- `GET /kakao/map-handoffs/:id/search`: hosted picker Kakao proxy; validates handoff expiry and allowed origin without requiring a browser session cookie.
- Hosted result URI: `loc://map/complete?result=<percent-encoded JSON>`.
- Decoded JSON: `{type:'LOCATION_TODO_MAP_RESULT',handoffId,accountId,draftNonce,address,latitude,longitude,radiusMeters,placeMetadata?}`.

The server derives `accountId` and `draftNonce` from the bound, five-minute, one-time handoff row. Clients must reject any mismatch.

## Errors

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "TODO version changed",
    "details": { "currentVersion": 4 }
  }
}
```

Stable codes include `AUTH_REQUIRED`, `SESSION_EXPIRED`, `CSRF_INVALID`, `VALIDATION_ERROR`, `TODO_FIELD_MISMATCH`, `QUOTA_EXCEEDED`, `VERSION_CONFLICT`, `TODO_NOT_FOUND`, `GEOFENCE_NOT_FOUND`, `GEOFENCE_IN_USE`, `HANDOFF_EXPIRED`, `RATE_LIMITED`, and transient `AUTH_UNAVAILABLE`/`KAKAO_UNAVAILABLE`.
