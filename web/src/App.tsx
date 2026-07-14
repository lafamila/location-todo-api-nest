import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  Account,
  ApiError,
  Geofence,
  Quota,
  Todo,
  actionMessage,
  api,
} from "./api";

type Tab = "todos" | "geofences" | "inbox" | "devices";

export function App() {
  const [account, setAccount] = useState<Account>();
  const [quota, setQuota] = useState<Quota>();
  const [todos, setTodos] = useState<Todo[]>([]);
  const [geofences, setGeofences] = useState<Geofence[]>([]);
  const [deletedTodos, setDeletedTodos] = useState<Todo[]>([]);
  const [deletedGeofences, setDeletedGeofences] = useState<Geofence[]>([]);
  const [tab, setTab] = useState<Tab>("todos");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const hadSession = document.cookie.includes("location_todo_csrf=");
    try {
      const me = await api<{ account: Account }>("/session/me");
      const [nextQuota, nextTodos, nextGeofences, trashTodos, trashGeofences] =
        await Promise.all([
          api<Quota>("/quota"),
          api<{ todos: Todo[] }>("/todos"),
          api<{ geofences: Geofence[] }>("/geofences"),
          api<{ todos: Todo[] }>("/todos?deleted=true"),
          api<{ geofences: Geofence[] }>("/geofences?deleted=true"),
        ]);
      setAccount(me.account);
      setQuota(nextQuota);
      setTodos(nextTodos.todos);
      setGeofences(nextGeofences.geofences);
      setDeletedTodos(trashTodos.todos);
      setDeletedGeofences(trashGeofences.geofences);
      setError("");
    } catch (reason) {
      setAccount(undefined);
      const expectedAnonymous =
        !hadSession &&
        reason instanceof ApiError &&
        ["AUTH_REQUIRED", "SESSION_EXPIRED"].includes(reason.code);
      setError(expectedAnonymous ? "" : actionMessage(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => void reload(), [reload]);

  async function login() {
    try {
      const result = await api<{ authorizeUrl: string }>(
        "/session/oidc/start",
        {
          method: "POST",
          body: JSON.stringify({
            clientKind: "web",
            platform: "web",
            appVersion: "web",
          }),
        },
      );
      location.assign(result.authorizeUrl);
    } catch (reason) {
      setError(actionMessage(reason));
    }
  }

  async function logout() {
    try {
      await api("/session/logout", { method: "POST" });
      location.reload();
    } catch (reason) {
      setError(actionMessage(reason));
    }
  }

  if (loading) return <main className="center-state">Location Todo</main>;
  if (!account) {
    return (
      <main className="login-shell">
        <div>
          <p className="product-mark">L</p>
          <h1>Location Todo</h1>
          <p>시간과 위치 조건을 한 곳에서 관리하세요.</p>
          {error && <p className="error-banner">{error}</p>}
          <button className="primary" onClick={() => void login()}>
            로그인
          </button>
        </div>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <header>
          <div className="brand">
            <span>L</span>
            <strong>todo.</strong>
          </div>
          <div className="account-line">
            <span>{account.displayName}</span>
            <span className="permission">{account.permission}</span>
          </div>
        </header>
        <nav aria-label="관리 화면">
          {(["todos", "geofences", "inbox", "devices"] as Tab[]).map((item) => (
            <button
              key={item}
              className={tab === item ? "active" : ""}
              onClick={() => {
                setTab(item);
                window.scrollTo({ top: 0 });
              }}
            >
              <span className="nav-icon" aria-hidden="true">
                {
                  {
                    todos: "✓",
                    geofences: "⌖",
                    inbox: "□",
                    devices: "⚙",
                  }[item]
                }
              </span>
              {
                {
                  todos: "TODO",
                  geofences: "저장 위치",
                  inbox: "알림함",
                  devices: "기기",
                }[item]
              }
            </button>
          ))}
        </nav>
        <button className="sidebar-logout quiet" onClick={() => void logout()}>
          로그아웃
        </button>
      </aside>
      <div className="app-workspace">
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        {quota && (
          <QuotaStrip quota={quota} onError={setError} onReload={reload} />
        )}
        <main>
          {tab === "todos" && (
            <TodoPanel
              todos={todos}
              deleted={deletedTodos}
              geofences={geofences}
              onReload={reload}
              onError={(reason) => setError(actionMessage(reason))}
            />
          )}
          {tab === "geofences" && (
            <GeofencePanel
              geofences={geofences}
              deleted={deletedGeofences}
              onReload={reload}
              onError={(reason) => setError(actionMessage(reason))}
            />
          )}
          {tab === "inbox" && (
            <InboxPanel onError={(reason) => setError(actionMessage(reason))} />
          )}
          {tab === "devices" && (
            <DevicePanel
              onError={(reason) => setError(actionMessage(reason))}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function QuotaStrip({
  quota,
  onError,
  onReload,
}: {
  quota: Quota;
  onError: (value: string) => void;
  onReload: () => Promise<void>;
}) {
  const text = (used: number, limit: number | null) =>
    `${used} / ${limit ?? "무제한"}`;
  async function requestUpgrade() {
    try {
      await api("/session/permission-request", {
        method: "POST",
        body: JSON.stringify({
          message: "Location Todo 위치 기능을 사용하고 싶습니다.",
        }),
      });
    } catch (reason) {
      onError(actionMessage(reason));
    } finally {
      await onReload().catch((reason) => onError(actionMessage(reason)));
    }
  }
  return (
    <section className="quota-strip" aria-label="사용량">
      <span>
        위치 TODO{" "}
        <strong>
          {text(quota.locationTodos.used, quota.locationTodos.limit)}
        </strong>
      </span>
      <span>
        시간 TODO{" "}
        <strong>{text(quota.timeTodos.used, quota.timeTodos.limit)}</strong>
      </span>
      <span>
        저장 위치{" "}
        <strong>
          {text(quota.savedGeofences.used, quota.savedGeofences.limit)}
        </strong>
      </span>
      {quota.upgradeStatus === "available" && (
        <button onClick={() => void requestUpgrade()}>권한 요청</button>
      )}
      {quota.upgradeStatus === "pending" && (
        <span className="status-pending">권한 검토 중</span>
      )}
      {quota.upgradeStatus === "approved" && (
        <span className="status-approved">권한 승인됨</span>
      )}
      {quota.upgradeStatus === "rejected" && (
        <span className="status-rejected">권한 요청 거절됨</span>
      )}
      {quota.upgradeStatus === "rejected" && (
        <button onClick={() => void requestUpgrade()}>다시 요청</button>
      )}
    </section>
  );
}

function TodoPanel({
  todos,
  deleted,
  geofences,
  onReload,
  onError,
}: {
  todos: Todo[];
  deleted: Todo[];
  geofences: Geofence[];
  onReload: () => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [editing, setEditing] = useState<Todo>();
  const [showForm, setShowForm] = useState(false);
  async function command(path: string, body: object, method = "POST") {
    try {
      await api(path, { method, body: JSON.stringify(body) });
      await onReload();
    } catch (error) {
      onError(error);
    }
  }
  return (
    <section>
      <div className="section-heading">
        <div>
          <p className="eyebrow">CONTEXTUAL REMINDERS</p>
          <h1>알림</h1>
          <p>시간 또는 위치 조건별 활성 상태를 관리합니다.</p>
        </div>
        <button
          className="primary"
          onClick={() => {
            setEditing(undefined);
            setShowForm(true);
          }}
        >
          새 TODO
        </button>
      </div>
      {showForm && (
        <TodoForm
          todo={editing}
          geofences={geofences}
          onClose={() => setShowForm(false)}
          onSaved={async () => {
            setShowForm(false);
            await onReload();
          }}
          onError={onError}
        />
      )}
      <div className="todo-grid">
        {todos.map((todo) => (
          <article className="todo-card" key={todo.id}>
            <button
              className={`todo-status ${todo.active ? "active" : ""}`}
              aria-label={todo.active ? "활성 TODO" : "비활성 TODO"}
              onClick={() =>
                void command(`/todos/${todo.id}/active`, {
                  active: !todo.active,
                  version: todo.version,
                })
              }
            >
              {todo.active ? "✓" : ""}
            </button>
            <div className="todo-content">
              <div className="todo-title-row">
                <h2>{todo.content}</h2>
                <span className={`state state-${todo.active ? "on" : "off"}`}>
                  {todo.lifecycleStatus}
                </span>
              </div>
              <div className="todo-meta">
                <span>{todo.geofenceIds.length === 0 ? "시간" : "위치"}</span>
                <span>{todo.recurrence.type}</span>
                <span>
                  {todo.nextOccurrenceAt
                    ? new Date(todo.nextOccurrenceAt).toLocaleString()
                    : (todo.triggerCondition?.type ?? "-")}
                </span>
              </div>
              {todo.geofenceIds.length > 0 && (
                <p className="todo-places">
                  {todo.geofenceIds
                    .map((id) => geofences.find((g) => g.id === id)?.name)
                    .filter(Boolean)
                    .join(" OR ")}
                </p>
              )}
              <div className="row-actions">
                <button
                  onClick={() => {
                    setEditing(todo);
                    setShowForm(true);
                  }}
                >
                  편집
                </button>
                {["COMPLETED", "TRIGGERED"].includes(todo.lifecycleStatus) ? (
                  <button
                    onClick={() =>
                      void command(`/todos/${todo.id}/reactivate`, {
                        version: todo.version,
                      })
                    }
                  >
                    재활성화
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() =>
                        void command(`/todos/${todo.id}/active`, {
                          active: !todo.active,
                          version: todo.version,
                        })
                      }
                    >
                      {todo.active ? "비활성" : "활성"}
                    </button>
                    <button
                      onClick={() =>
                        void command(`/todos/${todo.id}/complete`, {
                          version: todo.version,
                        })
                      }
                    >
                      완료
                    </button>
                  </>
                )}
                <button
                  className="danger"
                  onClick={() =>
                    void command(
                      `/todos/${todo.id}`,
                      { version: todo.version },
                      "DELETE",
                    )
                  }
                >
                  삭제
                </button>
              </div>
            </div>
          </article>
        ))}
        {!todos.length && <Empty text="등록된 TODO가 없습니다." />}
      </div>
      {!!deleted.length && (
        <details>
          <summary>휴지통 ({deleted.length})</summary>
          <div className="trash-list">
            {deleted.map((todo) => (
              <div key={todo.id}>
                <span>{todo.content}</span>
                <button
                  onClick={() =>
                    void command(`/todos/${todo.id}/restore`, {
                      version: todo.version,
                    })
                  }
                >
                  복원
                </button>
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

function TodoForm({
  todo,
  geofences,
  onClose,
  onSaved,
  onError,
}: {
  todo?: Todo;
  geofences: Geofence[];
  onClose: () => void;
  onSaved: () => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [startDate, setStartDate] = useState(
    todo?.recurrence.startDate ?? localDateInSeoul(new Date()),
  );
  const [recurrence, setRecurrence] = useState(todo?.recurrence.type ?? "ONCE");
  const [trigger, setTrigger] = useState(
    todo?.triggerCondition?.type ?? "ENTRY_IMMEDIATE",
  );
  const [selected, setSelected] = useState<string[]>(todo?.geofenceIds ?? []);
  const isLocation = selected.length > 0;
  const [windows, setWindows] = useState<
    Array<{ date: string; startTime: string; endTime: string }>
  >(
    (todo?.scheduleWindows ?? []).map((window) => ({
      date: window.date ?? "",
      startTime: window.startTime,
      endTime: window.endTime,
    })),
  );
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const recurrenceValue: Record<string, unknown> = {
      type: recurrence,
      startDate: data.get("startDate"),
    };
    if (recurrence === "WEEKLY")
      recurrenceValue.weekdays = data.getAll("weekdays").map(Number);
    if (recurrence === "MONTHLY")
      recurrenceValue.monthDays = String(data.get("monthDays"))
        .split(",")
        .map(Number);
    const payload: Record<string, unknown> = {
      content: data.get("content"),
      recurrence: recurrenceValue,
      geofenceIds: selected,
    };
    if (!isLocation) payload.localTime = data.get("localTime");
    else {
      payload.geofenceIds = selected;
      payload.triggerCondition =
        trigger === "ENTRY_IMMEDIATE"
          ? { type: trigger }
          : trigger === "ENTRY_DELAYED"
            ? { type: trigger, delayMinutes: Number(data.get("minutes")) }
            : { type: trigger, dwellMinutes: Number(data.get("minutes")) };
      payload.scheduleWindows = windows
        .filter((window) => window.startTime && window.endTime)
        .map((window) => ({
          startTime: window.startTime,
          endTime: window.endTime,
          ...(recurrence === "ONCE" && window.date
            ? { date: window.date }
            : {}),
        }));
    }
    if (todo) payload.version = todo.version;
    try {
      await api(todo ? `/todos/${todo.id}` : "/todos", {
        method: todo ? "PATCH" : "POST",
        body: JSON.stringify(payload),
      });
      await onSaved();
    } catch (error) {
      onError(error);
    }
  }
  return (
    <div className="editor-band">
      <form onSubmit={(event) => void submit(event)}>
        <div className="editor-head">
          <h2>{todo ? "TODO 편집" : "새 TODO"}</h2>
          <button type="button" className="quiet" onClick={onClose}>
            닫기
          </button>
        </div>
        <label>
          내용
          <input
            name="content"
            defaultValue={todo?.content}
            maxLength={500}
            required
          />
        </label>
        <label>
          시작일
          <input
            type="date"
            name="startDate"
            value={startDate}
            onChange={(event) => setStartDate(event.target.value)}
            required
          />
        </label>
        <label>
          반복
          <select
            value={recurrence}
            onChange={(event) => setRecurrence(event.target.value)}
          >
            <option>ONCE</option>
            <option>DAILY</option>
            <option>WEEKLY</option>
            <option>MONTHLY</option>
          </select>
        </label>
        {recurrence === "WEEKLY" && (
          <fieldset>
            <legend>요일</legend>
            <div className="check-row">
              {["월", "화", "수", "목", "금", "토", "일"].map((day, index) => (
                <label key={day}>
                  <input
                    type="checkbox"
                    name="weekdays"
                    value={index + 1}
                    defaultChecked={todo?.recurrence.weekdays?.includes(
                      index + 1,
                    )}
                  />
                  {day}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {recurrence === "MONTHLY" && (
          <label>
            날짜
            <input
              name="monthDays"
              defaultValue={todo?.recurrence.monthDays?.join(",") ?? "1"}
              placeholder="1,15,31"
              required
            />
          </label>
        )}
        <fieldset>
          <legend>저장 위치 (선택)</legend>
          <p className="field-note">
            선택하지 않으면 시간 알림으로 등록됩니다. 여러 위치는 OR 조건입니다.
          </p>
          <div className="check-column">
            {geofences.map((geofence) => (
              <label key={geofence.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(geofence.id)}
                  onChange={() =>
                    setSelected((current) =>
                      current.includes(geofence.id)
                        ? current.filter((id) => id !== geofence.id)
                        : [...current, geofence.id],
                    )
                  }
                />
                {geofence.name}
                <small>{geofence.address}</small>
              </label>
            ))}
          </div>
        </fieldset>
        {!isLocation ? (
          <label>
            알림 시각
            <input
              type="time"
              name="localTime"
              defaultValue={todo?.localTime ?? "09:00"}
              required
            />
          </label>
        ) : (
          <>
            <label>
              조건
              <select
                value={trigger}
                onChange={(event) => setTrigger(event.target.value)}
              >
                <option>ENTRY_IMMEDIATE</option>
                <option>ENTRY_DELAYED</option>
                <option>DWELL</option>
              </select>
            </label>
            {trigger !== "ENTRY_IMMEDIATE" && (
              <label>
                분
                <input
                  type="number"
                  name="minutes"
                  min="1"
                  max="1440"
                  defaultValue={
                    todo?.triggerCondition?.delayMinutes ??
                    todo?.triggerCondition?.dwellMinutes ??
                    10
                  }
                  required
                />
              </label>
            )}
            <fieldset>
              <legend>허용 시간 (선택)</legend>
              <div className="window-list">
                {windows.map((window, index) => (
                  <div className="window-row" key={index}>
                    {recurrence === "ONCE" && (
                      <label>
                        날짜
                        <input
                          type="date"
                          value={window.date}
                          onChange={(event) =>
                            setWindows((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, date: event.target.value }
                                  : item,
                              ),
                            )
                          }
                        />
                      </label>
                    )}
                    <label>
                      시작
                      <input
                        type="time"
                        value={window.startTime}
                        onChange={(event) =>
                          setWindows((current) =>
                            current.map((item, itemIndex) =>
                              itemIndex === index
                                ? { ...item, startTime: event.target.value }
                                : item,
                            ),
                          )
                        }
                        required
                      />
                    </label>
                    <label>
                      종료
                      <input
                        type="text"
                        inputMode="numeric"
                        pattern="(?:[01]\\d|2[0-3]):[0-5]\\d|24:00"
                        placeholder="18:00 또는 24:00"
                        value={window.endTime}
                        onChange={(event) =>
                          setWindows((current) =>
                            current.map((item, itemIndex) =>
                              itemIndex === index
                                ? { ...item, endTime: event.target.value }
                                : item,
                            ),
                          )
                        }
                        required
                      />
                    </label>
                    <button
                      type="button"
                      className="danger"
                      aria-label="허용 시간 삭제"
                      onClick={() =>
                        setWindows((current) =>
                          current.filter((_, itemIndex) => itemIndex !== index),
                        )
                      }
                    >
                      삭제
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    setWindows((current) => [
                      ...current,
                      { date: "", startTime: "09:00", endTime: "18:00" },
                    ])
                  }
                >
                  시간 추가
                </button>
              </div>
            </fieldset>
          </>
        )}
        <div className="form-actions">
          <button type="button" onClick={onClose}>
            취소
          </button>
          <button className="primary" type="submit">
            저장
          </button>
        </div>
      </form>
    </div>
  );
}

function localDateInSeoul(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${value.year}-${value.month}-${value.day}`;
}

function GeofencePanel({
  geofences,
  deleted,
  onReload,
  onError,
}: {
  geofences: Geofence[];
  deleted: Geofence[];
  onReload: () => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [show, setShow] = useState(false);
  const [editing, setEditing] = useState<Geofence>();
  async function command(path: string, body: object, method = "POST") {
    try {
      await api(path, { method, body: JSON.stringify(body) });
      await onReload();
    } catch (error) {
      onError(error);
    }
  }
  return (
    <section>
      <div className="section-heading">
        <div>
          <p className="eyebrow">SAVED GEOFENCES</p>
          <h1>저장 위치</h1>
          <p>모바일 감지에 사용할 반경을 관리합니다.</p>
        </div>
        <button
          className="primary"
          onClick={() => {
            setEditing(undefined);
            setShow(true);
          }}
        >
          새 위치
        </button>
      </div>
      {show && (
        <GeofenceForm
          geofence={editing}
          onClose={() => setShow(false)}
          onSaved={async () => {
            setShow(false);
            await onReload();
          }}
          onError={onError}
        />
      )}
      <div className="location-grid">
        {geofences.map((geofence) => (
          <article key={geofence.id}>
            <div className="location-dot" />
            <div>
              <h2>{geofence.name}</h2>
              <p>{geofence.address}</p>
              <small>
                {geofence.radiusMeters}m · {geofence.latitude.toFixed(5)},{" "}
                {geofence.longitude.toFixed(5)}
              </small>
            </div>
            <div className="row-actions">
              <button
                onClick={() => {
                  setEditing(geofence);
                  setShow(true);
                }}
              >
                편집
              </button>
              <button
                className="danger"
                onClick={() =>
                  void command(
                    `/geofences/${geofence.id}`,
                    { version: geofence.version },
                    "DELETE",
                  )
                }
              >
                삭제
              </button>
            </div>
          </article>
        ))}
      </div>
      {!geofences.length && <Empty text="저장된 위치가 없습니다." />}
      {!!deleted.length && (
        <details>
          <summary>휴지통 ({deleted.length})</summary>
          <div className="trash-list">
            {deleted.map((geofence) => (
              <div key={geofence.id}>
                <span>{geofence.name}</span>
                <button
                  onClick={() =>
                    void command(`/geofences/${geofence.id}/restore`, {
                      version: geofence.version,
                    })
                  }
                >
                  복원
                </button>
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

function GeofenceForm({
  geofence,
  onClose,
  onSaved,
  onError,
}: {
  geofence?: Geofence;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [draft, setDraft] = useState({
    name: geofence?.name ?? "",
    address: geofence?.address ?? "",
    latitude: geofence?.latitude ?? 37.5665,
    longitude: geofence?.longitude ?? 126.978,
    radiusMeters: geofence?.radiusMeters ?? 200,
    placeMetadata: geofence?.placeMetadata ?? null,
  });
  const [pickerPending, setPickerPending] = useState(false);

  async function openMapPicker() {
    const popup = window.open("about:blank", "location-todo-map-picker");
    if (!popup) {
      onError(new Error("Map picker popup was blocked"));
      return;
    }
    const draftNonce = crypto.randomUUID();
    setPickerPending(true);
    try {
      const handoff = await api<{ handoffId: string; url: string }>(
        "/kakao/map-handoffs",
        {
          method: "POST",
          body: JSON.stringify({
            draft: { ...draft, version: geofence?.version, draftNonce },
          }),
        },
      );
      const receive = (event: MessageEvent) => {
        const result = event.data as Record<string, unknown>;
        if (
          event.origin !== location.origin ||
          result.type !== "LOCATION_TODO_MAP_RESULT" ||
          result.handoffId !== handoff.handoffId ||
          result.draftNonce !== draftNonce
        ) {
          return;
        }
        window.removeEventListener("message", receive);
        clearTimeout(expiry);
        setPickerPending(false);
        setDraft({
          name: String(result.name ?? draft.name),
          address: String(result.address),
          latitude: Number(result.latitude),
          longitude: Number(result.longitude),
          radiusMeters: Number(result.radiusMeters),
          placeMetadata:
            (result.placeMetadata as Record<string, unknown> | null) ?? null,
        });
      };
      const expiry = window.setTimeout(() => {
        window.removeEventListener("message", receive);
        setPickerPending(false);
      }, 5 * 60_000);
      window.addEventListener("message", receive);
      popup.location.href = handoff.url;
    } catch (error) {
      popup.close();
      setPickerPending(false);
      onError(error);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload = {
      ...draft,
      ...(geofence ? { version: geofence.version } : {}),
    };
    try {
      await api(geofence ? `/geofences/${geofence.id}` : "/geofences", {
        method: geofence ? "PATCH" : "POST",
        body: JSON.stringify(payload),
      });
      await onSaved();
    } catch (error) {
      onError(error);
    }
  }
  return (
    <div className="editor-band">
      <form onSubmit={(event) => void submit(event)}>
        <div className="editor-head">
          <h2>{geofence ? "위치 편집" : "새 위치"}</h2>
          <button type="button" className="quiet" onClick={onClose}>
            닫기
          </button>
        </div>
        <label>
          이름
          <input
            value={draft.name}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                name: event.target.value,
              }))
            }
            maxLength={100}
            required
          />
        </label>
        <label>
          주소
          <input value={draft.address} readOnly maxLength={300} required />
        </label>
        <button
          type="button"
          onClick={() => void openMapPicker()}
          disabled={pickerPending}
        >
          {pickerPending ? "지도 선택 대기 중" : "Kakao 지도에서 선택"}
        </button>
        <div className="field-grid">
          <label>
            위도
            <input type="number" value={draft.latitude} readOnly required />
          </label>
          <label>
            경도
            <input type="number" value={draft.longitude} readOnly required />
          </label>
          <label>
            반경(m)
            <input
              type="number"
              min="100"
              max="5000"
              value={draft.radiusMeters}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  radiusMeters: Number(event.target.value),
                }))
              }
              required
            />
          </label>
        </div>
        <div className="form-actions">
          <button type="button" onClick={onClose}>
            취소
          </button>
          <button className="primary">저장</button>
        </div>
      </form>
    </div>
  );
}

function InboxPanel({ onError }: { onError: (error: unknown) => void }) {
  const [items, setItems] = useState<Array<Record<string, unknown>>>([]);
  const [cursor, setCursor] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const load = useCallback(
    async (after: number, replace: boolean) => {
      try {
        const value = await api<{
          notifications: Array<Record<string, unknown>>;
          nextCursor: number;
        }>(`/notifications/inbox?after=${after}&limit=50`);
        setItems((current) =>
          replace ? value.notifications : [...current, ...value.notifications],
        );
        setCursor(value.nextCursor);
        setHasMore(value.notifications.length === 50);
      } catch (error) {
        onError(error);
      }
    },
    [onError],
  );
  useEffect(() => void load(0, true), [load]);
  async function acknowledge(eventIds: string[]) {
    if (!eventIds.length) return;
    try {
      await api("/notifications/inbox/ack", {
        method: "POST",
        body: JSON.stringify({ eventIds }),
      });
      const acknowledged = new Set(eventIds);
      setItems((current) =>
        current.map((item) =>
          acknowledged.has(String(item.eventId))
            ? { ...item, acknowledgedAt: new Date().toISOString() }
            : item,
        ),
      );
    } catch (error) {
      onError(error);
    }
  }
  const unreadIds = items
    .filter((item) => !item.acknowledgedAt)
    .map((item) => String(item.eventId));
  return (
    <section>
      <div className="section-heading">
        <div>
          <h1>알림함</h1>
          <p>기기 연결이 끊긴 동안의 알림도 여기에 보관됩니다.</p>
        </div>
        <div className="row-actions">
          {!!unreadIds.length && (
            <button onClick={() => void acknowledge(unreadIds)}>
              모두 읽음
            </button>
          )}
          <button onClick={() => void load(0, true)}>새로고침</button>
        </div>
      </div>
      <div className="inbox-list">
        {items.map((item) => (
          <article key={String(item.eventId)}>
            <time>{new Date(String(item.triggeredAt)).toLocaleString()}</time>
            <strong>{String(item.content)}</strong>
            <span>{String(item.occurrenceKey)}</span>
            {item.acknowledgedAt ? (
              <span className="status-read">읽음</span>
            ) : (
              <button onClick={() => void acknowledge([String(item.eventId)])}>
                읽음
              </button>
            )}
          </article>
        ))}
      </div>
      {!items.length && <Empty text="수신한 알림이 없습니다." />}
      {hasMore && (
        <div className="load-more">
          <button onClick={() => void load(cursor, false)}>더 보기</button>
        </div>
      )}
    </section>
  );
}

function DevicePanel({ onError }: { onError: (error: unknown) => void }) {
  const [devices, setDevices] = useState<Array<Record<string, unknown>>>([]);
  const load = useCallback(async () => {
    try {
      setDevices(await api("/devices"));
    } catch (error) {
      onError(error);
    }
  }, [onError]);
  useEffect(() => void load(), [load]);
  return (
    <section>
      <div className="section-heading">
        <div>
          <h1>기기와 세션</h1>
          <p>푸시 및 실시간 수신 엔드포인트를 확인합니다.</p>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>플랫폼</th>
              <th>앱 버전</th>
              <th>마지막 연결</th>
              <th>푸시</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {devices.map((device) => (
              <tr key={String(device.id)}>
                <td>{String(device.platform)}</td>
                <td>{String(device.appVersion)}</td>
                <td>{new Date(String(device.lastSeenAt)).toLocaleString()}</td>
                <td>{device.pushTokenRegistered ? "등록" : "-"}</td>
                <td>
                  <button
                    className="danger"
                    disabled={!device.active}
                    onClick={() =>
                      void api(`/devices/${String(device.id)}`, {
                        method: "DELETE",
                      })
                        .then(load)
                        .catch(onError)
                    }
                  >
                    {device.active ? "해제" : "해제됨"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="empty">{text}</p>;
}
