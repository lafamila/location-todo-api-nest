import { FormEvent, useEffect, useRef, useState } from "react";
import { actionMessage, api } from "./api";

declare global {
  interface Window {
    kakao?: any;
  }
}

interface Pick {
  latitude: number;
  longitude: number;
  radiusMeters: number;
  name: string;
  address: string;
  placeMetadata?: Record<string, unknown>;
}

export function MapPicker() {
  const handoff =
    new URLSearchParams(location.search).get("handoffId") ||
    new URLSearchParams(location.search).get("handoff") ||
    "";
  const mapElement = useRef<HTMLDivElement>(null);
  const mapObjects = useRef<{ map: any; marker: any; circle: any } | undefined>(
    undefined,
  );
  const initialPick: Pick = {
    latitude: 37.5665,
    longitude: 126.978,
    radiusMeters: 200,
    name: "",
    address: "",
  };
  const pickRef = useRef<Pick>(initialPick);
  const [pick, setPick] = useState<Pick>(initialPick);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    void api<{ initial: Partial<Pick>; kakaoJavascriptKey: string | null }>(
      `/kakao/map-handoffs/${handoff}`,
    )
      .then(async (value) => {
        const resolved = { ...pickRef.current, ...value.initial };
        pickRef.current = resolved;
        setPick(resolved);
        if (!value.kakaoJavascriptKey)
          throw new Error("Kakao map key is unavailable");
        await loadSdk(value.kakaoJavascriptKey);
        initMap(resolved);
      })
      .catch((reason) => setError(actionMessage(reason)));
  }, [handoff]);

  useEffect(() => {
    pickRef.current = pick;
    const objects = mapObjects.current;
    if (!objects || !window.kakao) return;
    const point = new window.kakao.maps.LatLng(pick.latitude, pick.longitude);
    objects.marker.setPosition(point);
    objects.circle.setPosition(point);
    objects.circle.setRadius(pick.radiusMeters);
  }, [pick.latitude, pick.longitude, pick.radiusMeters]);

  function initMap(resolved: Pick) {
    if (!mapElement.current || !window.kakao) return;
    const center = new window.kakao.maps.LatLng(
      resolved.latitude,
      resolved.longitude,
    );
    const map = new window.kakao.maps.Map(mapElement.current, {
      center,
      level: 4,
    });
    const marker = new window.kakao.maps.Marker({
      map,
      position: center,
      draggable: true,
    });
    const circle = new window.kakao.maps.Circle({
      map,
      center: center,
      radius: resolved.radiusMeters,
      strokeWeight: 2,
      strokeColor: "#087f5b",
      strokeOpacity: 0.9,
      fillColor: "#63e6be",
      fillOpacity: 0.25,
    });
    window.kakao.maps.event.addListener(marker, "dragend", () => {
      const point = marker.getPosition();
      setPick((current) => ({
        ...current,
        latitude: point.getLat(),
        longitude: point.getLng(),
      }));
    });
    mapObjects.current = { map, marker, circle };
  }

  async function search(event: FormEvent) {
    event.preventDefault();
    try {
      const value = await api<{ documents: any[] }>(
        `/kakao/map-handoffs/${handoff}/search?type=keyword&q=${encodeURIComponent(query)}`,
      );
      setResults(value.documents);
    } catch (reason) {
      setError(actionMessage(reason));
    }
  }
  function select(result: any) {
    const next = {
      latitude: Number(result.y),
      longitude: Number(result.x),
      name: result.place_name || result.address_name,
      address: result.road_address_name || result.address_name,
      placeMetadata: { id: result.id, categoryName: result.category_name },
    };
    setPick((current) => ({ ...current, ...next }));
    const point = new window.kakao.maps.LatLng(next.latitude, next.longitude);
    mapObjects.current?.map.panTo(point);
    setResults([]);
  }
  async function submit() {
    try {
      const result = await api<Record<string, unknown>>(
        `/kakao/map-handoffs/${handoff}/result`,
        { method: "POST", body: JSON.stringify(pick) },
      );
      if (window.opener) {
        window.opener.postMessage(result, location.origin);
        window.close();
        return;
      }
      const encoded = encodeURIComponent(JSON.stringify(result));
      location.href = `loc://map/complete?result=${encoded}`;
    } catch (reason) {
      setError(actionMessage(reason));
    }
  }

  return (
    <main className="map-picker">
      <aside>
        <h1>위치 선택</h1>
        <form className="search-row" onSubmit={(event) => void search(event)}>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="주소 또는 장소"
            required
          />
          <button>검색</button>
        </form>
        {error && <p className="error-banner">{error}</p>}
        <div className="search-results">
          {results.map((result) => (
            <button key={result.id} onClick={() => select(result)}>
              <strong>{result.place_name}</strong>
              <span>{result.road_address_name || result.address_name}</span>
            </button>
          ))}
        </div>
        <label>
          이름
          <input
            value={pick.name}
            maxLength={100}
            onChange={(event) => setPick({ ...pick, name: event.target.value })}
          />
        </label>
        <label>
          주소
          <input
            value={pick.address}
            maxLength={300}
            onChange={(event) =>
              setPick({ ...pick, address: event.target.value })
            }
          />
        </label>
        <label>
          반경 <output>{pick.radiusMeters}m</output>
          <input
            type="range"
            min="100"
            max="5000"
            step="50"
            value={pick.radiusMeters}
            onChange={(event) =>
              setPick({ ...pick, radiusMeters: Number(event.target.value) })
            }
          />
          <input
            type="number"
            min="100"
            max="5000"
            value={pick.radiusMeters}
            onChange={(event) =>
              setPick({ ...pick, radiusMeters: Number(event.target.value) })
            }
          />
        </label>
        <button
          className="primary map-confirm"
          disabled={!pick.name || !pick.address}
          onClick={() => void submit()}
        >
          이 위치 사용
        </button>
      </aside>
      <div ref={mapElement} className="map-canvas" aria-label="Kakao 지도" />
    </main>
  );
}

function loadSdk(key: string): Promise<void> {
  if (window.kakao?.maps) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&autoload=false&libraries=services`;
    script.onload = () => window.kakao.maps.load(resolve);
    script.onerror = () => reject(new Error("Kakao map SDK failed"));
    document.head.append(script);
  });
}
